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
//     ea   = va + memarg.offset                         ;; effective address
//     pte  = u32[ pt_base + (ea >>> 12) << 2 ]          ;; one raw page-table load
//     phys = pte + (ea & 0xfff)
//     <raw load/store at phys>                           ;; align 0, offset 0
// `pt_base` is a mutable global the kernel sets on every context switch (the
// current process's page-table root — a physical byte offset into the one shared
// Memory that is "RAM"). An identity page table (pte = page<<12) makes phys==ea,
// which is how the pass is correctness-tested + measured without a live kernel.
// The single-level table matches spikes/softmmu (which measured a software TLB
// makes it WORSE, so there is none).
//
// A translate HELPER function is still appended + exported (under exportControls)
// for the kernel's fault handler / introspection + the tests, but the hot path
// never calls it — it is inlined.
//
// WHAT IS EXEMPTED: the emitted page-table load + the appended helper use RAW
// (uninstrumented) access — they ARE the translate. The pass ABORTS LOUDLY on
// SIMD or atomic memory ops (each needs its own translate variant — a documented
// follow-up) rather than silently emitting an untranslated access.

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
const sect = (id, payload) => [id, ...u(payload.length), ...payload];

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
 * @returns {number[]}
 */
export function rewriteFuncBody(code, numParams, ptBaseGlobal) {
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
  //   base+0 ea (i32), base+1 val_i32 (i32), base+2 val_i64,
  //   base+3 val_f32, base+4 val_f64
  const base = numParams + existingLocalCount;
  const EA = base;
  const VAL = { i32: base + 1, i64: base + 2, f32: base + 3, f64: base + 4 };

  const out = [];
  // new local-decl vec: existing groups + 4 appended groups
  out.push(...u(nLocals + 4));
  for (let k = localsStart; k < localsEnd; k++) out.push(code[k]);
  out.push(...u(2), VT.i32); // ea + val_i32
  out.push(...u(1), VT.i64);
  out.push(...u(1), VT.f32);
  out.push(...u(1), VT.f64);

  // emit the inline translate producing `phys` on the stack from `ea` in $EA.
  const emitTranslate = () => {
    out.push(0x23, ...u(ptBaseGlobal)); // global.get pt_base
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(12), 0x76); // i32.const 12 ; i32.shr_u  -> page
    out.push(0x41, ...s(2), 0x74); // i32.const 2 ; i32.shl      -> page*4
    out.push(0x6a); // i32.add -> pt_base + page*4
    out.push(0x28, 0x02, ...u(0)); // i32.load align=2 off=0 -> pte (RAW)
    out.push(0x20, ...u(EA)); // local.get ea
    out.push(0x41, ...s(0xfff), 0x71); // i32.const 0xfff ; i32.and
    out.push(0x6a); // i32.add -> phys
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
        emitTranslate(); // -> phys
        out.push(op, 0x00, ...u(0)); // raw load, align 0 off 0
      } else {
        // stack: va, value  ->  save value, ea, phys, value, raw store
        const vl = VAL[VALTYPE[m.n]];
        out.push(0x21, ...u(vl)); // local.set val
        if (offset !== 0) out.push(0x41, ...s(offset), 0x6a);
        out.push(0x21, ...u(EA)); // local.set ea
        emitTranslate(); // -> phys
        out.push(0x20, ...u(vl)); // local.get val
        out.push(op, 0x00, ...u(0)); // raw store, align 0 off 0
      }
      i = j;
      continue;
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

/** Does this module contain any atomic or SIMD op? (walker-based, whole module) */
export function scanUnhandled(bytes) {
  const secs = splitSections(bytes);
  const code = secs.find((x) => x.id === 10);
  if (!code) return { atomics: false, simd: false };
  let atomics = false;
  let simd = false;
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
      try {
        j = skipInstr(b, j);
      } catch {
        j = end;
      }
    }
    i = end;
  }
  return { atomics, simd };
}

/**
 * Instrument a wasm module with the inlined software-MMU translate.
 *
 * @param {Uint8Array} bytes
 * @param {{ exportControls?: boolean }} [opts]
 * @returns {Uint8Array}
 */
