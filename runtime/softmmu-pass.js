// softmmu-pass.js — the software-MMU instrumentation pass (#126 Track A / #128).
//
// Routes EVERY guest wasm load/store through a per-access software page-table
// translate, so a wasm guest kernel can run CONFIG_MMU=y: per-process virtual
// address spaces, COW, demand paging, mprotect — all the things wasm linear
// memory has no hardware fault-on-access for. This is the toolchain half of
// Track A (the WAVEN model; measured viable at ~1.05–1.9× in spikes/softmmu/);
// the kernel half (the arch MMU layer that populates the page tables + handles
// faults) is designed in docs/superpowers/specs/2026-07-01-softmmu-kernel-design.md.
//
// WHY a bytecode rewrite and not binaryen: the repo is hermetic/no-remote-deps
// and already runs its own post-link passes (fpcast-emu, dynsym-inject); this
// joins them as a nix build step.
//
// WHY INLINED, not a helper call (the measured-and-fixed lesson): the first cut
// replaced each access with `call $mmu_load_T` — correct, but a non-inlined call
// per memory op measured ~12× under V8 (spikes/softmmu/measure-real.mjs caught
// it), because V8 does not inline the helper and the spike's ~1.1× assumed an
// INLINED translate. So the pass now emits the translate INLINE at every access,
// using per-function scratch locals — reproducing the spike's model exactly:
//     ea    = va + memarg.offset                        ;; effective address
//     pgd_e = u32[ pt_base + (ea >>> 22) << 2 ]         ;; level 1 (PGD)
//     pte   = u32[ (pgd_e & ~0xfff) + ((ea>>>12 & 0x3ff)<<2) ]  ;; level 2
//     phys  = (pte & ~0xfff) + (ea & 0xfff)             ;; flags masked
//     <raw load/store at phys>                           ;; align 0, offset 0
// `pt_base` is a mutable global the kernel sets on every context switch (the
// current process's page-table root — a physical byte offset into the one shared
// Memory that is "RAM"). An identity page table (pte = page<<12) makes phys==ea,
// which is how the pass is correctness-tested + measured without a live kernel.
// TWO-LEVEL (not the spike's single-level flat): the kernel arch layer uses the
// standard 32-bit split (PGDIR_SHIFT=22, page-sized PTE tables — the generic MM
// assumes them), so the pass walks the same tables the kernel builds. Entry low
// 12 bits are flag bits (present/write/...) and are masked out of the address.
// No software TLB (spikes/softmmu measured a TLB makes it WORSE).
//
// A translate HELPER function is still appended + exported (under exportControls)
// for the kernel's fault handler / introspection + the tests, but the hot path
// never calls it — it is inlined.
//
// WHAT IS EXEMPTED: the emitted page-table load + the appended helper use RAW
// (uninstrumented) access — they ARE the translate. Scalar loads/stores AND
// atomic memory ops (0xfe: load/store/rmw/cmpxchg/notify/wait — the guest's
// musl pthread) are translated; the pass ABORTS LOUDLY on SIMD (0xfd) memory
// ops (a vector translate variant — a documented follow-up) rather than
// silently emitting an untranslated access.

// ---- memory opcodes we translate -------------------------------------------

// opcode -> { k:'load'|'store', n:name }. VALTYPE gives the value type on the
// stack (loads push it, stores consume it) — used to pick the store's scratch.
const MEM_OPS = {
  0x28: { k: "load", n: "i32_load" },
  0x29: { k: "load", n: "i64_load" },
  0x2a: { k: "load", n: "f32_load" },
  0x2b: { k: "load", n: "f64_load" },
  0x2c: { k: "load", n: "i32_load8_s" },
  0x2d: { k: "load", n: "i32_load8_u" },
  0x2e: { k: "load", n: "i32_load16_s" },
  0x2f: { k: "load", n: "i32_load16_u" },
  0x30: { k: "load", n: "i64_load8_s" },
  0x31: { k: "load", n: "i64_load8_u" },
  0x32: { k: "load", n: "i64_load16_s" },
  0x33: { k: "load", n: "i64_load16_u" },
  0x34: { k: "load", n: "i64_load32_s" },
  0x35: { k: "load", n: "i64_load32_u" },
  0x36: { k: "store", n: "i32_store" },
  0x37: { k: "store", n: "i64_store" },
  0x38: { k: "store", n: "f32_store" },
  0x39: { k: "store", n: "f64_store" },
  0x3a: { k: "store", n: "i32_store8" },
  0x3b: { k: "store", n: "i32_store16" },
  0x3c: { k: "store", n: "i64_store8" },
  0x3d: { k: "store", n: "i64_store16" },
  0x3e: { k: "store", n: "i64_store32" },
};
const VALTYPE = {
  i32_store: "i32",
  i64_store: "i64",
  f32_store: "f32",
  f64_store: "f64",
  i32_store8: "i32",
  i32_store16: "i32",
  i64_store8: "i64",
  i64_store16: "i64",
  i64_store32: "i64",
};

const VT = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

// #128 PAGE-CROSSING scalar accesses: a multi-byte load/store whose
// `(ea & 0xfff) + width > 0x1000` spans TWO virtual pages, which map to two
// (generally non-adjacent) physical frames. The single-translate raw access
// (`phys = translate(ea); raw op@phys`) writes/reads the tail bytes past frame
// one's end into the physically-next arena bytes — a DIFFERENT virtual page's
// frame — corrupting/reading foreign memory. (Invisible on NOMMU: no
// translation, memory is flat/contiguous.) These tables drive the split: for
// width>=2 accesses the pass emits a fast within-page path + a byte-wise slow
// path (`__mmu_{load,store}_bytes`) that translates EACH byte's page separately.
const ACCESS_W = {
  0x28: 4,
  0x29: 8,
  0x2a: 4,
  0x2b: 8,
  0x2c: 1,
  0x2d: 1,
  0x2e: 2,
  0x2f: 2,
  0x30: 1,
  0x31: 1,
  0x32: 2,
  0x33: 2,
  0x34: 4,
  0x35: 4,
  0x36: 4,
  0x37: 8,
  0x38: 4,
  0x39: 8,
  0x3a: 1,
  0x3b: 2,
  0x3c: 1,
  0x3d: 2,
  0x3e: 4,
};
// Result value-type of each load op (the `if`/`block` result type on the split).
const LOAD_RESVT = {
  0x28: VT.i32,
  0x29: VT.i64,
  0x2a: VT.f32,
  0x2b: VT.f64,
  0x2c: VT.i32,
  0x2d: VT.i32,
  0x2e: VT.i32,
  0x2f: VT.i32,
  0x30: VT.i64,
  0x31: VT.i64,
  0x32: VT.i64,
  0x33: VT.i64,
  0x34: VT.i64,
  0x35: VT.i64,
};
// Post-process a load's raw little-endian i64 (from __mmu_load_bytes) into the
// op's result type: wrap/reinterpret/sign-extend. Opcodes: 0xa7 i32.wrap_i64,
// 0xbe f32.reinterpret_i32, 0xbf f64.reinterpret_i64, 0xc1 i32.extend16_s,
// 0xc3 i64.extend16_s, 0xc4 i64.extend32_s. (8/16u/32u already zero-extended.)
const LOAD_POST = {
  0x28: [0xa7],
  0x29: [],
  0x2a: [0xa7, 0xbe],
  0x2b: [0xbf],
  0x2e: [0xa7, 0xc1],
  0x2f: [0xa7],
  0x32: [0xc3],
  0x33: [],
  0x34: [0xc4],
  0x35: [],
};
// Convert a store's typed value (already on the stack) to the i64 the byte
// helper stores from (it uses only the low `width` bytes). Opcodes: 0xad
// i64.extend_i32_u, 0xbc i32.reinterpret_f32, 0xbd i64.reinterpret_f64.
const STORE_TOI64 = {
  0x36: [0xad],
  0x37: [],
  0x38: [0xbc, 0xad],
  0x39: [0xbd],
  0x3b: [0xad],
  0x3d: [],
  0x3e: [],
};

// ---- A2: present-checked translate (#128 Track A2) -------------------------
//
// The A1 fast path (above) assumes every PTE is present — correct only under
// a kernel that never demand-pages or COWs. `checked: true` instruments the
// SAME inline walk with a present test after EACH level's load, but the test
// DIFFERS by level to match the kernel's folded 2-level table format: the
// LEVEL-1 pgd/pmd slot holds the bare pte-page physical address with NO flag
// bits (present iff `entry != 0`, per arch/wasm pgtable.h pmd_present/pmd_none),
// while only the LEAF pte carries `_PAGE_PRESENT` in bit 0 (present iff
// `pte & 1`). On a miss the guest calls into the kernel's fault handler and
// RE-WALKS
// (the kernel is expected to have made the entry present — or to have
// delivered a fatal signal instead of returning, per the generic MM's
// handle_mm_fault contract), rather than emitting an untranslated/garbage
// access. `checked` is OFF by default so every A1 test/measurement is
// byte-for-byte unchanged.
//
// BULK OPS (memory.copy/fill/init) get their OWN checked translate: the
// page-chunked helpers (memcpyHelperBody/memfillHelperBody/meminitHelperBody)
// call an appended `__mmu_translate_ck(va,kind)` per chunk instead of the
// plain unchecked `__mmu_translate(va)` — see `emitTranslateCall` — so a
// chunk landing on a not-present page faults in with the correct permission
// (dest=1 write, memcpy's src=0 read) instead of silently walking a zero PTE
// onto page 0. `checkedTranslateBody` builds that appended function; it is
// the SAME present-checked two-level walk as the inline path below, just
// parameterized as a standalone function since a bulk op calls it once per
// PAGE (a call here is fine — the "inline the translate" rule below is about
// per-SCALAR-ACCESS cost, not per-page).
//
// The fault entry is NOT a bespoke host import — it reuses the EXISTING
// syscall dispatch every guest binary already has: musl's wasm syscall ABI
// (`arch/wasm/bits/asm.h` / `src/misc/wasm/syscalls.S`) exposes
// `__wasm_syscall_2(sp, tp, nr, a, b) -> result`, imported as `env
// .__wasm_syscall_2` by every guest binary that links libc (real guest
// binaries always do — the process model is single-shared-arena over musl).
// The kernel side of the fault entry (`arch/wasm/mm/fault.c
// __wasm_mmu_fault(addr, kind)`) is dispatched off syscall nr 244
// (`__NR_arch_specific_syscall`, the first of the reserved arch-private
// 16-slot block — confirmed unused by wasm's syscall table), so the emitted
// call is `__wasm_syscall_2(NR_MMU_FAULT, ea, kind)` — `sp`/`tp` are the
// mandatory leading operands of the *real* `__wasm_syscall_2` ABI (musl's
// `__SYSCALL_HEAD` pushes `__stack_pointer`/`__tls_base` ahead of the
// syscall args), not extra plumbing invented by this pass.
//
// CONTRACT CHOICE (documented per the task): ordinary `checked: true` REQUIRES
// the module to already import `__wasm_syscall_2` (type
// `(i32,i32,i32,i32,i32) -> i32`) plus the `__stack_pointer` global and export
// `__get_tls_base`, and THROWS a clear error if any are absent. Runtime-loaded
// SIDE_MODULEs are the deliberate exception: they receive a
// `faultTableIndex`, pointing at an embedder-installed `(i32,i32)->i32` bridge
// in their already-shared table. This avoids splicing a function import, which
// would shift every existing
// defined-function index by one everywhere a `call`/`call_indirect`/
// `ref.func`/element-segment/export refers to a function by index — a
// whole-module renumbering pass, for an import that (per the ABI note
// above) every real checked-mode target already carries. REQUIRE is the
// correct simpler contract: it matches reality (every musl-linked guest
// binary imports these three already) and keeps the module surgery in this
// pass limited to APPENDING (types/funcs/globals/exports), which is the
// invariant the rest of `instrument()` already relies on.
//
// The "every binary imports it already" precondition holds because every
// musl-linked guest binary makes 2-arg syscalls, so `__wasm_syscall_2` is a
// live import. #152 looked like a violation — sommelier read as `func-imports=1`,
// only `__wasm_ffi_call` — but that was a DECODER bug, not a missing import: the
// import walkers (`parseImportsDetailed`/`countImports`) desynced on the
// `__cpp_exception` TAG import (kind 0x04) that `-fwasm-exceptions` C++ binaries
// carry AHEAD of the syscall imports, so the syscalls went unseen. Handling tag
// imports (below) restored the invariant; NO musl keep-alive is needed.
export const NR_MMU_FAULT = 244; // __NR_arch_specific_syscall (asm-generic/unistd.h)

// V8's optimizing wasm compiler may inline the tiny translate helpers back into
// every memory access. That defeats the helper path's memory bound: clang and
// wasm-ld have enough accesses that top-tier code grows by multiple GiB and a
// 32-GiB host is OOM-killed even though their rewritten wire modules are small.
// Keep each appended helper above the engine's inlining-size budget with wasm
// `nop`s. NOPs preserve the operand stack and compile to no machine operation;
// they change only the helper's wire size used by the inlining heuristic. V8's
// hard `--wasm-inlining-max-size` default is 500 wire bytes; 4 KiB leaves ample
// headroom without making TurboFan process megabytes of NOPs when the hot helper
// itself tiers up. The padding is added only when a module actually uses the
// bounded helper path; ordinary inline modules and one-shot configure probes do
// not grow.
export const SOFTMMU_HELPER_NOINLINE_PADDING_BYTES = 4 * 1024;

/**
 * Build the tiny wasm function installed in a process table for checked side
 * modules. `fault(va, kind)` supplies the main image's live SP/TLS values to
 * the existing syscall2 trap and returns its result. The side module calls it
 * indirectly, so no function import/index renumbering is required.
 *
 * @returns {Uint8Array}
 */
