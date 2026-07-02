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
// CONTRACT CHOICE (documented per the task): `checked: true` REQUIRES the
// module to already import `__wasm_syscall_2` (type `(i32,i32,i32,i32,i32)
// -> i32`) plus the `__stack_pointer`/`__tls_base` globals, and THROWS a
// clear error if any are absent, rather than splicing a new function import
// into the module. Splicing a function import would shift every existing
// defined-function index by one everywhere a `call`/`call_indirect`/
// `ref.func`/element-segment/export refers to a function by index — a
// whole-module renumbering pass, for an import that (per the ABI note
// above) every real checked-mode target already carries. REQUIRE is the
// correct simpler contract: it matches reality (every musl-linked guest
// binary imports these three already) and keeps the module surgery in this
// pass limited to APPENDING (types/funcs/globals/exports), which is the
// invariant the rest of `instrument()` already relies on.
export const NR_MMU_FAULT = 244; // __NR_arch_specific_syscall (asm-generic/unistd.h)

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
 * Resolve + validate the three imports `checked: true` requires. Throws a
 * clear, specific error (never silently degrades to unchecked) when any is
 * missing or has an unexpected signature.
 *
 * @param {{id:number, body:Uint8Array}|undefined} importSec
 * @param {{id:number, body:Uint8Array}|undefined} typeSec
 * @param {{id:number, body:Uint8Array}|undefined} exportSec
 * @returns {{syscallFuncIdx:number, spGlobalIdx:number, tlsFuncIdx:number}}
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
    throw new Error(
      'softmmu: checked mode requires the module to import "__wasm_syscall_2" ' +
        "(musl's syscall2 host trap, used here to route NR_MMU_FAULT to the " +
        "kernel's fault handler) — every real guest binary that links libc " +
        "imports it; this module does not",
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

/** Index just past the instruction at `i` (opcode + immediates), non-recursing. */
function skipInstr(b, i) {
  const op = b[i++];
  switch (op) {
    case 0x02: // block
    case 0x03: // loop
    case 0x04: // if
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
        i++;
      } else {
        [, i] = readS(b, i);
      }
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
 * @param {{syscallFuncIdx:number, spGlobalIdx:number, tlsFuncIdx:number}|null} [checked]
 *   A2 present-check context (from `resolveCheckedImports`); omit/null for the
 *   default A1 unchecked fast path (byte-identical to before A2 existed).
 * @returns {number[]}
 */
export function rewriteFuncBody(code, numParams, ptBaseGlobal, bulkFns, checked = null) {
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

  const out = [];
  // new local-decl vec: existing 6 groups + 1 more (pgd_e+pte) when checked
  out.push(...u(nLocals + 6 + (checked ? 1 : 0)));
  for (let k = localsStart; k < localsEnd; k++) out.push(code[k]);
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
  // emitFaultCall(kind): __wasm_syscall_2(sp, tp, NR_MMU_FAULT, ea, kind),
  // result dropped (the retry loop re-walks rather than consuming a value).
  // Only valid when `checked` is set (resolveCheckedImports already verified
  // the import + its signature).
  const emitFaultCall = (kind) => {
    out.push(0x23, ...u(checked.spGlobalIdx)); // global.get __stack_pointer
    out.push(0x10, ...u(checked.tlsFuncIdx)); // call __get_tls_base -> tp
    out.push(0x41, ...s(NR_MMU_FAULT)); // i32.const NR_MMU_FAULT
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(kind)); // i32.const kind
    out.push(0x10, ...u(checked.syscallFuncIdx)); // call __wasm_syscall_2
    out.push(0x1a); // drop
  };

  // emitTranslate(kind): leaves `phys` (i32) on the stack from `ea` in $EA.
  // `kind` (0=load, 1=store/rmw/cmpxchg) is only used by the checked variant
  // (the fault's access-kind argument) — the unchecked fast path ignores it.
  //
  // UNCHECKED (default, checked===null): the A1 fast path — pure two-level
  // walk, no present check (byte-identical to the pre-A2 pass).
  //
  // CHECKED: the SAME two-level walk, but after each level's raw i32.load a
  // present-bit test (`entry & 1`) gates a `call __wasm_syscall_2(NR_MMU_FAULT,
  // ea, kind)` + RE-WALK (a `block $done (result i32) { loop $retry { … } }`:
  // a clear bit calls the fault handler then `br $retry`; present falls
  // through; the final phys computation `br $done`s out with the result). The
  // kernel's fault handler is expected to have made the entry present (or to
  // have delivered a fatal signal instead of returning) — the loop simply
  // re-reads, it does not bound the retry count, exactly like a hardware page
  // fault. Entries are held in $pgd_e/$pte locals (`local.tee`) so the
  // present-bit test can consume a copy while the raw value survives for the
  // next level / the final address computation.
  const emitTranslate = (kind) => {
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
    out.push(0x02, VT.i32); // block $done (result i32)
    out.push(0x03, 0x40); // loop $retry (void)
    // level 1: pgd_e = u32[ pt_base + (ea>>>22)<<2 ]
    out.push(0x23, ...u(ptBaseGlobal)); // global.get pt_base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(22), 0x76); // >>> 22
    out.push(0x41, ...s(2), 0x74); // << 2
    out.push(0x6a); // add
    out.push(0x28, 0x02, ...u(0)); // i32.load -> pgd_e (RAW)
    out.push(0x22, ...u(PGD_E)); // local.tee pgd_e (keep a copy on stack)
    // LEVEL-1 (PGD/PMD) present test is "entry != 0", NOT "bit 0 set". The
    // kernel's folded 2-level tables store the bare pte-page PHYSICAL address in
    // the pgd/pmd slot with NO flag bits (arch/wasm pgtable.h: pmd_present(pmd)
    // = pmd_val(pmd), pmd_none = !pmd_val, pmd_page_vaddr = pmd_val & PAGE_MASK).
    // Only the LEAF pte carries _PAGE_PRESENT in bit 0. Testing bit 0 here would
    // read a validly-populated pgd entry (e.g. 0x206ed000) as not-present and
    // fault forever. So the present bit lives at the leaf; the branch node is
    // present iff nonzero.
    out.push(0x45); // i32.eqz -> pgd_e == 0 ("not present")
    out.push(0x04, 0x40); // if (void)
    emitFaultCall(kind);
    out.push(0x0c, ...u(1)); // br $retry
    out.push(0x0b); // end if
    // level 2: pte = u32[ (pgd_e & ~0xfff) + ((ea>>>12 & 0x3ff)<<2) ]
    out.push(0x20, ...u(PGD_E)); // local.get pgd_e
    out.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> pte-table base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(12), 0x76); // >>> 12
    out.push(0x41, ...s(0x3ff), 0x71); // & 0x3ff
    out.push(0x41, ...s(2), 0x74); // << 2
    out.push(0x6a); // add
    out.push(0x28, 0x02, ...u(0)); // i32.load -> pte (RAW)
    out.push(0x22, ...u(PTE)); // local.tee pte (keep a copy on stack)
    // LEAF present/permission test. A LOAD needs only _PAGE_PRESENT (bit 0); a
    // STORE/RMW needs _PAGE_PRESENT|_PAGE_WRITE (bits 0+1). Testing the write
    // bit on stores is what makes COW and mprotect WORK: a copy-on-write page is
    // mapped present-but-read-only, so a store must FAULT (kind=1) into
    // do_wp_page/handle_mm_fault to duplicate it — otherwise the store would
    // walk straight through to the shared physical page and corrupt it. After
    // the kernel resolves the write fault it installs a writable PTE (bits 0+1),
    // so the re-walk passes.
    if (kind === 1) {
      out.push(0x41, ...s(3), 0x71); // & 3 (present|write)
      out.push(0x41, ...s(3), 0x47); // i32.const 3 ; i32.ne -> (pte&3) != 3
    } else {
      out.push(0x41, ...s(1), 0x71); // & 1 (present)
      out.push(0x45); // i32.eqz -> not present
    }
    out.push(0x04, 0x40); // if (void)
    emitFaultCall(kind);
    out.push(0x0c, ...u(1)); // br $retry
    out.push(0x0b); // end if
    // phys = (pte & ~0xfff) + (ea & 0xfff); exit with it as $done's result.
    out.push(0x20, ...u(PTE)); // local.get pte
    out.push(0x41, ...s(-4096), 0x71); // & ~0xfff -> page base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(0xfff), 0x71); // & 0xfff
    out.push(0x6a); // add -> phys
    out.push(0x0c, ...u(1)); // br $done (carries phys out of the loop+block)
    out.push(0x0b); // end loop
    // The loop is ALWAYS exited via one of the `br`s above (never falls off
    // the end), but wasm validation does not propagate that "unreachable"
    // fact past a nested construct's `end`: after the loop frame pops, the
    // $done block's OWN reachability is independent (it was reachable when
    // the loop was entered) and its `end` requires an actual i32 on the
    // stack. An explicit `unreachable` here (dead at runtime — every path
    // through the loop already branched out) satisfies that statically.
    out.push(0x00); // unreachable
    out.push(0x0b); // end block -> phys left on the value stack
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
        emitTranslate(0); // -> phys (kind=0 load)
        out.push(op, 0x00, ...u(0)); // raw load, align 0 off 0
      } else {
        // stack: va, value  ->  save value, ea, phys, value, raw store
        const vl = VAL[VALTYPE[m.n]];
        out.push(0x21, ...u(vl)); // local.set val
        if (offset !== 0) out.push(0x41, ...s(offset), 0x6a);
        out.push(0x21, ...u(EA)); // local.set ea
        emitTranslate(1); // -> phys (kind=1 store)
        out.push(0x20, ...u(vl)); // local.get val
        out.push(op, 0x00, ...u(0)); // raw store, align 0 off 0
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
        for (let k = i; k < next; k++) out.push(code[k]);
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
    for (let k = i; k < next; k++) out.push(code[k]);
    i = next;
  }
  return out;
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
 * @param {{syscallFuncIdx:number, spGlobalIdx:number, tlsFuncIdx:number}} checkedCtx
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
    o.push(0x23, ...u(checkedCtx.spGlobalIdx)); // global.get __stack_pointer
    o.push(0x10, ...u(checkedCtx.tlsFuncIdx)); // call __get_tls_base -> tp
    o.push(0x41, ...s(NR_MMU_FAULT)); // i32.const NR_MMU_FAULT
    o.push(0x20, ...u(VA)); // local.get va
    o.push(0x20, ...u(KIND)); // local.get kind
    o.push(0x10, ...u(checkedCtx.syscallFuncIdx)); // call __wasm_syscall_2
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
 * Instrument a wasm module with the inlined software-MMU translate.
 *
 * @param {Uint8Array} bytes
 * @param {{ exportControls?: boolean, checked?: boolean }} [opts]
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
  const checkedCtx = opts.checked ? resolveCheckedImports(importSec, typeSec, byId(7)) : null;

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
  const translateFunc = nImpFuncs + nDefFuncs;
  const bulkFns = {
    memcpy: translateFunc + 1,
    memfill: translateFunc + 2,
    meminit: new Map(unhandled.initSegs.map((seg, k) => [seg, translateFunc + 3 + k])),
  };
  const nAppended = 2 + unhandled.initSegs.length; // memcpy + memfill + per-seg meminit (translate counted separately)
  const checkedTranslateFunc = checkedCtx ? translateFunc + 1 + nAppended : null;

  // --- rewrite each defined function body inline -----------------------------
  const cb = codeSec.body;
  let ci = 0;
  let nCode;
  [nCode, ci] = readU(cb, 0);
  const newCodeEntries = [];
  for (let f = 0; f < nCode; f++) {
    let size;
    [size, ci] = readU(cb, ci);
    const body = cb.subarray(ci, ci + size);
    ci += size;
    const numParams = paramCounts[defTypes[f]] ?? 0;
    const rewritten = rewriteFuncBody(body, numParams, ptBaseGlobal, bulkFns, checkedCtx);
    newCodeEntries.push([...u(rewritten.length), ...rewritten]);
  }
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
  newCodeEntries.push([...u(translateBody.length), ...translateBody]);
  for (const body of [
    memcpyHelperBody(translateFunc, checkedTranslateFunc),
    memfillHelperBody(translateFunc, checkedTranslateFunc),
    ...unhandled.initSegs.map((seg) => meminitHelperBody(translateFunc, checkedTranslateFunc, seg)),
  ]) {
    newCodeEntries.push([...u(body.length), ...body]);
  }
  if (checkedCtx) {
    const ckBody = checkedTranslateBody(ptBaseGlobal, checkedCtx);
    newCodeEntries.push([...u(ckBody.length), ...ckBody]);
  }
  const newCodeBody = [
    ...u(nCode + 1 + nAppended + (checkedCtx ? 1 : 0)),
    ...newCodeEntries.flat(),
  ];

  // --- type section: append (i32)->i32, (i32,i32,i32)->(), and (checked
  // only) (i32,i32)->i32 -------------------------------------------------
  const typeExistingTail = typeSec ? typeSec.body.subarray(u(nTypes).length) : [];
  const newTypeBody = [
    ...u(nTypes + 2 + (checkedCtx ? 1 : 0)),
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
  ];

  // --- function section: append the translate helper's type index, then the
  // bulk helpers', then (checked only) the checked translate helper's -------
  const funcExistingTail = funcSec ? funcSec.body.subarray(u(nDefFuncs).length) : [];
  const newFuncBody = [
    ...u(nDefFuncs + 1 + nAppended + (checkedCtx ? 1 : 0)),
    ...funcExistingTail,
    ...u(translateType),
    ...Array.from({ length: nAppended }, () => u(bulkType)).flat(),
    ...(checkedCtx ? u(checkedTranslateType) : []),
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
  const replaced = new Map([
    [1, newTypeBody],
    [3, newFuncBody],
    [6, newGlobalBody],
    [10, newCodeBody],
  ]);
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

  // Assemble WITHOUT push(...spread): spreading a whole section's bytes as
  // call arguments blows V8's argument-count limit on large binaries (a full
  // musl-linked program is ~0.5 MB; the 22 KB test inits never tripped it).
  /** @type {Uint8Array[]} */
  const parts = [new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  for (const sec of outSecs) {
    parts.push(new Uint8Array([sec.id, ...u(sec.body.length)]));
    parts.push(sec.body instanceof Uint8Array ? sec.body : new Uint8Array(sec.body));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const bytesOut = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytesOut.set(p, off);
    off += p.length;
  }
  return bytesOut;
}