export function instrument(bytes, opts = {}) {
  const unhandled = scanUnhandled(bytes);
  if (unhandled.simd) throw new Error("softmmu: module uses SIMD memory ops (unhandled)");
  if (unhandled.atomics) {
    throw new Error(
      "softmmu: module uses atomic memory ops — the atomic translate is a " +
        "documented follow-up (see softmmu-pass.js); refuse rather than emit an " +
        "untranslated atomic access",
    );
  }

  const secs = splitSections(bytes);
  const byId = (id) => secs.find((x) => x.id === id);
  const importSec = byId(2);
  const typeSec = byId(1);
  const funcSec = byId(3);
  const globalSec = byId(6);
  const codeSec = byId(10);
  if (!codeSec) throw new Error("softmmu: no code section");

  const nImpFuncs = importSec ? countImports(importSec.body, 0) : 0;
  const nImpGlobals = importSec ? countImports(importSec.body, 3) : 0;
  const paramCounts = typeParamCounts(typeSec ? typeSec.body : null);
  const defTypes = definedFuncTypes(funcSec ? funcSec.body : null);
  const nTypes = paramCounts.length;
  const nDefFuncs = defTypes.length;
  const nDefGlobals = globalSec ? readU(globalSec.body, 0)[0] : 0;

  const ptBaseGlobal = nImpGlobals + nDefGlobals; // appended global's index

  // Appended translate helper: type (i32)->i32 at index nTypes; func at index
  // nImpFuncs + nDefFuncs. Used only by exportControls / the kernel — the hot
  // path is inlined and never calls it.
  const translateType = nTypes;
  const translateFunc = nImpFuncs + nDefFuncs;

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
    const rewritten = rewriteFuncBody(body, numParams, ptBaseGlobal);
    newCodeEntries.push([...u(rewritten.length), ...rewritten]);
  }
  // append the translate helper body (RAW loads — it IS the translate):
  //   translate(va): pt_base + ((u32[pt_base + (va>>>12<<2)]) not inlined here)
  const translateBody = [
    ...u(0), // no locals
    0x23,
    ...u(ptBaseGlobal), // global.get pt_base
    0x20,
    ...u(0), // local.get va
    0x41,
    ...s(12),
    0x76, // >>> 12
    0x41,
    ...s(2),
    0x74, // << 2
    0x6a, // +
    0x28,
    0x02,
    ...u(0), // i32.load pte
    0x20,
    ...u(0), // local.get va
    0x41,
    ...s(0xfff),
    0x71, // & 0xfff
    0x6a, // +
    0x0b,
  ];
  newCodeEntries.push([...u(translateBody.length), ...translateBody]);
  const newCodeBody = [...u(nCode + 1), ...newCodeEntries.flat()];

  // --- type section: append (i32)->i32 ---------------------------------------
  const typeExistingTail = typeSec ? typeSec.body.subarray(u(nTypes).length) : [];
  const newTypeBody = [
    ...u(nTypes + 1),
    ...typeExistingTail,
    0x60,
    ...u(1),
    VT.i32,
    ...u(1),
    VT.i32,
  ];

  // --- function section: append the translate helper's type index ------------
  const funcExistingTail = funcSec ? funcSec.body.subarray(u(nDefFuncs).length) : [];
  const newFuncBody = [...u(nDefFuncs + 1), ...funcExistingTail, ...u(translateType)];

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
  let newExportBody = null;
  if (opts.exportControls) {
    const exSec = byId(7);
    const nEx = exSec ? readU(exSec.body, 0)[0] : 0;
    const exTail = exSec ? exSec.body.subarray(u(nEx).length) : [];
    const nb = (str) => vec([...str].map((c) => c.charCodeAt(0)));
    const adds = [
      [...nb("__mmu_pt_base"), 0x03, ...u(ptBaseGlobal)],
      [...nb("__mmu_translate"), 0x00, ...u(translateFunc)],
    ];
    newExportBody = [...u(nEx + adds.length), ...exTail, ...adds.flat()];
  }

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
    if (sec.id !== 0) emitMissingBefore(sec.id);
    outSecs.push(replaced.has(sec.id) ? { id: sec.id, body: replaced.get(sec.id) } : sec);
  }
  emitMissingBefore(11);

  const bytesOut = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const sec of outSecs) bytesOut.push(...sect(sec.id, [...sec.body]));
  return new Uint8Array(bytesOut);
}