export function genFaultBridge() {
  const name = (v) => vec([...v].map((c) => c.charCodeAt(0)));
  const sec = (id, body) => [id, ...u(body.length), ...body];
  const functype = (params, results) => [0x60, ...vec(params), ...vec(results)];
  const types = sec(
    1,
    vec([
      functype([VT.i32, VT.i32, VT.i32, VT.i32, VT.i32], [VT.i32]),
      functype([], [VT.i32]),
      functype([VT.i32, VT.i32], [VT.i32]),
    ]),
  );
  const imports = sec(
    2,
    vec([
      [...name("env"), ...name("__wasm_syscall_2"), 0x00, ...u(0)],
      [...name("env"), ...name("__get_tls_base"), 0x00, ...u(1)],
      [...name("env"), ...name("__stack_pointer"), 0x03, VT.i32, 0x01],
    ]),
  );
  const funcs = sec(3, vec([[...u(2)]]));
  const exports = sec(7, vec([[...name("fault"), 0x00, ...u(2)]]));
  const code = [
    ...u(0), // no locals
    0x23,
    ...u(0), // global.get __stack_pointer
    0x10,
    ...u(1), // call __get_tls_base
    0x41,
    ...s(NR_MMU_FAULT),
    0x20,
    ...u(0), // local.get va
    0x20,
    ...u(1), // local.get kind
    0x10,
    ...u(0), // call __wasm_syscall_2
    0x0b,
  ];
  const codes = sec(10, vec([[...u(code.length), ...code]]));
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...types,
    ...imports,
    ...funcs,
    ...exports,
    ...codes,
  ]);
}

/** Fault `kind` for an atomic op: RMW/cmpxchg/store need write permission. */
function atomicFaultKind(sub) {
  return sub >= 0x17 ? 1 : 0;
}

/** [name, nextIndex] — read a wasm length-prefixed name at `i`. */
function readName(b, i) {
  let len;
  [len, i] = readU(b, i);
  let str = "";
  for (let k = 0; k < len; k++) str += String.fromCharCode(b[i + k]);
  return [str, i + len];
}

/** Parse the import section into ordered func/global entries (index == position). */
function parseImportsDetailed(body) {
  let i = 0;
  let n;
  [n, i] = readU(body, 0);
  const funcs = [];
  const globals = [];
  for (let k = 0; k < n; k++) {
    let mod, name;
    [mod, i] = readName(body, i);
    [name, i] = readName(body, i);
    const ek = body[i++];
    if (ek === 0x00) {
      let t;
      [t, i] = readU(body, i);
      funcs.push({ module: mod, name, typeIdx: t });
    } else if (ek === 0x01) {
      i++; // elemtype
      const fl = body[i++];
      [, i] = readU(body, i);
      if (fl & 1) [, i] = readU(body, i);
    } else if (ek === 0x02) {
      const fl = body[i++];
      [, i] = readU(body, i);
      if (fl & 1) [, i] = readU(body, i);
    } else if (ek === 0x03) {
      const vt = body[i++];
      const mut = body[i++];
      globals.push({ module: mod, name, valtype: vt, mutable: mut });
    } else if (ek === 0x04) {
      // tag (exception) import: attribute byte + type index. Every guest C++
      // binary (built `-fwasm-exceptions`) imports the `__cpp_exception` tag,
      // and wasm-ld can emit it BEFORE the `__wasm_syscall_*` function imports.
      // Skipping it MUST advance past both descriptor bytes — dropping this
      // case desyncs the walk and makes every later import (incl. the syscalls
      // `resolveCheckedImports` needs) invisible (#152: sommelier read as
      // `func-imports=1`, only `__wasm_ffi_call`). Encoding mirrors the
      // canonical tag walker in kernel-worker.js.
      i++; // attribute (0x00 = exception)
      [, i] = readU(body, i); // type index
    }
  }
  return { funcs, globals };
}

/** Parse the type section into [{params:[valtype…], results:[valtype…]}]. */
function parseTypeEntries(typeBody) {
  if (!typeBody) return [];
  let i = 0;
  let n;
  [n, i] = readU(typeBody, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (typeBody[i++] !== 0x60) throw new Error("softmmu: bad functype");
    let np;
    [np, i] = readU(typeBody, i);
    const params = [];
    for (let p = 0; p < np; p++) params.push(typeBody[i++]);
    let nr;
    [nr, i] = readU(typeBody, i);
    const results = [];
    for (let r = 0; r < nr; r++) results.push(typeBody[i++]);
    out.push({ params, results });
  }
  return out;
}

/**
 * @typedef {{
 *   syscallFuncIdx?: number,
 *   spGlobalIdx?: number,
 *   tlsFuncIdx?: number,
 *   faultTableIndex?: number,
 *   faultTypeIdx?: number,
 *   checkedTranslateFunc?: number,
 * }} CheckedContext
 */

/**
 * Resolve + validate the three imports `checked: true` requires. Throws a
 * clear, specific error (never silently degrades to unchecked) when any is
 * missing or has an unexpected signature.
 *
 * @param {{id:number, body:Uint8Array}|undefined} importSec
 * @param {{id:number, body:Uint8Array}|undefined} typeSec
 * @param {{id:number, body:Uint8Array}|undefined} exportSec
 * @returns {CheckedContext}
 *   `checkedTranslateFunc` is NOT set by this function — `instrument()`
 *   attaches it afterward, once the appended `__mmu_translate_ck` function's
 *   index is known, so `rewriteFuncBody`'s inline checked path (#202 §6.2)
 *   can call it as the combined predicate's out-of-line "slow" arm.
 */
function resolveCheckedImports(importSec, typeSec, exportSec) {
  if (!importSec) {
    throw new Error(
      'softmmu: checked mode requires imports for "__wasm_syscall_2", ' +
        '"__stack_pointer", and "__tls_base" — this module has no import section',
    );
  }
  const { funcs, globals } = parseImportsDetailed(importSec.body);
  const syscallFuncIdx = funcs.findIndex((f) => f.name === "__wasm_syscall_2");
  if (syscallFuncIdx === -1) {
    // #152 diagnostic: report which env.* imports (esp. the __wasm_syscall_N
    // family) this binary DOES have, so a boot failure localizes the cause:
    //  - imports other __wasm_syscall_* but NOT _2 → it links libc yet the
    //    keep-alive (toolchain/musl.nix) did not land in THIS binary;
    //  - imports NO __wasm_syscall_* → a non-libc / custom-entry binary that
    //    never routes through __libc_start_main at all.
    const syscalls = funcs.map((f) => f.name).filter((n) => /^__wasm_syscall_\d$/.test(n));
    const envImports = funcs
      .map((f) => f.name)
      .filter((n) => n.startsWith("__") || n.startsWith("logAPIs") || n.includes("wasm"))
      .slice(0, 24);
    throw new Error(
      'softmmu: checked mode requires the module to import "__wasm_syscall_2" ' +
        "(musl's syscall2 host trap, used here to route NR_MMU_FAULT to the " +
        "kernel's fault handler) — every real guest binary that links libc " +
        "imports it; this module does not. " +
        `[#152 diag] func-imports=${funcs.length}; __wasm_syscall_* present=[${syscalls.join(",") || "none"}]; ` +
        `sample env imports=[${envImports.join(",")}]`,
    );
  }
  const types = parseTypeEntries(typeSec ? typeSec.body : null);
  const sig = types[funcs[syscallFuncIdx].typeIdx];
  const wantParams = [VT.i32, VT.i32, VT.i32, VT.i32, VT.i32];
  const isExpectedSig =
    sig &&
    sig.params.length === wantParams.length &&
    sig.params.every((t, idx) => t === wantParams[idx]) &&
    sig.results.length === 1 &&
    sig.results[0] === VT.i32;
  if (!isExpectedSig) {
    throw new Error(
      'softmmu: checked mode: imported "__wasm_syscall_2" has an unexpected ' +
        "signature (expected (i32,i32,i32,i32,i32)->i32 — sp,tp,nr,a,b, matching " +
        "musl's arch/wasm/bits/asm.h)",
    );
  }
  const spGlobalIdx = globals.findIndex((g) => g.name === "__stack_pointer");
  if (spGlobalIdx === -1) {
    throw new Error(
      'softmmu: checked mode requires the module to import the "__stack_pointer" global',
    );
  }
  // tp = the current task's TLS base. A static musl binary keeps __tls_base as
  // an INTERNAL global (not imported/named), exposed only via the exported
  // __get_tls_base() function — which the engine relies on universally (it
  // calls the __set_tls_base pair on every user instance). So source tp by
  // CALLING __get_tls_base, exactly as musl's own syscall wrapper effectively
  // does, rather than reading a (usually absent) named global.
  const tlsFuncIdx = findExportFuncIdx(exportSec, "__get_tls_base");
  if (tlsFuncIdx === -1) {
    throw new Error(
      'softmmu: checked mode requires the module to export "__get_tls_base" ' +
        "(the TLS-base accessor musl emits + the engine drives via __set_tls_base); " +
        "this module does not",
    );
  }
  return { syscallFuncIdx, spGlobalIdx, tlsFuncIdx };
}

/** Find an exported FUNCTION's index by name (export kind 0). -1 if absent. */
function findExportFuncIdx(exportSec, name) {
  if (!exportSec) return -1;
  const b = exportSec.body;
  let i = 0;
  let n;
  [n, i] = readU(b, 0);
  for (let k = 0; k < n; k++) {
    let len;
    [len, i] = readU(b, i);
    const nm = String.fromCharCode(...b.subarray(i, i + len));
    i += len;
    const kind = b[i++];
    let idx;
    [idx, i] = readU(b, i);
    if (kind === 0 && nm === name) return idx;
  }
  return -1;
}

// ---- atomic memory ops (0xfe prefix) ---------------------------------------
//
// The guest's musl pthread is atomics-heavy, so a real-guest instrumented boot
// requires translating these too. An atomic access translates its address
// EXACTLY like a scalar one (a pure page-table read) and then does the RAW
// atomic at `phys` — atomicity is preserved because the translate doesn't touch
// the accessed word. TWO differences from scalars:
//   • the address is the DEEPEST operand (under 0–2 value operands), so the
//     emit stashes the value operands into scratch locals, translates, restores;
//   • atomics REQUIRE natural alignment — the emitted raw op keeps the ORIGINAL
//     memarg `align` (not 0), and the translate preserves alignment (phys =
//     4K-aligned page base + low bits of ea, so phys is aligned iff ea is).
//
// ATOMIC_OPS[sub] = { opsAbove: [type,…] (bottom→top, above the address), result }.
// Built programmatically from the wasm threads opcode layout to avoid a ~50-row
// hand transcription. atomic.fence (0x03) has no memarg and is copied verbatim.
const ATOMIC_OPS = (() => {
  const t = {};
  t[0x00] = { opsAbove: ["i32"], result: true }; // memory.atomic.notify(count)
  t[0x01] = { opsAbove: ["i32", "i64"], result: true }; // wait32(expected,timeout)
  t[0x02] = { opsAbove: ["i64", "i64"], result: true }; // wait64(expected,timeout)
  // 0x03 atomic.fence — no memarg (handled separately)
  // loads 0x10..0x16: no value operand, push a result
  for (let op = 0x10; op <= 0x16; op++) t[op] = { opsAbove: [], result: true };
  // the 7-wide width→type pattern shared by store/rmw/cmpxchg groups:
  //   [i32.full, i64.full, i32.8, i32.16, i64.8, i64.16, i64.32]
  const W = ["i32", "i64", "i32", "i32", "i64", "i64", "i64"];
  // stores 0x17..0x1d: one value operand, no result
  for (let k = 0; k < 7; k++) t[0x17 + k] = { opsAbove: [W[k]], result: false };
  // rmw add/sub/and/or/xor/xchg — six groups of 7 (0x1e..0x47): one value, result
  for (let g = 0; g < 6; g++) {
    for (let k = 0; k < 7; k++) t[0x1e + g * 7 + k] = { opsAbove: [W[k]], result: true };
  }
  // cmpxchg 0x48..0x4e: two operands (expected, replacement) same width, result
  for (let k = 0; k < 7; k++) t[0x48 + k] = { opsAbove: [W[k], W[k]], result: true };
  return t;
})();

// ---- leb + section helpers --------------------------------------------------

function readU(b, i) {
  let r = 0,
    sh = 0,
    x;
  do {
    x = b[i++];
    r += (x & 0x7f) * 2 ** sh;
    sh += 7;
  } while (x & 0x80);
  return [r, i];
}
function readS(b, i) {
  let r = 0,
    sh = 0,
    x;
  do {
    x = b[i++];
    r |= (x & 0x7f) << sh;
    sh += 7;
  } while (x & 0x80);
  if (sh < 32 && x & 0x40) r |= -1 << sh;
  return [r, i];
}
function u(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let x = v & 0x7f;
    v >>>= 7;
    if (v) x |= 0x80;
    out.push(x);
  } while (v);
  return out;
}
function s(n) {
  const out = [];
  let more = true;
  let v = n | 0;
  while (more) {
    let x = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(x & 0x40)) || (v === -1 && x & 0x40)) more = false;
    else x |= 0x80;
    out.push(x);
  }
  return out;
}
const vec = (items) => [...u(items.length), ...items.flat()];

/**
 * Concatenate an ordered list of byte chunks (each a `number[]` or `Uint8Array`)
 * into a single `Uint8Array`. Use this instead of `chunks.flat()` + spread when
 * the aggregate can be large: V8's `Array.prototype.flat` throws
 * `RangeError: Invalid array length` once the flattened result exceeds its
 * FixedArray accumulator ceiling (~128M elements empirically — far below
 * 2**32), which the instrumented code section of a large binary like nix.wasm
 * (hundreds of MB) blows past mid-boot at `execve`. A summed typed-array copy
 * has no such ceiling and never materializes a giant intermediate number array.
 * @param {Array<number[]|Uint8Array>} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * A growable byte buffer for SINGLE-PASS streaming wasm emission (#202).
 *
 * WHY: `rewriteFuncBody` used to accumulate into a plain JS `number[]`
 * (`out.push(byte)` per emitted byte). On a Node build without pointer
 * compression that costs ~24 bytes of process RSS per emitted byte (an 8-byte
 * `PACKED_SMI_ELEMENTS` FixedArray slot × ~2-3× for geometric array growth +
 * the old backing store still live mid-grow + GC lag) — measured: ONE 1.4 MB
 * function of `nix.wasm` produced a 12.6 MB rewritten body and moved peak RSS
 * by ~298 MiB by itself. `instrument()` then held the whole instrumented
 * module THREE TIMES OVER at final assembly (`newCodeEntries` — one Uint8Array
 * per function — then `newCodeBody = concatBytes(newCodeEntries)`, then the
 * final `bytesOut`). A `ByteSink` fixes both: it is an ordinary
 * doubling-growth `Uint8Array` (the same ~1-2× transient any typed-array
 * accumulator pays, NOT 24×-per-byte), and `instrument()` now streams the
 * ENTIRE module — including every function body — into ONE shared sink,
 * eliminating `newCodeEntries` and `newCodeBody` outright (two of the three
 * whole-module copies; only the sink's own backing buffer remains).
 *
 * PADDED-LEB BACKPATCH: a function body's final byte length (and the code
 * section's own total byte length) are not known until every byte has been
 * written — including the rare case where an over-limit function is
 * re-emitted via the helper-call fallback (#164), which must be able to
 * DISCARD an in-progress inline emission and retry from the same offset. The
 * `reserve`/`patch5` pair lets a caller reserve a FIXED 5-byte field, write
 * the (variable-length) content, then backpatch the field once the true
 * length is known — no separate size-measuring pre-pass, no second body copy.
 * A 5-byte field is always big enough: standard LEB128 allows non-minimal
 * ("padded") encodings up to `ceil(N/7)` bytes for an N-bit value, and 5×7=35
 * bits covers every 32-bit wasm length/count field with room to spare. This
 * padded form was verified directly against V8 (Node 22,
 * `new WebAssembly.Module(...)`): section sizes, function-body sizes, and
 * vector counts all load fine whether minimal or padded.
 *
 * SCOPE: the padded/backpatch form is used for every section's OUTER size
 * field (the final assembly loop reserve()s 5 bytes for each emitted
 * section, writes its body, then patch5()s the true length once known —
 * see the loop at the end of this file) and for each per-function body-size
 * field within the code section, because those are the values whose true
 * length is not known until after the bytes are written — most sections'
 * bodies happen to be fully computable up front, but reserve/patch is used
 * uniformly rather than special-cased per section, so every outer size field
 * in the emitted module is 5 bytes regardless of whether that particular
 * section's size was knowable in advance. Everything ELSE — the module
 * header, section bodies' own internal counts/lengths (types, exports,
 * globals, the code section's function-count vector), and the appended fixed
 * helper bodies' length prefixes — is fully computable before it is written
 * and keeps the plain minimal `u()`/`s()` LEB encoding unchanged. Verified
 * directly against V8 (see above) for both the minimal and padded forms, so
 * a reader can trust either encoding appearing anywhere in the output.
 */
export class ByteSink {
  constructor(initialCapacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(initialCapacity, 64));
    this.len = 0;
  }

  /** Grow the backing store (geometric doubling) so `extra` more bytes fit. */
  _ensure(extra) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Append one or more raw bytes — drop-in replacement for `Array.push`. */
  push(...byteArgs) {
    this._ensure(byteArgs.length);
    this.buf.set(byteArgs, this.len);
    this.len += byteArgs.length;
    return this.len;
  }

  /** Append every byte of an array-like (`number[]` or `Uint8Array`), no spread. */
  pushBytes(bytesArrayLike) {
    const n = bytesArrayLike.length;
    this._ensure(n);
    this.buf.set(bytesArrayLike, this.len);
    this.len += n;
    return this.len;
  }

  /** Reserve `n` raw placeholder bytes (uninitialized-value = 0), return their offset. */
  reserve(n) {
    this._ensure(n);
    const off = this.len;
    this.len += n;
    return off;
  }

  /**
   * Backpatch a PADDED 5-byte unsigned LEB128 at `offset` (from a prior
   * `reserve(5)`) with `value`. Always exactly 5 bytes: the first four bytes
   * carry the continuation bit UNCONDITIONALLY (regardless of whether more
   * significant bits remain), and the fifth never does — see the class doc
   * comment for why this is spec-legal and V8-verified.
   */
  patch5(offset, value) {
    let v = value >>> 0;
    for (let k = 0; k < 4; k++) {
      this.buf[offset + k] = 0x80 | (v & 0x7f);
      v >>>= 7;
    }
    this.buf[offset + 4] = v & 0x7f;
  }

  /** Reserve 5 bytes and immediately patch them — for a value known up-front. */
  pushPadded5(value) {
    const off = this.reserve(5);
    this.patch5(off, value);
  }

  /** The written portion as a Uint8Array VIEW (no copy) — call once, at the end. */
  toUint8Array() {
    return this.buf.subarray(0, this.len);
  }
}

/** Split a module into [{id, body}] (body excludes id + size). */
function splitSections(bytes) {
  if (bytes[0] !== 0 || bytes[1] !== 0x61) throw new Error("not wasm");
  const out = [];
  let i = 8;
  while (i < bytes.length) {
    const id = bytes[i++];
    let size;
    [size, i] = readU(bytes, i);
    out.push({ id, body: bytes.subarray(i, i + size) });
    i += size;
  }
  return out;
}

// ---- instruction walker: know every immediate so we can find mem ops --------

/**
 * Skip a blocktype immediate (empty 0x40, a single valtype, or an s33 type
 * index) — used by block/loop/if AND the exception-handling `try`/`try_table`.
 */
function skipBlockType(b, i) {
  if (
    b[i] === 0x40 ||
    b[i] === 0x7f ||
    b[i] === 0x7e ||
    b[i] === 0x7d ||
    b[i] === 0x7c ||
    b[i] === 0x7b ||
    b[i] === 0x70 ||
    b[i] === 0x6f
  ) {
    return i + 1;
  }
  [, i] = readS(b, i);
  return i;
}

/** Index just past the instruction at `i` (opcode + immediates), non-recursing. */
function skipInstr(b, i) {
  const op = b[i++];
  switch (op) {
    case 0x02: // block
    case 0x03: // loop
    case 0x04: // if
      return skipBlockType(b, i);
    // ---- wasm exception handling (guest C++ is built -fwasm-exceptions) -----
    // Both the legacy (try/catch/…) and standard (try_table/throw_ref) EH
    // opcode sets appear in a guest binary depending on the LLVM lowering, so
    // handle all of them. `skipInstr` is a LINEAR (non-recursing) walker, so a
    // scope opener only needs its immediates skipped — the nested body and the
    // matching `end`/`catch`/`delegate` are visited as their own instructions.
    // Without these, instrument() throws "unknown opcode" on the first EH
    // instruction in sommelier / nix.wasm / any GTK app's code (#152).
    case 0x06: // try (legacy) — blocktype
      return skipBlockType(b, i);
    case 0x1f: {
      // try_table (standard) — blocktype + vec(catch clause)
      i = skipBlockType(b, i);
      let n;
      [n, i] = readU(b, i);
      for (let k = 0; k < n; k++) {
        const ck = b[i++]; // 0 catch, 1 catch_ref, 2 catch_all, 3 catch_all_ref
        if (ck === 0x00 || ck === 0x01) [, i] = readU(b, i); // tag index
        [, i] = readU(b, i); // label
      }
      return i;
    }
    case 0x07: // catch (legacy) — tag index
    case 0x08: // throw — tag index
    case 0x09: // rethrow (legacy) — relative depth
    case 0x18: // delegate (legacy) — relative depth
      [, i] = readU(b, i);
      return i;
    case 0x19: // catch_all (legacy) — no immediate
    case 0x0a: // throw_ref (standard) — no immediate
      return i;
    case 0x0c: // br
    case 0x0d: // br_if
      [, i] = readU(b, i);
      return i;
    case 0x0e: {
      // br_table
      let n;
      [n, i] = readU(b, i);
      for (let k = 0; k < n; k++) [, i] = readU(b, i);
      [, i] = readU(b, i);
      return i;
    }
    case 0x00:
    case 0x01:
    case 0x05:
    case 0x0b:
    case 0x0f:
    case 0x1a:
    case 0x1b:
      return i;
    case 0x1c: {
      // select t*
      let n;
      [n, i] = readU(b, i);
      i += n;
      return i;
    }
    case 0x10: // call
      [, i] = readU(b, i);
      return i;
    case 0x11: // call_indirect
      [, i] = readU(b, i);
      [, i] = readU(b, i);
      return i;
    case 0x20:
    case 0x21:
    case 0x22: // local.get/set/tee
    case 0x23:
    case 0x24: // global.get/set
    case 0xd0: // ref.null
    case 0xd2: // ref.func
      [, i] = readU(b, i);
      return i;
    case 0xd1: // ref.is_null
      return i;
    case 0x3f:
    case 0x40: // memory.size/grow
      i++;
      return i;
    case 0x41:
      [, i] = readS(b, i);
      return i; // i32.const
    case 0x42:
      [, i] = readS(b, i);
      return i; // i64.const
    case 0x43:
      return i + 4; // f32.const
    case 0x44:
      return i + 8; // f64.const
    case 0xfc:
      return skipFC(b, i);
    case 0xfe:
      return skipAtomic(b, i);
    case 0xfd:
      throw new Error("SIMD (0xfd) not handled by softmmu pass");
    default:
      if (op >= 0x28 && op <= 0x3e) {
        // a memory op — memarg (align, offset)
        [, i] = readU(b, i);
        [, i] = readU(b, i);
        return i;
      }
      if (op >= 0x45 && op <= 0xc4) return i; // numeric/compare/convert/sign-ext
      throw new Error(`softmmu: unknown opcode 0x${op.toString(16)} at ${i - 1}`);
  }
}

function skipFC(b, i) {
  let sub;
  [sub, i] = readU(b, i);
  switch (sub) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
      return i;
    case 8:
      [, i] = readU(b, i);
      i++;
      return i; // memory.init
    case 9:
      [, i] = readU(b, i);
      return i; // data.drop
    case 10:
      i += 2;
      return i; // memory.copy
    case 11:
      i++;
      return i; // memory.fill
    case 12:
    case 14:
      [, i] = readU(b, i);
      [, i] = readU(b, i);
      return i;
    case 13:
    case 15:
    case 16:
    case 17:
      [, i] = readU(b, i);
      return i;
    default:
      throw new Error(`softmmu: unknown 0xfc ${sub}`);
  }
}
function skipAtomic(b, i) {
  let sub;
  [sub, i] = readU(b, i);
  if (sub === 3) {
    i++;
    return i;
  } // atomic.fence
  [, i] = readU(b, i);
  [, i] = readU(b, i);
  return i;
}

// ---- per-function inline rewrite --------------------------------------------

/**
 * Rewrite one function body: append 5 scratch locals, then inline the translate
 * at every load/store. `numParams` = the function's parameter count (scratch
 * locals index after params + existing locals). `ptBaseGlobal` = the pt_base
 * global index.
 *
 * @param {Uint8Array} code the function body (local decls + instrs, no size prefix)
 * @param {number} numParams
 * @param {number} ptBaseGlobal
 * @param {{memcpy:number, memfill:number, meminit:Map<number,number>}|null} bulkFns
 * @param {CheckedContext|null} [checked]
 *   A2 present-check context (from `resolveCheckedImports`, with
 *   `checkedTranslateFunc` attached by `instrument()` — see that function's
 *   doc comment; the inline checked path, #202 §6.2, calls it as its combined
 *   predicate's out-of-line "slow" arm); omit/null for the default A1
 *   unchecked fast path (byte-identical to before A2 existed).
 * @param {{translateFunc:number, checkedTranslateFunc:number|null}|null} [helper]
 *   #164: when set, emit each access's translate as a CALL to the appended
 *   translate helper (`__mmu_translate` / `__mmu_translate_ck`) instead of
 *   inlining the walk. Semantically identical — the helper IS the same walk as
 *   a function — but ~4-5× smaller per access. `instrument()` uses this ONLY for
 *   a function whose inline body would exceed V8's per-function size limit
 *   (`kV8MaxWasmFunctionSize`); every other function keeps the measured-fast
 *   inline path. Null (default) = inline, byte-identical to before #164.
 * @param {{loadBytes:number, storeBytes:number}|null} [splitFns]
 *   #128 PAGE-CROSSING split: indices of the appended byte-wise slow-path
 *   helpers (`__mmu_load_bytes(ea,width)->i64` / `__mmu_store_bytes(ea,val,width)`).
 *   For every scalar access of width>=2 the pass adds a fast within-page path
 *   (`(ea&0xfff) <= 0x1000-width`) + a slow byte-wise path that translates each
 *   byte's page separately, so an access straddling a page boundary reaches the
 *   correct two (non-adjacent) physical frames. In helper mode a width>=2 access
 *   ALWAYS takes the byte helper (no inline fast path — keeps the over-limit
 *   function compact). Null (unit-test direct calls) = pre-fix raw access.
 * @param {ByteSink} sink #202: the byte sink to APPEND this function's rewritten
 *   body into (local-decl vec + instructions, no size prefix — the caller owns
 *   framing/backpatching the size field). Callers stream every function
 *   directly into ONE shared whole-module sink (see `instrument()`), so this
 *   is REQUIRED (not defaulted — a trailing param after three optional ones
 *   needs a default expression to satisfy `tsc -p jsconfig.json`'s checkJs,
 *   so the default is `undefined` and this throws immediately if omitted,
 *   rather than silently writing into nothing), not owned/returned by this
 *   function — measure what was written via `sink.len` before/after the call
 *   (this replaced the old `number[]` return value; see the #202 ByteSink
 *   doc comment for why).
 * @returns {void}
 */
export function rewriteFuncBody(
  code,
  numParams,
  ptBaseGlobal,
  bulkFns,
  checked = null,
  helper = null,
  splitFns = null,
  sink = undefined,
) {
  if (!sink) throw new Error("softmmu: rewriteFuncBody requires a ByteSink `sink` argument");
  // #202 P2-4: `checkedTranslateFunc` is JSDoc-optional on `checked` (it's
  // attached by `instrument()` after `resolveCheckedImports` returns it), but
  // every checked-mode caller MUST have set it before reaching here — the
  // inline checked translate emits `call <checked.checkedTranslateFunc>`
  // (`u(undefined) >>> 0 === 0` would silently emit `call 0`, binding to
  // whatever function happens to sit at index 0 if its type matches, instead
  // of failing loudly). Fail fast instead of trusting the field silently.
  if (checked && checked.checkedTranslateFunc == null) {
    throw new Error("softmmu: checked context is missing checkedTranslateFunc");
  }
  let i = 0;
  let nLocals;
  [nLocals, i] = readU(code, 0);
  const localsStart = i;
  let existingLocalCount = 0;
  for (let k = 0; k < nLocals; k++) {
    let cnt;
    [cnt, i] = readU(code, i);
    existingLocalCount += cnt;
    i++; // valtype
  }
  const localsEnd = i;

  // scratch locals appended after params + existing locals:
  //   base+0 ea (i32) — the effective address for the translate
  //   base+1 val_i32, base+2 val_i64, base+3 val_f32, base+4 val_f64
  //     — operand SLOT A (a scalar store's value; an atomic's first operand)
  //   base+5 b_i32, base+6 b_i64
  //     — operand SLOT B (an atomic's second operand: cmpxchg replacement /
  //       wait timeout). Slot A and B use disjoint locals so a two-operand
  //       atomic with same-typed operands never clobbers.
  //   base+7 pgd_e, base+8 pte (checked mode only)
  //     — the A2 present-checked walk's level-1/level-2 entries, held in
  //       locals so the present-bit test can consume a copy (local.tee)
  //       while the unmasked value is still needed for the next level /
  //       the final phys computation.
  const base = numParams + existingLocalCount;
  const EA = base;
  const VAL = { i32: base + 1, i64: base + 2, f32: base + 3, f64: base + 4 };
  const B = { i32: base + 5, i64: base + 6 };
  const PGD_E = base + 7;
  const PTE = base + 8;

  // #202: `out` is the caller's shared ByteSink (the whole module streams into
  // ONE sink — see `instrument()`), not a fresh accumulator per call. Every
  // `out.push(...)` call below is UNCHANGED from the pre-#202 number[] version
  // — ByteSink.push is a drop-in, Array.push-compatible variadic append.
  const out = sink;
  // new local-decl vec: existing 6 groups + 1 more (pgd_e+pte) when checked
  out.push(...u(nLocals + 6 + (checked ? 1 : 0)));
  out.pushBytes(code.subarray(localsStart, localsEnd));
  out.push(...u(2), VT.i32); // ea + val_i32
  out.push(...u(1), VT.i64); // val_i64
  out.push(...u(1), VT.f32); // val_f32
  out.push(...u(1), VT.f64); // val_f64
  out.push(...u(1), VT.i32); // b_i32
  out.push(...u(1), VT.i64); // b_i64
  if (checked) out.push(...u(2), VT.i32); // pgd_e + pte (A2 scratch)

  // emit the inline translate producing `phys` on the stack from `ea` in $EA.
  // TWO-LEVEL walk matching the kernel arch layer (design §2 revised: the
  // generic MM wants page-sized PTE tables, so PGDIR_SHIFT=22, 1024/1024):
  //   pgd_e = u32[ pt_base + (ea>>>22)<<2 ]
  //   pte   = u32[ (pgd_e & ~0xfff) + ((ea>>>12 & 0x3ff)<<2) ]
  //   phys  = (pte & ~0xfff) + (ea & 0xfff)
  // Low 12 bits of both entries are MASKED — kernel PTEs carry flag bits
  // (present/write/accessed/dirty); the A1 fast path ignores them but must
  // not let them corrupt the address.
  //
  // #202 §6.2: the inline checked path no longer emits its OWN
  // `__wasm_syscall_2(NR_MMU_FAULT, ea, kind)` fault call (there used to be
  // an `emitFaultCall` closure here, emitted up to twice per access, one per
  // page-table level) — it now calls the appended `__mmu_translate_ck`
  // (checkedTranslateBody) out of line on a present-check miss, and THAT
  // function owns the fault call + retry loop (checked.spGlobalIdx /
  // .tlsFuncIdx / .syscallFuncIdx are still validated by
  // `resolveCheckedImports` and still consumed there, just no longer
  // referenced directly from this per-access emission).

  // emitTranslate(kind): leaves `phys` (i32) on the stack from `ea` in $EA.
  // `kind` (0=load, 1=store/rmw/cmpxchg) is only used by the checked variant
  // (the fault's access-kind argument) — the unchecked fast path ignores it.
  //
  // UNCHECKED (default, checked===null): the A1 fast path — pure two-level
  // walk, no present check (byte-identical to the pre-A2 pass).
  //
  // CHECKED (#202 §6.2 — the combined-predicate/out-of-line-fault form,
  // replacing the original per-level block/loop/retry): see
  // `emitCheckedPresentPredicate` below for the walk + predicate, and the
  // `emitCombinedAccessBody`-style helper doc for why folding the two
  // per-level present/permission branches into ONE `if`/out-of-line-call is
  // safe. This function's EXTERNAL contract (leaves phys on the stack,
  // caller emits the raw op) is UNCHANGED — only the internal shape of the
  // checked case changed, so every caller below needed no edits.
  const emitTranslate = (kind) => {
    if (helper) {
      // #164: helper-call translate — call the appended walk function instead
      // of inlining it, keeping this (over-limit) function under V8's max
      // function size. `$EA` already holds the effective address (the load/
      // store/atomic emit set it), exactly as the inline path expects.
      out.push(0x20, ...u(EA)); // local.get ea
      if (checked) {
        out.push(0x41, ...s(kind)); // i32.const kind (fault access-kind)
        out.push(0x10, ...u(helper.checkedTranslateFunc)); // call __mmu_translate_ck -> phys
      } else {
        out.push(0x10, ...u(helper.translateFunc)); // call __mmu_translate -> phys
      }
      return;
    }
    if (!checked) {
      out.push(0x23, ...u(ptBaseGlobal)); // global.get pt_base
      out.push(0x20, ...u(EA)); // local.get ea
      out.push(0x41, ...s(22), 0x76); // i32.const 22 ; i32.shr_u  -> pgd index
      out.push(0x41, ...s(2), 0x74); // i32.const 2 ; i32.shl      -> *4
      out.push(0x6a); // i32.add -> pt_base + pgdi*4
      out.push(0x28, 0x02, ...u(0)); // i32.load align=2 off=0 -> pgd_e (RAW)
      out.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> pte-table base
      out.push(0x20, ...u(EA)); // local.get ea
      out.push(0x41, ...s(12), 0x76); // >>> 12
      out.push(0x41, ...s(0x3ff), 0x71); // & 0x3ff -> pte index
      out.push(0x41, ...s(2), 0x74); // << 2
      out.push(0x6a); // i32.add
      out.push(0x28, 0x02, ...u(0)); // i32.load -> pte (RAW)
      out.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> page base
      out.push(0x20, ...u(EA)); // local.get ea
      out.push(0x41, ...s(0xfff), 0x71); // & 0xfff
      out.push(0x6a); // i32.add -> phys
      return;
    }
    // CHECKED, inline (#202 §6.2): compute the combined present+permission
    // predicate, then branch ONCE — fast arm recomputes phys from the
    // already-read $pte; slow arm (present-check failed) calls the appended,
    // authoritative `__mmu_translate_ck(ea,kind)` (checkedTranslateBody — the
    // SAME function the #164 helper-fallback path already calls), which owns
    // its OWN fault+retry loop out of line. This replaces the old two
    // separate per-level `if (void) { fault; br $retry }` blocks (each
    // ~15 B of emitFaultCall, emitted up to twice) with ONE branch whose
    // "cold" arm is a 3-instruction call — the hot (present) path pays for
    // the predicate once and nothing else.
    emitCheckedPresentPredicate(kind);
    out.push(0x04, VT.i32); // if (result i32)
    // fast arm: phys = (pte & ~0xfff) + (ea & 0xfff), pte from the LOCAL
    // (the stack copy from the predicate's tee was already consumed by the
    // permission test above).
    out.push(0x20, ...u(PTE)); // local.get pte
    out.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> page base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(0xfff), 0x71); // & 0xfff
    out.push(0x6a); // add -> phys
    out.push(0x05); // else
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(kind)); // i32.const kind
    out.push(0x10, ...u(checked.checkedTranslateFunc)); // call __mmu_translate_ck -> phys
    out.push(0x0b); // end if
  };

  // emitCheckedPresentPredicate(kind) (#202 §6.2): the shared "walk both
  // levels unconditionally, then combine present+permission into ONE
  // boolean" building block used by both `emitTranslate`'s checked case
  // (above) and the checked page-crossing split load/store (below). Leaves
  // an i32 boolean (1 = present+correct-permission, take the fast arm) on
  // the stack; $pgd_e/$pte are left holding the RAW (flag-bits-included)
  // entries in their locals for the caller's subsequent phys computation.
  //
  // CORRECTNESS — the hazard #202's own design doc calls out explicitly, and
  // the reason this function reads level 2 UNCONDITIONALLY rather than only
  // after confirming level 1 is present: the address computed for the level-2
  // read when pgd_e==0 is `(0 & ~0xfff) + ((ea>>>12 & 0x3ff)<<2)` = `idx*4`
  // for idx in [0,1023] — i.e. always inside the module's own page 0, which
  // always exists, so this NEVER traps. But the VALUE it reads is garbage
  // (whatever page 0 happens to hold), and garbage CAN happen to have its low
  // bits set such that `(garbage & need) == need` is true. The `pgd_e != 0`
  // conjunct is what neutralises that: `i32.and` of the two ALREADY-BOOLEAN
  // (0/1) operands is false whenever pgd_e==0, regardless of what the
  // unconditional level-2 read produced. DROPPING this conjunct entirely
  // would let a not-present access whose page-0 garbage happens to satisfy
  // the permission mask walk through to a WRONG physical address instead of
  // faulting — silent memory corruption, not a trap. See the dedicated unit
  // test for exactly this case (a not-present level-1 entry with bits 0+1
  // deliberately set at the corresponding page-0 offset).
  //
  // The `pgd_e` conjunct is ALSO normalised to a boolean (`!= 0`, "bool1")
  // rather than ANDed in as the raw `pgd_e` value — but getting THAT wrong is
  // a PERFORMANCE bug, not a corruption one: `raw_pgd_e & bool2` is still
  // bitwise-zero whenever pgd_e==0 (0 ANDed with anything is 0), so a
  // not-present access can never walk through this way. What it breaks is
  // the PRESENT case: real kernel PGD entries are the BARE page-aligned
  // physical address of the pte table (see patches/kernel/0023's
  // `pmd_populate`/`set_pmd` — `set_pmd(pmd, __pmd((unsigned long)
  // page_address(pte)))`, no flag bits), so bit 0 is architecturally 0 on
  // EVERY present level-1 entry too — ANDing the raw value into the
  // predicate would make it false there as well, so the predicate is never
  // true, the fast arm is never taken, and EVERY access (not just the
  // faulting ones) falls through to the out-of-line `__mmu_translate_ck`
  // call: correct results, but silently reinstating the ~12×
  // helper-call-per-access cost this file's own header calls the
  // load-bearing lesson. The operand whose normalisation actually guards
  // against silent CORRUPTION is the LEAF permission test just below: it
  // already compares with `i32.eq` (`(pte & need) == need`) rather than
  // ANDing the raw `pte & need` in directly — with a raw `pte & 3`,
  // `bool1 & (pte & 3)` reduces to just the present bit whenever bool1==1,
  // so a store to a present-but-read-only COW page (`pte & 3 == 1`) would
  // read as truthy and take the fast arm, writing straight through to the
  // shared physical page instead of faulting into `do_wp_page`. See the
  // dedicated COW/mprotect unit tests for exactly that case.
  const emitCheckedPresentPredicate = (kind) => {
    // level 1 (unconditional): pgd_e = u32[ pt_base + (ea>>>22)<<2 ]
    out.push(0x23, ...u(ptBaseGlobal)); // global.get pt_base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(22), 0x76); // >>> 22
    out.push(0x41, ...s(2), 0x74); // << 2
    out.push(0x6a); // add
    out.push(0x28, 0x02, ...u(0)); // i32.load -> pgd_e (RAW)
    out.push(0x22, ...u(PGD_E)); // local.tee pgd_e (keep a copy on stack)
    out.push(0x41, ...s(0)); // i32.const 0
    out.push(0x47); // i32.ne -> (pgd_e != 0)  [stack: bool1]
    // level 2 (unconditional — see the correctness note above): pte =
    // u32[ (pgd_e & ~0xfff) + ((ea>>>12 & 0x3ff)<<2) ]. Read pgd_e from the
    // LOCAL here — the stack currently holds bool1, not a reusable pgd_e copy.
    out.push(0x20, ...u(PGD_E)); // local.get pgd_e
    out.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> pte-table base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(12), 0x76); // >>> 12
    out.push(0x41, ...s(0x3ff), 0x71); // & 0x3ff
    out.push(0x41, ...s(2), 0x74); // << 2
    out.push(0x6a); // add
    out.push(0x28, 0x02, ...u(0)); // i32.load -> pte (RAW)
    out.push(0x22, ...u(PTE)); // local.tee pte (keep a copy on stack)
    // permission test, normalised to a 0/1 boolean via i32.eq (not the
    // negated i32.ne the old per-level branch used — this value is ANDed
    // straight into the combined predicate, not gating a fault branch on its
    // own). A LOAD needs only _PAGE_PRESENT (bit 0); a STORE/RMW needs
    // _PAGE_PRESENT|_PAGE_WRITE (bits 0+1) — the write-bit test on stores is
    // what makes COW and mprotect work: a copy-on-write page is mapped
    // present-but-read-only, so a store must take the slow/fault arm to
    // duplicate it via do_wp_page rather than walking through to the shared
    // physical page.
    if (kind === 1) {
      out.push(0x41, ...s(3), 0x71); // & 3 (present|write)
      out.push(0x41, ...s(3), 0x46); // i32.const 3 ; i32.eq -> (pte&3) == 3
    } else {
      out.push(0x41, ...s(1), 0x71); // & 1 (present)
      out.push(0x41, ...s(1), 0x46); // i32.const 1 ; i32.eq -> (pte&1) == 1
    }
    out.push(0x71); // i32.and -> bool1 & bool2 (both already 0/1 booleans)
  };

  // emitCheckedSplitLoad/Store (#202 §6.2): the CHECKED, non-helper,
  // width>=2 page-crossing case. Folds the page-crossing "does the whole
  // access fit in one page" test into the SAME combined predicate
  // `emitCheckedPresentPredicate` produces (one more ANDed conjunct), so
  // there is ONE `if`, not the present-check's block/loop/retry followed by
  // a SEPARATE page-crossing `if` the pre-#202 pass emitted. The slow arm
  // calls the byte-wise helper directly — it ALREADY present-checks (and
  // fault-in retries) EACH byte's page individually via the checked
  // `__mmu_translate_ck` (see loadBytesHelperBody/storeBytesHelperBody's use
  // of `emitTranslateCall`), so it correctly covers both reasons the fast
  // path can be rejected (not present, OR straddles a page) without this
  // caller needing to distinguish them.
  const emitCheckedSplitLoad = (op, W) => {
    emitCheckedPresentPredicate(0); // kind=0 read
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(0xfff), 0x71); // & 0xfff
    out.push(0x41, ...s(0x1000 - W), 0x4d); // <= (0x1000-W)  (i32.le_u)
    out.push(0x71); // AND into the combined predicate
    out.push(0x04, LOAD_RESVT[op]); // if (result <loadvt>)
    out.push(0x20, ...u(PTE)); // fast arm: phys from pte/ea
    out.push(0x41, ...s(-4096), 0x71);
    out.push(0x20, ...u(EA));
    out.push(0x41, ...s(0xfff), 0x71);
    out.push(0x6a); // -> phys
    out.push(op, 0x00, ...u(0)); // raw load, align 0 off 0
    out.push(0x05); // else
    out.push(0x20, ...u(EA), 0x41, ...s(W), 0x10, ...u(splitFns.loadBytes)); // -> i64
    out.push(...LOAD_POST[op]); // post-process to loadvt
    out.push(0x0b); // end if
  };
  const emitCheckedSplitStore = (op, W, vl) => {
    emitCheckedPresentPredicate(1); // kind=1 write
    out.push(0x20, ...u(EA));
    out.push(0x41, ...s(0xfff), 0x71);
    out.push(0x41, ...s(0x1000 - W), 0x4d);
    out.push(0x71); // AND into the combined predicate
    out.push(0x04, 0x40); // if (void)
    out.push(0x20, ...u(PTE)); // fast arm: phys from pte/ea
    out.push(0x41, ...s(-4096), 0x71);
    out.push(0x20, ...u(EA));
    out.push(0x41, ...s(0xfff), 0x71);
    out.push(0x6a); // -> phys
    out.push(0x20, ...u(vl)); // local.get val
    out.push(op, 0x00, ...u(0)); // raw store, align 0 off 0
    out.push(0x05); // else
    out.push(0x20, ...u(EA)); // ea
    out.push(0x20, ...u(vl)); // val (typed)
    out.push(...STORE_TOI64[op]); // -> i64
    out.push(0x41, ...s(W), 0x10, ...u(splitFns.storeBytes)); // store_bytes(ea,val,W)
    out.push(0x0b); // end if
  };

  i = localsEnd;
  while (i < code.length) {
    const op = code[i];
    const m = MEM_OPS[op];
    if (m) {
      let offset;
      let j = i + 1;
      [, j] = readU(code, j); // align hint — dropped (we access at natural width)
      [offset, j] = readU(code, j);
      if (m.k === "load") {
        // stack: va  ->  ea = va + offset (in $EA), then phys, then raw load
        if (offset !== 0) out.push(0x41, ...s(offset), 0x6a);
        out.push(0x21, ...u(EA)); // local.set ea
        const W = ACCESS_W[op];
        if (splitFns && W >= 2 && helper) {
          // #128 helper mode: a width>=2 access ALWAYS takes the byte-wise slow
          // path (correct for any straddle; no inline fast path so the already-
          // over-limit function stays compact). load_bytes(ea,W) -> i64, then
          // post-process into the op's result type.
          out.push(0x20, ...u(EA), 0x41, ...s(W), 0x10, ...u(splitFns.loadBytes));
          out.push(...LOAD_POST[op]);
        } else if (splitFns && W >= 2 && checked) {
          // #202 §6.2: CHECKED + page-crossing, non-helper — ONE combined
          // predicate (present+permission AND page-fits) instead of the A1
          // shape's separate page-crossing `if` wrapping a present-checked
          // `emitTranslate`. See emitCheckedSplitLoad's doc comment.
          emitCheckedSplitLoad(op, W);
        } else if (splitFns && W >= 2) {
          // #128 A1 (unchecked) inline mode — BYTE-IDENTICAL to before #202:
          // fast within-page path when the whole access fits in one page
          // ((ea&0xfff) <= 0x1000-W), else the byte-wise slow path that
          // translates each byte's page separately. Both leave the op's
          // result value on the stack (the `if`'s result type).
          out.push(0x20, ...u(EA), 0x41, ...s(0xfff), 0x71); // ea & 0xfff
          out.push(0x41, ...s(0x1000 - W), 0x4d); // <= (0x1000-W) (i32.le_u)
          out.push(0x04, LOAD_RESVT[op]); // if (result <loadvt>)
          emitTranslate(0); // -> phys (kind=0 load)
          out.push(op, 0x00, ...u(0)); // raw load, align 0 off 0
          out.push(0x05); // else
          out.push(0x20, ...u(EA), 0x41, ...s(W), 0x10, ...u(splitFns.loadBytes)); // -> i64
          out.push(...LOAD_POST[op]); // post-process to loadvt
          out.push(0x0b); // end if
        } else {
          emitTranslate(0); // -> phys (kind=0 load)
          out.push(op, 0x00, ...u(0)); // raw load, align 0 off 0
        }
      } else {
        // stack: va, value  ->  save value, ea, phys, value, raw store
        const vl = VAL[VALTYPE[m.n]];
        out.push(0x21, ...u(vl)); // local.set val
        if (offset !== 0) out.push(0x41, ...s(offset), 0x6a);
        out.push(0x21, ...u(EA)); // local.set ea
        const W = ACCESS_W[op];
        if (splitFns && W >= 2 && helper) {
          // #128 helper mode: width>=2 store ALWAYS byte-wise (see the load
          // branch). store_bytes(ea, val_as_i64, W) writes the low W bytes,
          // translating each byte's page (write-kind) separately.
          out.push(0x20, ...u(EA)); // ea
          out.push(0x20, ...u(vl)); // val (typed)
          out.push(...STORE_TOI64[op]); // -> i64
          out.push(0x41, ...s(W), 0x10, ...u(splitFns.storeBytes)); // store_bytes(ea,val,W)
        } else if (splitFns && W >= 2 && checked) {
          // #202 §6.2: CHECKED + page-crossing, non-helper — see
          // emitCheckedSplitStore's doc comment (mirrors the load case above).
          emitCheckedSplitStore(op, W, vl);
        } else if (splitFns && W >= 2) {
          // #128 A1 (unchecked) inline mode — BYTE-IDENTICAL to before #202:
          // fast within-page path else byte-wise slow path.
          out.push(0x20, ...u(EA), 0x41, ...s(0xfff), 0x71); // ea & 0xfff
          out.push(0x41, ...s(0x1000 - W), 0x4d); // <= (0x1000-W) (i32.le_u)
          out.push(0x04, 0x40); // if (void)
          emitTranslate(1); // -> phys (kind=1 store)
          out.push(0x20, ...u(vl)); // local.get val
          out.push(op, 0x00, ...u(0)); // raw store, align 0 off 0
          out.push(0x05); // else
          out.push(0x20, ...u(EA)); // ea
          out.push(0x20, ...u(vl)); // val (typed)
          out.push(...STORE_TOI64[op]); // -> i64
          out.push(0x41, ...s(W), 0x10, ...u(splitFns.storeBytes)); // store_bytes(ea,val,W)
          out.push(0x0b); // end if
        } else {
          emitTranslate(1); // -> phys (kind=1 store)
          out.push(0x20, ...u(vl)); // local.get val
          out.push(op, 0x00, ...u(0)); // raw store, align 0 off 0
        }
      }
      i = j;
      continue;
    }
    if (op === 0xfe) {
      // atomic op (0xfe prefix). fence (0x03) has no memarg → copy verbatim.
      let sub;
      let j = i + 1;
      [sub, j] = readU(code, j);
      const a = ATOMIC_OPS[sub];
      if (!a) {
        // atomic.fence or an unmodeled atomic — copy the whole instr verbatim.
        const next = skipInstr(code, i);
        out.pushBytes(code.subarray(i, next));
        i = next;
        continue;
      }
      let align, offset;
      [align, j] = readU(code, j);
      [offset, j] = readU(code, j);
      // stack: addr, [op0], [op1]  (op1 on top). Pop operands top-first into
      // scratch (slot 0 = VAL[type], slot 1 = B[type]).
      const scratch = a.opsAbove.map((tp, idx) => (idx === 0 ? VAL[tp] : B[tp]));
      for (let k = a.opsAbove.length - 1; k >= 0; k--) {
        out.push(0x21, ...u(scratch[k])); // local.set
      }
      // addr on top → ea = addr + offset
      if (offset !== 0) out.push(0x41, ...s(offset), 0x6a);
      out.push(0x21, ...u(EA)); // local.set ea
      emitTranslate(atomicFaultKind(sub)); // -> phys
      // restore operands in order
      for (let k = 0; k < a.opsAbove.length; k++) {
        out.push(0x20, ...u(scratch[k])); // local.get
      }
      // raw atomic at phys. Atomics REQUIRE natural alignment → keep the
      // ORIGINAL align (translate preserves it); offset folded into phys → 0.
      out.push(0xfe, ...u(sub), ...u(align), ...u(0));
      i = j;
      continue;
    }
    if (op === 0xfc && bulkFns) {
      // bulk memory ops write/read through USER addresses — route to the
      // page-chunked translate helpers (stack already holds the operands in
      // the helpers' exact param order). Everything else 0xfc (saturating
      // truncs, data.drop, table ops) copies verbatim.
      const [sub, at] = readU(code, i + 1);
      if (sub === 10) {
        out.push(0x10, ...u(bulkFns.memcpy)); // call __mmu_memcpy(d,s,n)
        i = skipInstr(code, i);
        continue;
      }
      if (sub === 11) {
        out.push(0x10, ...u(bulkFns.memfill)); // call __mmu_memfill(d,v,n)
        i = skipInstr(code, i);
        continue;
      }
      if (sub === 8) {
        const seg = readU(code, at)[0];
        out.push(0x10, ...u(bulkFns.meminit.get(seg))); // call __mmu_meminit_<seg>(d,s,n)
        i = skipInstr(code, i);
        continue;
      }
    }
    const next = skipInstr(code, i);
    out.pushBytes(code.subarray(i, next));
    i = next;
  }
  // #202: nothing to return — `out` IS the caller's shared sink (see the
  // `sink` param doc above); the caller measures what this call wrote via
  // `sink.len` before/after, not a return value.
}

// ---- module surgery ---------------------------------------------------------

function countImports(importBody, kind) {
  let i = 0;
  let n;
  [n, i] = readU(importBody, 0);
  let count = 0;
  for (let k = 0; k < n; k++) {
    let len;
    [len, i] = readU(importBody, i);
    i += len;
    [len, i] = readU(importBody, i);
    i += len;
    const ek = importBody[i++];
    if (ek === kind) count++;
    if (ek === 0x00) [, i] = readU(importBody, i);
    else if (ek === 0x01) {
      i++;
      const fl = importBody[i++];
      [, i] = readU(importBody, i);
      if (fl & 1) [, i] = readU(importBody, i);
    } else if (ek === 0x02) {
      const fl = importBody[i++];
      [, i] = readU(importBody, i);
      if (fl & 1) [, i] = readU(importBody, i);
    } else if (ek === 0x03) i += 2;
    else if (ek === 0x04) {
      // tag (exception) import: attribute byte + type index. Must advance past
      // both or the imported-function count (this feeds the defined-function
      // index base for renumbering) desyncs on any `-fwasm-exceptions` C++
      // binary (#152). Same encoding as parseImportsDetailed / kernel-worker.js.
      i++;
      [, i] = readU(importBody, i);
    }
  }
  return count;
}

/** Param count of every type in the type section (by type index). */
function typeParamCounts(typeBody) {
  if (!typeBody) return [];
  let i = 0;
  let n;
  [n, i] = readU(typeBody, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (typeBody[i++] !== 0x60) throw new Error("softmmu: bad functype");
    let np;
    [np, i] = readU(typeBody, i);
    out.push(np);
    i += np; // param valtypes
    let nr;
    [nr, i] = readU(typeBody, i);
    i += nr; // result valtypes
  }
  return out;
}

/** Defined-function type indices, in order. */
function definedFuncTypes(funcBody) {
  if (!funcBody) return [];
  let i = 0;
  let n;
  [n, i] = readU(funcBody, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    let t;
    [t, i] = readU(funcBody, i);
    out.push(t);
  }
  return out;
}

/**
 * Whole-module op scan: atomics/SIMD/bulk presence + the set of data-segment
 * indices used by memory.init (each gets a per-segment translate helper).
 */
export function scanUnhandled(bytes) {
  const secs = splitSections(bytes);
  const code = secs.find((x) => x.id === 10);
  if (!code) return { atomics: false, simd: false, bulk: false, initSegs: [] };
  let atomics = false;
  let simd = false;
  let bulk = false;
  const initSegs = new Set();
  const b = code.body;
  let i = 0;
  let n;
  [n, i] = readU(b, 0);
  for (let f = 0; f < n; f++) {
    let size;
    [size, i] = readU(b, i);
    const end = i + size;
    let j = i;
    let nl;
    [nl, j] = readU(b, j);
    for (let k = 0; k < nl; k++) {
      [, j] = readU(b, j);
      j++;
    }
    while (j < end) {
      const op = b[j];
      if (op === 0xfe) atomics = true;
      if (op === 0xfd) simd = true;
      if (op === 0xfc) {
        const [sub, at] = readU(b, j + 1);
        if (sub === 8) {
          bulk = true;
          initSegs.add(readU(b, at)[0]);
        } else if (sub === 10 || sub === 11) {
          bulk = true;
        }
      }
      try {
        j = skipInstr(b, j);
      } catch {
        j = end;
      }
    }
    i = end;
  }
  return { atomics, simd, bulk, initSegs: [...initSegs].sort((a, b2) => a - b2) };
}

// ---- bulk-memory translate helpers ------------------------------------------
//
// Bulk ops (memory.copy/fill/init) take USER addresses spanning pages whose
// physical backing is not contiguous, so they are lowered to page-chunked
// helpers: chunk = the largest run that stays inside one page on every
// translated operand, translate once per chunk via the appended $translate
// helper (a CALL is fine here — once per PAGE, not per access; the "inline
// the translate" rule is about per-access cost), then the RAW bulk op on
// physical addresses. memory.copy picks a BACKWARD chunk loop when the
// VIRTUAL ranges overlap with dest above src (wasm memory.copy is
// memmove-like; aliased physical mappings are the user's problem, exactly as
// on hardware).

const I = {
  block: 0x02,
  loop: 0x03,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  ret: 0x0f,
  call: 0x10,
  select: 0x1b,
  lget: 0x20,
  lset: 0x21,
  i32c: 0x41,
  eqz: 0x45,
  lt_u: 0x49,
  le_u: 0x4d,
  ge_u: 0x4f,
  add: 0x6a,
  sub: 0x6b,
  and: 0x71,
};
const VOID = 0x40;

// c = min(c, t) using select (locals c, t already set)
function emitMinCT(o, c, t) {
  o.push(
    I.lget,
    ...u(c),
    I.lget,
    ...u(t),
    I.lget,
    ...u(c),
    I.lget,
    ...u(t),
    I.lt_u,
    I.select,
    I.lset,
    ...u(c),
  );
}
// c = min(c, n)
function emitMinCN(o, c, n) {
  o.push(
    I.lget,
    ...u(c),
    I.lget,
    ...u(n),
    I.lget,
    ...u(c),
    I.lget,
    ...u(n),
    I.lt_u,
    I.select,
    I.lset,
    ...u(c),
  );
}
// t = PAGE - (x & 0xfff)   (forward chunk bound for operand x)
function emitFwdBound(o, x, dst) {
  o.push(I.i32c, ...s(4096), I.lget, ...u(x), I.i32c, ...s(0xfff), I.and, I.sub, I.lset, ...u(dst));
}
// t = ((x + n - 1) & 0xfff) + 1   (backward chunk bound)
function emitBwdBound(o, x, n, dst) {
  o.push(
    I.lget,
    ...u(x),
    I.lget,
    ...u(n),
    I.add,
    I.i32c,
    ...s(1),
    I.sub,
    I.i32c,
    ...s(0xfff),
    I.and,
    I.i32c,
    ...s(1),
    I.add,
    I.lset,
    ...u(dst),
  );
}

/**
 * Emit the call that turns a translated virtual address (already pushed on
 * the stack) into a physical one, for use inside a bulk-memory helper body.
 *
 * UNCHECKED (`ckFunc` nullish — the default): `call __mmu_translate(va)` —
 * byte-for-byte what these helpers emitted before the bulk ops were made
 * present-checked (A1 fast path, no fault-in).
 *
 * CHECKED (`ckFunc` given): push the access `kind` (0=read, 1=write — the
 * permission this chunk needs faulted in) and `call
 * __mmu_translate_ck(va, kind)` instead, so a not-present page underneath a
 * memory.copy/fill/init faults in with the CORRECT permission — exactly like
 * the inline scalar/atomic translate's present check — instead of silently
 * walking a zero PTE and landing on page 0.
 */
function emitTranslateCall(o, translateFunc, ckFunc, kind) {
  if (ckFunc != null) {
    o.push(I.i32c, ...s(kind), I.call, ...u(ckFunc));
  } else {
    o.push(I.call, ...u(translateFunc));
  }
}

/**
 * __mmu_memcpy(d,s,n) body — overlap-aware page-chunked memory.copy.
 *
 * @param {number} translateFunc the plain (unchecked) `__mmu_translate` helper
 * @param {number|null} [ckFunc] the checked `__mmu_translate_ck(va,kind)`
 *   helper — when given, dest chunks fault in with kind=1 (write) and src
 *   chunks with kind=0 (read); omit/null for the unchecked A1 fast path.
 */
function memcpyHelperBody(translateFunc, ckFunc = null) {
  const d = 0,
    sp = 1,
    n = 2,
    c = 3,
    t = 4;
  const o = [];
  o.push(...u(1), ...u(2), VT.i32); // locals: c, t
  // if (d > s && d < s + n) -> backward, else forward
  o.push(I.block, VOID); // A ($forward)
  o.push(I.lget, ...u(d), I.lget, ...u(sp), I.le_u, I.br_if, ...u(0)); // d <= s
  o.push(I.lget, ...u(d), I.lget, ...u(sp), I.lget, ...u(n), I.add, I.ge_u, I.br_if, ...u(0)); // d >= s+n
  //   backward chunk loop
  o.push(I.block, VOID, I.loop, VOID); // B, C
  o.push(I.lget, ...u(n), I.eqz, I.br_if, ...u(1)); // -> B
  emitBwdBound(o, d, n, c);
  emitBwdBound(o, sp, n, t);
  emitMinCT(o, c, t);
  emitMinCN(o, c, n);
  o.push(I.lget, ...u(n), I.lget, ...u(c), I.sub, I.lset, ...u(n)); // n -= c (chunk at base+n)
  o.push(I.lget, ...u(d), I.lget, ...u(n), I.add);
  emitTranslateCall(o, translateFunc, ckFunc, 1); // dest: write
  o.push(I.lget, ...u(sp), I.lget, ...u(n), I.add);
  emitTranslateCall(o, translateFunc, ckFunc, 0); // src: read
  o.push(I.lget, ...u(c));
  o.push(0xfc, 0x0a, 0x00, 0x00); // raw memory.copy
  o.push(I.br, ...u(0)); // -> C
  o.push(I.end, I.end); // C, B
  o.push(I.ret);
  o.push(I.end); // A
  // forward chunk loop
  o.push(I.block, VOID, I.loop, VOID); // D, E
  o.push(I.lget, ...u(n), I.eqz, I.br_if, ...u(1)); // -> D
  emitFwdBound(o, d, c);
  emitFwdBound(o, sp, t);
  emitMinCT(o, c, t);
  emitMinCN(o, c, n);
  o.push(I.lget, ...u(d));
  emitTranslateCall(o, translateFunc, ckFunc, 1); // dest: write
  o.push(I.lget, ...u(sp));
  emitTranslateCall(o, translateFunc, ckFunc, 0); // src: read
  o.push(I.lget, ...u(c));
  o.push(0xfc, 0x0a, 0x00, 0x00); // raw memory.copy
  o.push(I.lget, ...u(d), I.lget, ...u(c), I.add, I.lset, ...u(d));
  o.push(I.lget, ...u(sp), I.lget, ...u(c), I.add, I.lset, ...u(sp));
  o.push(I.lget, ...u(n), I.lget, ...u(c), I.sub, I.lset, ...u(n));
  o.push(I.br, ...u(0)); // -> E
  o.push(I.end, I.end); // E, D
  o.push(I.end); // function
  return o;
}

/**
 * __mmu_memfill(d,v,n) body.
 *
 * @param {number} translateFunc the plain (unchecked) `__mmu_translate` helper
 * @param {number|null} [ckFunc] the checked `__mmu_translate_ck(va,kind)`
 *   helper — when given, dest chunks fault in with kind=1 (write); omit/null
 *   for the unchecked A1 fast path.
 */
function memfillHelperBody(translateFunc, ckFunc = null) {
  const d = 0,
    v = 1,
    n = 2,
    c = 3;
  const o = [];
  o.push(...u(1), ...u(1), VT.i32); // local: c
  o.push(I.block, VOID, I.loop, VOID);
  o.push(I.lget, ...u(n), I.eqz, I.br_if, ...u(1));
  emitFwdBound(o, d, c);
  emitMinCN(o, c, n);
  o.push(I.lget, ...u(d));
  emitTranslateCall(o, translateFunc, ckFunc, 1); // dest: write
  o.push(I.lget, ...u(v), I.lget, ...u(c));
  o.push(0xfc, 0x0b, 0x00); // raw memory.fill
  o.push(I.lget, ...u(d), I.lget, ...u(c), I.add, I.lset, ...u(d));
  o.push(I.lget, ...u(n), I.lget, ...u(c), I.sub, I.lset, ...u(n));
  o.push(I.br, ...u(0));
  o.push(I.end, I.end, I.end);
  return o;
}

/**
 * __mmu_meminit_<seg>(d,s,n) body — s is an offset INTO segment (untranslated,
 * so only `d` is ever translated).
 *
 * @param {number} translateFunc the plain (unchecked) `__mmu_translate` helper
 * @param {number|null} ckFunc the checked `__mmu_translate_ck(va,kind)`
 *   helper — when given, dest chunks fault in with kind=1 (write); pass null
 *   for the unchecked A1 fast path.
 * @param {number} seg the data-segment index
 */
function meminitHelperBody(translateFunc, ckFunc, seg) {
  const d = 0,
    sp = 1,
    n = 2,
    c = 3;
  const o = [];
  o.push(...u(1), ...u(1), VT.i32); // local: c
  o.push(I.block, VOID, I.loop, VOID);
  o.push(I.lget, ...u(n), I.eqz, I.br_if, ...u(1));
  emitFwdBound(o, d, c);
  emitMinCN(o, c, n);
  o.push(I.lget, ...u(d));
  emitTranslateCall(o, translateFunc, ckFunc, 1); // dest: write
  o.push(I.lget, ...u(sp), I.lget, ...u(c));
  o.push(0xfc, 0x08, ...u(seg), 0x00); // raw memory.init <seg>
  o.push(I.lget, ...u(d), I.lget, ...u(c), I.add, I.lset, ...u(d));
  o.push(I.lget, ...u(sp), I.lget, ...u(c), I.add, I.lset, ...u(sp));
  o.push(I.lget, ...u(n), I.lget, ...u(c), I.sub, I.lset, ...u(n));
  o.push(I.br, ...u(0));
  o.push(I.end, I.end, I.end);
  return o;
}

/**
 * __mmu_load_bytes(ea, width) -> i64 — the PAGE-CROSSING slow path for loads.
 * Reads `width` bytes starting at virtual `ea`, translating EACH byte's page
 * separately (so a load straddling a page boundary reads the correct two
 * frames), and assembles them little-endian, zero-extended, into an i64. The
 * caller post-processes (wrap / reinterpret / sign-extend) per LOAD_POST. Uses
 * the checked translate when present (each byte's page can independently
 * demand-fault) else the plain one — same as the bulk helpers.
 *
 * @param {number} translateFunc plain `__mmu_translate(va)` index
 * @param {number|null} ckFunc checked `__mmu_translate_ck(va,kind)` index (or null)
 */
function loadBytesHelperBody(translateFunc, ckFunc = null) {
  const EA = 0,
    W = 1,
    I = 2,
    RES = 3;
  const o = [];
  o.push(...u(2), ...u(1), VT.i32, ...u(1), VT.i64); // locals: i(i32), res(i64)
  o.push(0x42, 0x00, 0x21, ...u(RES)); // res = 0
  o.push(0x41, 0x00, 0x21, ...u(I)); // i = 0
  o.push(0x02, 0x40, 0x03, 0x40); // block $done ; loop $loop
  o.push(0x20, ...u(I), 0x20, ...u(W), 0x4f, 0x0d, ...u(1)); // if i>=width br $done
  o.push(0x20, ...u(EA), 0x20, ...u(I), 0x6a); // ea + i
  emitTranslateCall(o, translateFunc, ckFunc, 0); // -> phys (kind=0 read)
  o.push(0x2d, 0x00, 0x00); // i32.load8_u phys -> byte
  o.push(0xad); // i64.extend_i32_u -> (i64)byte
  o.push(0x20, ...u(I), 0xad, 0x42, 0x03, 0x86); // shiftAmt = (i64)i << 3
  o.push(0x86); // (i64)byte << shiftAmt
  o.push(0x20, ...u(RES), 0x84, 0x21, ...u(RES)); // res |= that
  o.push(0x20, ...u(I), 0x41, 0x01, 0x6a, 0x21, ...u(I)); // i++
  o.push(0x0c, ...u(0)); // br $loop
  o.push(0x0b, 0x0b); // end loop, end block
  o.push(0x20, ...u(RES)); // -> res
  o.push(0x0b); // end function
  return o;
}

/**
 * __mmu_store_bytes(ea, val, width) — the PAGE-CROSSING slow path for stores.
 * Writes the low `width` bytes of i64 `val` starting at virtual `ea`,
 * translating EACH byte's page separately with WRITE kind (so a store
 * straddling a page boundary writes the correct two frames AND each page
 * independently write-permission-checks / COW-faults). Caller converts the
 * typed value to i64 per STORE_TOI64 before the call.
 *
 * @param {number} translateFunc plain `__mmu_translate(va)` index
 * @param {number|null} ckFunc checked `__mmu_translate_ck(va,kind)` index (or null)
 */
function storeBytesHelperBody(translateFunc, ckFunc = null) {
  const EA = 0,
    VAL = 1,
    W = 2,
    I = 3;
  const o = [];
  o.push(...u(1), ...u(1), VT.i32); // local: i (i32)
  o.push(0x41, 0x00, 0x21, ...u(I)); // i = 0
  o.push(0x02, 0x40, 0x03, 0x40); // block $done ; loop $loop
  o.push(0x20, ...u(I), 0x20, ...u(W), 0x4f, 0x0d, ...u(1)); // if i>=width br $done
  o.push(0x20, ...u(EA), 0x20, ...u(I), 0x6a); // ea + i
  emitTranslateCall(o, translateFunc, ckFunc, 1); // -> phys (kind=1 write)
  o.push(0x20, ...u(VAL)); // val (i64)
  o.push(0x20, ...u(I), 0xad, 0x42, 0x03, 0x86); // shiftAmt = (i64)i << 3
  o.push(0x88); // val >> shiftAmt (i64.shr_u)
  o.push(0xa7); // i32.wrap_i64 -> byte (low 8 used)
  o.push(0x3a, 0x00, 0x00); // i32.store8 phys, byte
  o.push(0x20, ...u(I), 0x41, 0x01, 0x6a, 0x21, ...u(I)); // i++
  o.push(0x0c, ...u(0)); // br $loop
  o.push(0x0b, 0x0b); // end loop, end block
  o.push(0x0b); // end function
  return o;
}

/**
 * __mmu_translate_ck(va, kind) -> phys — the CHECKED counterpart to the plain
 * `__mmu_translate` helper (translateBody below), appended ONLY when
 * `checked: true`. Bulk-memory helpers (memcpy/memfill/meminit) call THIS
 * one per page-chunk instead of the plain helper so a memory.copy/fill/init
 * touching a not-present page faults in (with the right kind — see
 * `emitTranslateCall`) rather than walking a zero PTE. Same present-checked
 * two-level walk + retry-via-`br $retry` as the INLINE checked path in
 * `rewriteFuncBody`'s `emitTranslate`, just parameterized as a standalone
 * function (`va`/`kind` are params, not per-call-site locals+closures) since
 * bulk callers pass a fresh `(va, kind)` per page-chunk via `call`.
 *
 * @param {number} ptBaseGlobal the pt_base global index
 * @param {CheckedContext} checkedCtx
 */
function checkedTranslateBody(ptBaseGlobal, checkedCtx) {
  const VA = 0;
  const KIND = 1;
  const PGD_E = 2;
  const PTE = 3;
  const NEED = 4;
  const o = [];
  o.push(...u(1), ...u(3), VT.i32); // locals: pgd_e, pte, need (all i32)
  const emitFault = () => {
    if (checkedCtx.faultTableIndex != null) {
      o.push(0x20, ...u(VA)); // local.get va
      o.push(0x20, ...u(KIND)); // local.get kind
      o.push(0x41, ...s(checkedCtx.faultTableIndex)); // bridge table index
      o.push(0x11, ...u(Number(checkedCtx.faultTypeIdx)), ...u(0)); // call_indirect type, table 0
      o.push(0x1a); // drop syscall result
      return;
    }
    o.push(0x23, ...u(Number(checkedCtx.spGlobalIdx))); // global.get __stack_pointer
    o.push(0x10, ...u(Number(checkedCtx.tlsFuncIdx))); // call __get_tls_base -> tp
    o.push(0x41, ...s(NR_MMU_FAULT)); // i32.const NR_MMU_FAULT
    o.push(0x20, ...u(VA)); // local.get va
    o.push(0x20, ...u(KIND)); // local.get kind
    o.push(0x10, ...u(Number(checkedCtx.syscallFuncIdx))); // call __wasm_syscall_2
    o.push(0x1a); // drop
  };
  o.push(0x02, VT.i32); // block $done (result i32)
  o.push(0x03, 0x40); // loop $retry (void)
  // level 1: pgd_e = u32[ pt_base + (va>>>22)<<2 ]
  o.push(0x23, ...u(ptBaseGlobal)); // global.get pt_base
  o.push(0x20, ...u(VA)); // local.get va
  o.push(0x41, ...s(22), 0x76); // >>> 22
  o.push(0x41, ...s(2), 0x74); // << 2
  o.push(0x6a); // add
  o.push(0x28, 0x02, ...u(0)); // i32.load -> pgd_e (RAW)
  o.push(0x22, ...u(PGD_E)); // local.tee pgd_e
  // LEVEL-1 present test is "entry != 0" (bare pte-page phys, no flags) — see
  // the inline emitTranslate for the full rationale. Only the leaf pte tests
  // bit 0.
  o.push(0x45); // i32.eqz -> pgd_e == 0 ("not present")
  o.push(0x04, 0x40); // if (void)
  emitFault();
  o.push(0x0c, ...u(1)); // br $retry
  o.push(0x0b); // end if
  // level 2: pte = u32[ (pgd_e & ~0xfff) + ((va>>>12 & 0x3ff)<<2) ]
  o.push(0x20, ...u(PGD_E)); // local.get pgd_e
  o.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> pte-table base
  o.push(0x20, ...u(VA)); // local.get va
  o.push(0x41, ...s(12), 0x76); // >>> 12
  o.push(0x41, ...s(0x3ff), 0x71); // & 0x3ff
  o.push(0x41, ...s(2), 0x74); // << 2
  o.push(0x6a); // add
  o.push(0x28, 0x02, ...u(0)); // i32.load -> pte (RAW)
  o.push(0x21, ...u(PTE)); // local.set pte
  // LEAF present/permission test, kind-dependent (kind is a runtime param here,
  // so compute the required-bit mask): a LOAD needs _PAGE_PRESENT (bit 0); a
  // STORE needs _PAGE_PRESENT|_PAGE_WRITE (bits 0+1). need = 1 | (kind<<1) →
  // load:1, store:3. Fault if (pte & need) != need. The write-bit test on
  // stores is what makes COW/mprotect work through the bulk path too (a
  // memcpy/memset dest chunk landing on a COW page write-faults + duplicates).
  o.push(0x20, ...u(KIND)); // local.get kind
  o.push(0x41, ...s(1), 0x74); // i32.const 1 ; i32.shl -> kind<<1
  o.push(0x41, ...s(1), 0x72); // i32.const 1 ; i32.or  -> need
  o.push(0x21, ...u(NEED)); // local.set need
  o.push(0x20, ...u(PTE)); // local.get pte
  o.push(0x20, ...u(NEED)); // local.get need
  o.push(0x71); // i32.and -> pte & need
  o.push(0x20, ...u(NEED)); // local.get need
  o.push(0x47); // i32.ne -> (pte & need) != need
  o.push(0x04, 0x40); // if (void)
  emitFault();
  o.push(0x0c, ...u(1)); // br $retry
  o.push(0x0b); // end if
  // phys = (pte & ~0xfff) + (va & 0xfff); exit with it as $done's result.
  o.push(0x20, ...u(PTE)); // local.get pte
  o.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> page base
  o.push(0x20, ...u(VA)); // local.get va
  o.push(0x41, ...s(0xfff), 0x71); // & 0xfff
  o.push(0x6a); // add -> phys
  o.push(0x0c, ...u(1)); // br $done (carries phys out of the loop+block)
  o.push(0x0b); // end loop (always exited via a br — see rewriteFuncBody's
  // identical comment on the inline checked path for why the trailing
  // `unreachable` is needed for wasm validation)
  o.push(0x00); // unreachable
  o.push(0x0b); // end block -> phys left on the value stack
  o.push(0x0b); // end function
  return o;
}

/**
 * True iff `bytes` is ALREADY a softmmu-instrumented module — an instrumented
 * image always exports `__mmu_pt_base` (`__mmu_start` exists only when the
 * input had a start section). Used by the engine's
 * instrument-on-load path to avoid double-instrumenting a pre-instrumented
 * binary (e.g. a test fixture). Scans only the export section; no full decode.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isInstrumented(bytes) {
  if (bytes[0] !== 0 || bytes[1] !== 0x61) return false;
  let i = 8;
  while (i < bytes.length) {
    const id = bytes[i++];
    let sz;
    [sz, i] = readU(bytes, i);
    if (id !== 7) {
      i += sz;
      continue;
    }
    let n;
    let j = i;
    [n, j] = readU(bytes, j);
    for (let k = 0; k < n; k++) {
      let len;
      [len, j] = readU(bytes, j);
      const name = new TextDecoder().decode(bytes.subarray(j, j + len));
      if (name === "__mmu_pt_base") return true;
      j += len;
      j++; // export kind
      [, j] = readU(bytes, j); // export index
    }
    return false;
  }
  return false;
}

/** #152 diagnostic: the wasm "name" custom-section module name, or null. */
function moduleName(bytes) {
  try {
    for (const s of splitSections(bytes)) {
      if (s.id !== 0) continue; // custom section
      let i, nm;
      [nm, i] = readName(s.body, 0);
      if (nm !== "name") continue;
      while (i < s.body.length) {
        const sub = s.body[i++];
        let sz;
        [sz, i] = readU(s.body, i);
        if (sub === 0) return readName(s.body, i)[0]; // module-name subsection
        i += sz;
      }
    }
  } catch {
    /* best-effort diagnostic only */
  }
  return null;
}

/**
 * Instrument a wasm module with the inlined software-MMU translate.
 *
 * @param {Uint8Array} bytes
 * @param {{
 *   exportControls?: boolean,
 *   checked?: boolean,
 *   forceHelper?: boolean,
 *   inlineLimit?: number,
 *   faultTableIndex?: number,
 * }} [opts]
 *   `faultTableIndex` selects the side-module checked-mode contract: invoke an
 *   embedder-installed `(i32,i32)->i32` fault bridge through table 0 instead
 *   of requiring syscall/SP/TLS imports in this module.
 *   `inlineLimit` (#164): the byte size above which a function's inline
 *   instrumentation is replaced by the helper-call translate (default 6 MiB,
 *   safely below V8's kV8MaxWasmFunctionSize). Lower it in tests to force the
 *   fallback on small functions.
 *   `forceHelper`: emit every function through the helper-call path directly,
 *   without first materialising its inline form. This bounds transformation
 *   and V8 code memory for very large executables such as clang and wasm-ld.
 * @returns {Uint8Array}
 */
export function instrument(bytes, opts = {}) {
  const unhandled = scanUnhandled(bytes);
  if (unhandled.simd) throw new Error("softmmu: module uses SIMD memory ops (unhandled)");
  // atomics ARE translated (ATOMIC_OPS / the 0xfe path in rewriteFuncBody).

  const secs = splitSections(bytes);
  const byId = (id) => secs.find((x) => x.id === id);
  const importSec = byId(2);
  const typeSec = byId(1);
  const funcSec = byId(3);
  const globalSec = byId(6);
  const codeSec = byId(10);
  const startSec = byId(8);
  if (!codeSec) throw new Error("softmmu: no code section");

  // A2 present-check context (null -> every rewritten function stays on the
  // A1 unchecked fast path, byte-identical to before A2 existed).
  // #152 diagnostic: augment a checked-import failure with the module's byte
  // size + name-section module name, so a boot failure says WHETHER the
  // offending binary is a tiny generated module (FFI trampoline / dlopen side
  // module — a few hundred bytes) or a real program (KiB+). That discriminates
  // "a non-libc generated module reached the exec/instrument path" from "a real
  // program lost its keep-alive import".
  /** @type {CheckedContext|null} */
  let checkedCtx;
  try {
    checkedCtx = opts.checked
      ? opts.faultTableIndex != null
        ? { faultTableIndex: opts.faultTableIndex }
        : resolveCheckedImports(importSec, typeSec, byId(7))
      : null;
  } catch (e) {
    if (e instanceof Error) {
      e.message += ` [binary: ${bytes.length} bytes, module="${moduleName(bytes) ?? "?"}"]`;
    }
    throw e;
  }
  // The wasm START function (__wasm_init_memory under --shared-memory) runs
  // DURING instantiation — before the embedder can set __mmu_pt_base — so its
  // (translated) memory.init/stores would walk a zero table and place data at
  // garbage physical addresses. Strip the start section and re-export the
  // function as __mmu_start: the embedder sets pt_base, THEN calls it (the
  // same manual-startup pattern as __wasm_apply_data_relocs).
  const startFunc = startSec ? readU(startSec.body, 0)[0] : null;

  const nImpFuncs = importSec ? countImports(importSec.body, 0) : 0;
  const nImpGlobals = importSec ? countImports(importSec.body, 3) : 0;
  const paramCounts = typeParamCounts(typeSec ? typeSec.body : null);
  const defTypes = definedFuncTypes(funcSec ? funcSec.body : null);
  const nTypes = paramCounts.length;
  const nDefFuncs = defTypes.length;
  const nDefGlobals = globalSec ? readU(globalSec.body, 0)[0] : 0;

  const ptBaseGlobal = nImpGlobals + nDefGlobals; // appended global's index

  // Appended functions: the translate helper (type (i32)->i32 at nTypes), then
  // the bulk-memory helpers (type (i32,i32,i32)->() at nTypes+1): __mmu_memcpy,
  // __mmu_memfill, one __mmu_meminit per memory.init'd data segment. When
  // checked, ONE more function is appended AFTER all of the above: the
  // checked translate helper `__mmu_translate_ck(va,kind)->phys` (type
  // (i32,i32)->i32 at nTypes+2) that the bulk helpers call instead of the
  // plain one, so a bulk op's page-chunk present-faults with the right kind
  // (see `emitTranslateCall`). Placing it AFTER the existing appended set
  // keeps every unchecked index formula below untouched.
  const translateType = nTypes;
  const bulkType = nTypes + 1;
  const checkedTranslateType = nTypes + 2;
  if (checkedCtx && checkedCtx.faultTableIndex != null) {
    checkedCtx.faultTypeIdx = checkedTranslateType;
  }
  const translateFunc = nImpFuncs + nDefFuncs;
  const bulkFns = {
    memcpy: translateFunc + 1,
    memfill: translateFunc + 2,
    meminit: new Map(unhandled.initSegs.map((seg, k) => [seg, translateFunc + 3 + k])),
  };
  const nAppended = 2 + unhandled.initSegs.length; // memcpy + memfill + per-seg meminit (translate counted separately)
  const checkedTranslateFunc = checkedCtx ? translateFunc + 1 + nAppended : null;
  // #202 §6.2: the INLINE checked translate's combined-predicate fast path
  // (rewriteFuncBody's emitTranslate) calls this SAME appended function as its
  // out-of-line "slow" (fault+retry) arm — see the field doc where it's read.
  if (checkedCtx) checkedCtx.checkedTranslateFunc = checkedTranslateFunc;

  // #128 PAGE-CROSSING byte-wise slow-path helpers, appended AFTER the checked
  // translate (or after the bulk set when unchecked) so every existing index
  // formula above stays untouched. Two new types: (i32,i32)->i64 for load_bytes
  // and (i32,i64,i32)->() for store_bytes.
  const splitBase = translateFunc + 1 + nAppended + (checkedCtx ? 1 : 0);
  const splitFns = { loadBytes: splitBase, storeBytes: splitBase + 1 };
  const loadBytesType = nTypes + 2 + (checkedCtx ? 1 : 0);
  const storeBytesType = loadBytesType + 1;

  // --- rewrite each defined function body inline -----------------------------
  // #164: the inline translate expands each access ~4-10× — a large, memory-op-
  // dense function (seen in nix.wasm: one function inflated to 23 MB) can exceed
  // V8's per-function limit (kV8MaxWasmFunctionSize = 7,654,321 B) and refuse to
  // compile(). For any function whose inline body crosses `inlineLimit`, re-emit
  // it with the HELPER-CALL translate (`__mmu_translate`/`_ck`) — same walk, a
  // call instead of an inline block, so the body shrinks well under the ceiling.
  // Every other function keeps the measured-fast inline path. `opts.inlineLimit`
  // (default 6 MiB, safely below V8's ceiling) is overridable for unit tests.
  const inlineLimit = opts.inlineLimit ?? 6_000_000;
  const helperFns = { translateFunc, checkedTranslateFunc };
  let needsNoInlineHelpers = !!opts.forceHelper;
  const cb = codeSec.body;
  const nCode = readU(cb, 0)[0];

  // append the translate helper body (RAW loads — it IS the translate):
  //   translate(va): pt_base + ((u32[pt_base + (va>>>12<<2)]) not inlined here)
  const translateBody = [
    ...u(0), // no locals — same TWO-LEVEL walk as the inline path
    0x23,
    ...u(ptBaseGlobal), // global.get pt_base
    0x20,
    ...u(0), // local.get va
    0x41,
    ...s(22),
    0x76, // >>> 22
    0x41,
    ...s(2),
    0x74, // << 2
    0x6a, // +
    0x28,
    0x02,
    ...u(0), // i32.load pgd_e
    0x41,
    ...s(-4096),
    0x71, // & ~0xfff
    0x20,
    ...u(0), // local.get va
    0x41,
    ...s(12),
    0x76, // >>> 12
    0x41,
    ...s(0x3ff),
    0x71, // & 0x3ff
    0x41,
    ...s(2),
    0x74, // << 2
    0x6a, // +
    0x28,
    0x02,
    ...u(0), // i32.load pte
    0x41,
    ...s(-4096),
    0x71, // & ~0xfff
    0x20,
    ...u(0), // local.get va
    0x41,
    ...s(0xfff),
    0x71, // & 0xfff
    0x6a, // +
    0x0b,
  ];

  // #202: the code section used to be assembled via TWO extra whole-module
  // copies — `newCodeEntries` (one length-prefixed Uint8Array per function,
  // via `concatBytes`) and then `newCodeBody = concatBytes(newCodeEntries)`.
  // Both are gone: `emitCodeSectionBody` streams the function-count vector,
  // every rewritten function body, and every appended helper body DIRECTLY
  // into the caller's shared whole-module `ByteSink` (see the final assembly
  // below), so the code section — by far the largest part of a real guest
  // binary — now exists as bytes exactly ONCE (inside that one sink), not
  // three times over. `sink` is the SAME sink the rest of the module streams
  // into; this function does not allocate a section-sized buffer of its own.
  const emitCodeSectionBody = (sink) => {
    // function-count vector: fully known BEFORE any function is written (nCode
    // from the original module + the fixed appended-helper count), so it stays
    // a plain MINIMAL LEB — no backpatch needed (unlike the two fields below).
    sink.push(...u(nCode + 1 + nAppended + (checkedCtx ? 1 : 0) + 2)); // +2: load_bytes/store_bytes
    let ci = 0;
    [, ci] = readU(cb, 0); // skip the original function-count field (== nCode)
    for (let f = 0; f < nCode; f++) {
      let size;
      [size, ci] = readU(cb, ci);
      const body = cb.subarray(ci, ci + size);
      ci += size;
      const numParams = paramCounts[defTypes[f]] ?? 0;

      // Padded backpatch: this function's rewritten byte length is unknown
      // until it has been fully emitted (and, on overflow, re-emitted via the
      // helper fallback), so reserve the field, write, then patch — the SAME
      // pattern #164's "measure then decide" used, just without a second
      // whole-body copy to measure from (see the ByteSink doc comment).
      const sizeOff = sink.reserve(5);
      const bodyStart = sink.len;
      if (opts.forceHelper) {
        rewriteFuncBody(
          body,
          numParams,
          ptBaseGlobal,
          bulkFns,
          checkedCtx,
          helperFns,
          splitFns,
          sink,
        );
      } else {
        rewriteFuncBody(body, numParams, ptBaseGlobal, bulkFns, checkedCtx, null, splitFns, sink);
      }
      let bodyLen = sink.len - bodyStart;
      if (!opts.forceHelper && bodyLen > inlineLimit) {
        // Discard the inline attempt (truncate back to just past the reserved
        // size field) and re-emit via the helper-call translate into the SAME
        // sink at the SAME offset — semantically identical to the old
        // "build both, keep the smaller", but the discarded inline bytes were
        // never materialised as their own retained copy.
        sink.len = bodyStart;
        needsNoInlineHelpers = true;
        rewriteFuncBody(
          body,
          numParams,
          ptBaseGlobal,
          bulkFns,
          checkedCtx,
          helperFns,
          splitFns,
          sink,
        );
        const viaHelperLen = sink.len - bodyStart;
        // Not a silent cap (per #128's boot-debuggability ethos): announce the
        // fallback + both sizes so a boot log shows exactly which function and why.
        // eslint-disable-next-line no-console
        console.warn(
          `softmmu: function #${f} inline body ${bodyLen}B ` +
            `exceeds ${inlineLimit}B — using helper-call translate (${viaHelperLen}B) to stay under V8's max function size`,
        );
        bodyLen = viaHelperLen;
      }
      sink.patch5(sizeOff, bodyLen);
    }
    // Appended helper bodies: each one's length is fully known BEFORE it is
    // written (no retry possible — these are fixed, hand-built bodies), so
    // they keep the plain minimal-LEB length-prefix form, unchanged from
    // before #202.
    let noInlinePadding;
    const appendFixed = (body, noInline = false) => {
      if (!noInline || !needsNoInlineHelpers) {
        sink.push(...u(body.length));
        sink.pushBytes(body);
        return;
      }
      if (body.length === 0 || body[body.length - 1] !== 0x0b) {
        throw new Error("softmmu: helper body is missing its final end opcode");
      }
      noInlinePadding ??= new Uint8Array(SOFTMMU_HELPER_NOINLINE_PADDING_BYTES).fill(
        0x01, // nop
      );
      sink.push(...u(body.length + noInlinePadding.length));
      sink.pushBytes(body.slice(0, -1));
      sink.pushBytes(noInlinePadding);
      sink.push(0x0b);
    };
    appendFixed(translateBody, true);
    appendFixed(memcpyHelperBody(translateFunc, checkedTranslateFunc), true);
    appendFixed(memfillHelperBody(translateFunc, checkedTranslateFunc), true);
    for (const seg of unhandled.initSegs) {
      // One helper per data segment (clang has ~18k): keep these compact. Each
      // still calls the padded translate helper, so nested translate inlining
      // cannot recreate the per-access expansion this guard prevents.
      appendFixed(meminitHelperBody(translateFunc, checkedTranslateFunc, seg));
    }
    if (checkedCtx) {
      appendFixed(checkedTranslateBody(ptBaseGlobal, checkedCtx), true);
    }
    // #128 PAGE-CROSSING byte-wise slow-path helpers (appended last, after the
    // checked translate). Each translates every byte's page separately.
    appendFixed(loadBytesHelperBody(translateFunc, checkedTranslateFunc), true);
    appendFixed(storeBytesHelperBody(translateFunc, checkedTranslateFunc), true);
  };

  // --- type section: append (i32)->i32, (i32,i32,i32)->(), and (checked
  // only) (i32,i32)->i32 -------------------------------------------------
  const typeExistingTail = typeSec ? typeSec.body.subarray(u(nTypes).length) : [];
  const newTypeBody = [
    ...u(nTypes + 2 + (checkedCtx ? 1 : 0) + 2), // +2: load_bytes/store_bytes types
    ...typeExistingTail,
    0x60,
    ...u(1),
    VT.i32,
    ...u(1),
    VT.i32, // (i32)->i32: translate
    0x60,
    ...u(3),
    VT.i32,
    VT.i32,
    VT.i32,
    ...u(0), // (i32,i32,i32)->(): bulk helpers
    ...(checkedCtx
      ? [
          0x60,
          ...u(2),
          VT.i32,
          VT.i32,
          ...u(1),
          VT.i32, // (i32,i32)->i32: checked translate (va,kind)->phys
        ]
      : []),
    // #128 page-crossing byte helpers:
    0x60,
    ...u(2),
    VT.i32,
    VT.i32,
    ...u(1),
    VT.i64, // (i32,i32)->i64: __mmu_load_bytes(ea,width)
    0x60,
    ...u(3),
    VT.i32,
    VT.i64,
    VT.i32,
    ...u(0), // (i32,i64,i32)->(): __mmu_store_bytes(ea,val,width)
  ];

  // --- function section: append the translate helper's type index, then the
  // bulk helpers', then (checked only) the checked translate helper's -------
  const funcExistingTail = funcSec ? funcSec.body.subarray(u(nDefFuncs).length) : [];
  const newFuncBody = [
    ...u(nDefFuncs + 1 + nAppended + (checkedCtx ? 1 : 0) + 2), // +2: load_bytes/store_bytes
    ...funcExistingTail,
    ...u(translateType),
    ...Array.from({ length: nAppended }, () => u(bulkType)).flat(),
    ...(checkedCtx ? u(checkedTranslateType) : []),
    ...u(loadBytesType), // #128 __mmu_load_bytes
    ...u(storeBytesType), // #128 __mmu_store_bytes
  ];

  // --- global section: append pt_base (i32 mutable, init 0) -------------------
  const globalExistingTail = globalSec ? globalSec.body.subarray(u(nDefGlobals).length) : [];
  const newGlobalBody = [
    ...u(nDefGlobals + 1),
    ...globalExistingTail,
    VT.i32,
    0x01,
    0x41,
    ...s(0),
    0x0b,
  ];

  // --- export section (optional) ---------------------------------------------
  // __mmu_pt_base and __mmu_start are ALWAYS exported — an instrumented image
  // is only runnable if the embedder can set the table root and then run the
  // (stripped) start function. __mmu_translate (and, when checked,
  // __mmu_translate_ck) are the optional introspection controls.
  const exSec = byId(7);
  const nEx = exSec ? readU(exSec.body, 0)[0] : 0;
  const exTail = exSec ? exSec.body.subarray(u(nEx).length) : [];
  const nb = (str) => vec([...str].map((c) => c.charCodeAt(0)));
  const adds = [
    [...nb("__mmu_pt_base"), 0x03, ...u(ptBaseGlobal)],
    ...(startFunc !== null ? [[...nb("__mmu_start"), 0x00, ...u(startFunc)]] : []),
    ...(opts.exportControls ? [[...nb("__mmu_translate"), 0x00, ...u(translateFunc)]] : []),
    ...(opts.exportControls && checkedCtx
      ? [[...nb("__mmu_translate_ck"), 0x00, ...u(checkedTranslateFunc)]]
      : []),
  ];
  const newExportBody = [...u(nEx + adds.length), ...exTail, ...adds.flat()];

  // --- reassemble (insert sections that were absent, in canonical order) -----
  // Section bodies are number[] except the code section, which is represented
  // by the CODE_SECTION_STREAM sentinel — its real bytes are never assembled
  // as a standalone value at all (see the final assembly below and the
  // ByteSink doc comment for why: #202 streams it directly into the shared
  // output sink instead of building a separate whole-section copy first).
  const CODE_SECTION_STREAM = Symbol("softmmu:code-section-stream");
  /** @type {Map<number, number[]|Uint8Array|typeof CODE_SECTION_STREAM>} */
  const replaced = new Map();
  replaced.set(1, newTypeBody);
  replaced.set(3, newFuncBody);
  replaced.set(6, newGlobalBody);
  replaced.set(10, CODE_SECTION_STREAM);
  if (newExportBody) replaced.set(7, newExportBody);
  const present = new Set(secs.map((x) => x.id));

  const outSecs = [];
  const emitMissingBefore = (id) => {
    for (const nid of [1, 3, 6, 7, 10]) {
      if (nid < id && !present.has(nid) && replaced.has(nid)) {
        outSecs.push({ id: nid, body: replaced.get(nid) });
        present.add(nid);
      }
    }
  };
  for (const sec of secs) {
    if (sec.id === 8 && startFunc !== null) continue; // start stripped -> __mmu_start
    if (sec.id !== 0) emitMissingBefore(sec.id);
    outSecs.push(replaced.has(sec.id) ? { id: sec.id, body: replaced.get(sec.id) } : sec);
  }
  emitMissingBefore(11);

  // #202: stream the WHOLE module into one growable ByteSink, instead of
  // building a `parts` array of section-sized Uint8Arrays and copying them
  // all into a final `bytesOut` at the end. Every section's outer size field
  // uses the padded/backpatch form uniformly (reserve 5, write the body,
  // patch) — for the small sections the body length is already known, so
  // this is a trivial reserve-then-immediately-known-value patch; only the
  // code section's write in between is genuinely streamed (see
  // `emitCodeSectionBody`). Pre-size the sink from the measured expansion
  // ratio (busybox/nix-wasm: 5.4-6.9×, #202 §6.1) so it doesn't have to
  // double-and-copy its own backing store on the way there.
  const out = new ByteSink(Math.max(bytes.length * 7, 1 << 16));
  out.pushBytes([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  for (const sec of outSecs) {
    out.push(sec.id);
    const szOff = out.reserve(5);
    const bodyStart = out.len;
    if (sec.body === CODE_SECTION_STREAM) {
      emitCodeSectionBody(out);
    } else {
      out.pushBytes(sec.body);
    }
    out.patch5(szOff, out.len - bodyStart);
  }
  return out.toUint8Array();
}
