// softmmu-pass.test.js — the software-MMU instrumentation pass (#126 Track A /
// #128). Instruments a REAL compiled program (test-fixtures/softmmu/prog.wasm:
// scalar loads/stores across widths, a pointer chase, i64/f64 mixes) and proves:
//   1. the instrumented module still VALIDATES + INSTANTIATES;
//   2. under an IDENTITY 2-level page table (with flag bits set, proving the
//      address mask) it computes bit-identically to the original
//      (the translate is correct for every width);
//   3. the page-table indirection is really exercised — remapping a page in the
//      table redirects the access (a non-identity mapping changes the result);
//   4. it refuses (loud) on atomics/SIMD it doesn't yet translate.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NR_MMU_FAULT, instrument, scanUnhandled } from "./softmmu-pass.js";

const FIX = new URL("./test-fixtures/softmmu/", import.meta.url);
const prog = new Uint8Array(readFileSync(new URL("prog.wasm", FIX)));

const PAGE = 4096;

// Instantiate a (possibly instrumented) prog module. For the instrumented one,
// lay down an identity (or custom) single-level page table and point pt_base at
// it. Layout in the module's own memory:
//   [0 .. DATA)         program data (globals) — leave untouched
//   [PT .. PT+PTSIZE)   page table (one u32 PTE per 4K page)
//   [HEAP ..)           working buffers the tests use
function boot(bytes, { instrumented, remap } = {}) {
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, {});
  const mem = inst.exports.memory;
  // grow to a comfortable size
  const needPages = 64; // 4 MiB
  if (mem.buffer.byteLength < needPages * 65536) {
    mem.grow(needPages - mem.buffer.byteLength / 65536);
  }
  const u32 = () => new Uint32Array(mem.buffer);
  // TWO-LEVEL identity tables, laid out like the kernel builds them:
  //   PGD (4 KiB, 1024 entries, each covers 4 MiB) at PT
  //   one PTE table (4 KiB, 1024 entries) per used PGD slot, following.
  // Low-bit FLAGS are deliberately set on every entry (|3, |7) to prove the
  // pass masks them out of the address (kernel PTEs carry present/write bits).
  const PT = 0x40000; // pgd base (256 KiB in)
  const HEAP = 0x100000; // working area (1 MiB in)
  // setPte(va, physBase): point va's page at physBase (flags added here).
  const setPte = (va, physBase) => {
    const t = u32();
    const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
    t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = physBase | 7;
  };
  if (instrumented) {
    const pages = mem.buffer.byteLength / PAGE;
    const nPgd = Math.ceil(pages / 1024);
    const t = u32();
    for (let g = 0; g < nPgd; g++) {
      const pteTable = PT + 0x1000 + g * 0x1000;
      t[PT / 4 + g] = pteTable | 3; // pgd entry -> pte table (+flag bits)
      for (let k = 0; k < 1024; k++) {
        const p = g * 1024 + k;
        t[pteTable / 4 + k] = p < pages ? (p << 12) | 7 : 0;
      }
    }
    if (remap) remap(setPte);
    inst.exports.__mmu_pt_base.value = PT;
    // the pass strips the wasm start section (it would run before pt_base is
    // set) and re-exports it — run it NOW, exactly like the engine does.
    if (inst.exports.__mmu_start) inst.exports.__mmu_start();
  } else if (inst.exports.__mmu_start) {
    inst.exports.__mmu_start();
  }
  return { inst, mem, HEAP, PT, u32, setPte };
}

describe("scanUnhandled", () => {
  test("prog.wasm has no atomics, SIMD, or bulk ops", () => {
    expect(scanUnhandled(prog)).toEqual({ atomics: false, simd: false, bulk: false, initSegs: [] });
  });
});

describe("instrument()", () => {
  test("produces a module that validates + instantiates", () => {
    const out = instrument(prog, { exportControls: true });
    expect(() => new WebAssembly.Module(out)).not.toThrow();
    const b = boot(out, { instrumented: true });
    expect(typeof b.inst.exports.__mmu_translate).toBe("function");
    expect(b.inst.exports.__mmu_pt_base.value).toBe(b.PT);
  });

  test("translate is identity under an identity page table", () => {
    const b = boot(instrument(prog, { exportControls: true }), { instrumented: true });
    const x = b.inst.exports.__mmu_translate;
    for (const va of [0, 1, 0xfff, 0x1000, 0x12345, 0x100000, 0x3fffff]) {
      expect(x(va)).toBe(va);
    }
  });

  test("instrumented == original for scalar scan/fill/widen/dsum (all widths)", () => {
    const orig = boot(prog, {});
    const insn = boot(instrument(prog, { exportControls: true }), { instrumented: true });

    // fill + sum_scan (i32 store + load)
    const N = 1000;
    const buf = 0x100000;
    orig.inst.exports.fill(buf, N, 7);
    insn.inst.exports.fill(buf, N, 7);
    expect(insn.inst.exports.sum_scan(buf, N)).toBe(orig.inst.exports.sum_scan(buf, N));

    // widen (i32.load8_u + i64)
    const bytes = 0x180000;
    const o8 = new Uint8Array(orig.mem.buffer);
    const i8 = new Uint8Array(insn.mem.buffer);
    for (let k = 0; k < 500; k++) {
      o8[bytes + k] = (k * 31) & 0xff;
      i8[bytes + k] = (k * 31) & 0xff;
    }
    expect(insn.inst.exports.widen(bytes, 500)).toBe(orig.inst.exports.widen(bytes, 500));

    // dsum (f64)
    const dbuf = 0x1c0000;
    const od = new Float64Array(orig.mem.buffer);
    const idf = new Float64Array(insn.mem.buffer);
    for (let k = 0; k < 300; k++) {
      od[dbuf / 8 + k] = k * 0.5 - 1.25;
      idf[dbuf / 8 + k] = k * 0.5 - 1.25;
    }
    expect(insn.inst.exports.dsum(dbuf, 300)).toBe(orig.inst.exports.dsum(dbuf, 300));
  });

  test("instrumented pointer-chase matches original (data-dependent loads)", () => {
    const orig = boot(prog, {});
    const insn = boot(instrument(prog, { exportControls: true }), { instrumented: true });
    const N = 256;
    const next = 0x100000;
    // a permutation cycle
    const setNext = (m) => {
      const t = new Uint32Array(m.buffer);
      for (let k = 0; k < N; k++) t[next / 4 + k] = (k * 7 + 1) % N;
    };
    setNext(orig.mem);
    setNext(insn.mem);
    expect(insn.inst.exports.chase(next, 0, 1000)).toBe(orig.inst.exports.chase(next, 0, 1000));
  });

  test("the page table really redirects: remapping a page changes the access", () => {
    // Map virtual page V to physical page P2 (not identity) and confirm a store
    // to V lands in P2's bytes.
    const V = 0x200000; // virtual page 0x200
    const P2 = 0x210000; // physical page 0x210
    const b = boot(instrument(prog, { exportControls: true }), {
      instrumented: true,
      remap: (setPte) => setPte(V, P2), // PTE holds phys page BASE + flag bits
    });
    // fill 4 ints at V — with the remap they must appear at P2.
    b.inst.exports.fill(V, 4, 100);
    const u = b.u32();
    expect(u[P2 / 4]).toBe(100);
    expect(u[P2 / 4 + 3]).toBe(103);
    // and the identity location V is untouched (still 0)
    expect(u[V / 4]).toBe(0);
  });

  test("refuses a module containing SIMD memory ops (documented follow-up)", () => {
    // Hand-craft a module with a v128.load (0xfd 0x00) so scanUnhandled flags SIMD.
    const simdMod = new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      0x01,
      0x05,
      0x01,
      0x60,
      0x00,
      0x01,
      0x7b, // type () -> v128
      0x03,
      0x02,
      0x01,
      0x00, // func 0
      0x05,
      0x03,
      0x01,
      0x00,
      0x01, // memory min 1
      // code: i32.const 0; v128.load align=0 off=0; end
      0x0a,
      0x0b,
      0x01,
      0x09,
      0x00,
      0x41,
      0x00,
      0xfd,
      0x00,
      0x00,
      0x00,
      0x0b,
    ]);
    expect(scanUnhandled(simdMod).simd).toBe(true);
    expect(() => instrument(simdMod)).toThrow(/SIMD/);
  });
});

describe("atomic ops (0xfe) — the musl-pthread path", () => {
  const atomics = new Uint8Array(readFileSync(new URL("atomics.wasm", FIX)));

  // atomics.wasm exports a SHARED memory; boot() grows it + lays the identity PT.
  test("scanUnhandled reports atomics present but NOT simd", () => {
    const u = scanUnhandled(atomics);
    expect(u.atomics).toBe(true);
    expect(u.simd).toBe(false);
  });

  test("instrumented atomics == original under an identity page table", () => {
    const orig = boot(atomics, {});
    const insn = boot(instrument(atomics, { exportControls: true }), { instrumented: true });
    const P = 0x100000; // a mapped word address (i32-aligned) in the HEAP region
    const Q = 0x100008;

    for (const h of [orig, insn]) {
      const dv = new DataView(h.mem.buffer);
      dv.setUint32(P, 7, true);
      // a_load
      expect(h.inst.exports.a_load(P)).toBe(7);
      // a_add returns old (7), leaves 7+5=12
      expect(h.inst.exports.a_add(P, 5) >>> 0).toBe(7);
      expect(dv.getUint32(P, true)).toBe(12);
      // a_store
      h.inst.exports.a_store(P, 100);
      expect(dv.getUint32(P, true)).toBe(100);
      // a_xchg returns old (100), leaves 200
      expect(h.inst.exports.a_xchg(P, 200) >>> 0).toBe(100);
      expect(dv.getUint32(P, true)).toBe(200);
      // a_cas: expected 200 matches → observed old 200, store 300
      expect(h.inst.exports.a_cas(P, 200, 300) >>> 0).toBe(200);
      expect(dv.getUint32(P, true)).toBe(300);
      // a_cas: expected 999 mismatches → observed old 300, no store
      expect(h.inst.exports.a_cas(P, 999, 42) >>> 0).toBe(300);
      expect(dv.getUint32(P, true)).toBe(300);
      // a_add64 (i64 atomic): old 0, leaves 1000000000000
      dv.setBigUint64(Q, 0n, true);
      expect(h.inst.exports.a_add64(Q, 1000000000000n)).toBe(0n);
      expect(dv.getBigUint64(Q, true)).toBe(1000000000000n);
    }
  });

  test("atomics honor the page table: a remapped page redirects the atomic", () => {
    const V = 0x200000; // virtual page 0x200
    const P2 = 0x220000; // physical page 0x220
    const b = boot(instrument(atomics, { exportControls: true }), {
      instrumented: true,
      remap: (setPte) => setPte(V, P2),
    });
    const dv = new DataView(b.mem.buffer);
    // atomic store to V lands in P2 (identity page V left untouched).
    b.inst.exports.a_store(V, 0xabcd);
    expect(dv.getUint32(P2, true)).toBe(0xabcd);
    expect(dv.getUint32(V, true)).toBe(0);
    // atomic rmw through the remap too: add 1 → old 0xabcd, P2 now 0xabce.
    expect(b.inst.exports.a_add(V, 1) >>> 0).toBe(0xabcd);
    expect(dv.getUint32(P2, true)).toBe(0xabce);
  });
});

describe("bulk-memory ops (0xfc) — memory.copy/fill/init through the page table", () => {
  const bulk = new Uint8Array(readFileSync(new URL("bulk.wasm", FIX)));

  test("scanUnhandled reports bulk + the memory.init segment", () => {
    const u = scanUnhandled(bulk);
    expect(u.bulk).toBe(true);
    expect(u.initSegs).toEqual([0]);
  });

  test("memory.init: start is STRIPPED (__mmu_start) and places the data right", () => {
    // __wasm_init_memory (the wasm start function) would run at instantiation
    // — BEFORE pt_base can be set — so the pass strips the start section and
    // re-exports it as __mmu_start; the embedder sets pt_base then calls it
    // (boot() above does exactly that). The data segment must land at the
    // same RAW addresses as the uninstrumented module places it.
    const insnBytes = instrument(bulk, { exportControls: true });
    const insnMod = new WebAssembly.Module(insnBytes);
    expect(WebAssembly.Module.exports(insnMod).some((e) => e.name === "__mmu_start")).toBe(true);
    const orig = boot(bulk, {});
    const insn = boot(insnBytes, { instrumented: true });
    // strict: identical values through the accessor AND identical raw bytes
    // in the data region (find the segment via the original: 1..8 prefix).
    expect(insn.inst.exports.read_data(0)).toBe(1);
    expect(insn.inst.exports.read_data(7)).toBe(8);
    const a = new Uint8Array(orig.mem.buffer).slice(0, 0x1000);
    const b = new Uint8Array(insn.mem.buffer).slice(0, 0x1000);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  test("instrumented == original for copy/move(overlap)/fill", () => {
    const orig = boot(bulk, {});
    const insn = boot(instrument(bulk, { exportControls: true }), { instrumented: true });
    const SRC = 0x100000;
    const DST = 0x180000; // crosses many pages: len > PAGE
    const N = 12345;
    for (const h of [orig, insn]) {
      const u8 = new Uint8Array(h.mem.buffer);
      for (let k = 0; k < N; k++) u8[SRC + k] = (k * 131 + 7) & 0xff;
      h.inst.exports.bulk_copy(DST, SRC, N);
      // overlapping move: dest above src within the copied range
      h.inst.exports.bulk_move(DST + 100, DST, N - 200);
      // fill a page-crossing stripe
      h.inst.exports.bulk_fill(DST + 4090, 0xab, 100);
    }
    const a = new Uint8Array(orig.mem.buffer).slice(DST, DST + N);
    const b = new Uint8Array(insn.mem.buffer).slice(DST, DST + N);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  test("bulk ops honor the page table: remapped pages redirect a copy", () => {
    const V = 0x200000; // virtual dest page
    const P2 = 0x240000; // physical page it maps to
    const b = boot(instrument(bulk, { exportControls: true }), {
      instrumented: true,
      remap: (setPte) => setPte(V, P2),
    });
    const u8 = new Uint8Array(b.mem.buffer);
    const SRC = 0x100000;
    for (let k = 0; k < 64; k++) u8[SRC + k] = k + 1;
    b.inst.exports.bulk_copy(V, SRC, 64);
    // bytes landed in P2, not V
    expect(u8[P2]).toBe(1);
    expect(u8[P2 + 63]).toBe(64);
    expect(u8[V]).toBe(0);
    // fill through the remap too
    b.inst.exports.bulk_fill(V + 8, 0x5a, 16);
    expect(u8[P2 + 8]).toBe(0x5a);
    expect(u8[P2 + 23]).toBe(0x5a);
  });
});

describe("checked (A2 present-check) translate", () => {
  // A hand-built fixture (no toolchain available here — mirrors the existing
  // hand-crafted SIMD-refusal module above) that carries what `checked: true`
  // now requires: an env.__wasm_syscall_2 import ((i32×5)->i32, matching
  // musl's real arch/wasm/bits/asm.h ABI), an env.__stack_pointer import (i32
  // mutable global), and an EXPORTED __get_tls_base() -> i32 function (the
  // real musl/engine ABI: tp is sourced by CALLING it, not by reading an
  // imported __tls_base global — see resolveCheckedImports). This fixture's
  // __get_tls_base returns a fixed sentinel (0x1234) so tests can assert the
  // fault call actually round-trips it. Two more exported funcs:
  // load_u8(va)->i32 (a scalar load — fault kind 0) and store_u8(va,v) (a
  // scalar store — fault kind 1).
  function leb_u(n) {
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
  function leb_s(n) {
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
  const vecb = (items) => [...leb_u(items.length), ...items.flat()];
  const sectb = (id, payload) => [id, ...leb_u(payload.length), ...payload];
  const strb = (str) => [...leb_u(str.length), ...[...str].map((c) => c.charCodeAt(0))];
  const funcType = (params, results) => [
    0x60,
    ...leb_u(params.length),
    ...params,
    ...leb_u(results.length),
    ...results,
  ];
  const I32 = 0x7f;

  /**
   * @param {{omitTlsExport?: boolean}} [opts] `omitTlsExport` builds the
   *   function but does NOT export it — used to test resolveCheckedImports'
   *   dedicated "requires __get_tls_base export" error path.
   */
  function buildCheckedFixture(opts = {}) {
    const types = [
      funcType([I32], [I32]), // 0: load_u8(va) -> i32
      funcType([I32, I32], []), // 1: store_u8(va, v)
      funcType([I32, I32, I32, I32, I32], [I32]), // 2: __wasm_syscall_2
      funcType([], [I32]), // 3: __get_tls_base() -> i32
    ];
    const typeSec = sectb(1, vecb(types));

    const imports = [
      [...strb("env"), ...strb("__wasm_syscall_2"), 0x00, ...leb_u(2)],
      [...strb("env"), ...strb("__stack_pointer"), 0x03, I32, 0x01],
    ];
    const importSec = sectb(2, vecb(imports));

    // defined funcs (func idx 0 is the __wasm_syscall_2 import):
    //   1: load_u8 (type 0)   2: store_u8 (type 1)   3: __get_tls_base (type 3)
    const funcSec = sectb(3, vecb([leb_u(0), leb_u(1), leb_u(3)]));
    const memSec = sectb(5, vecb([[0x00, ...leb_u(32)]]));

    const exports = [
      [...strb("memory"), 0x02, ...leb_u(0)],
      [...strb("load_u8"), 0x00, ...leb_u(1)],
      [...strb("store_u8"), 0x00, ...leb_u(2)],
      ...(opts.omitTlsExport ? [] : [[...strb("__get_tls_base"), 0x00, ...leb_u(3)]]),
    ];
    const exportSec = sectb(7, vecb(exports));

    const readBody = [...leb_u(0), 0x20, 0x00, 0x2d, 0x00, 0x00, 0x0b]; // i32.load8_u
    const writeBody = [...leb_u(0), 0x20, 0x00, 0x20, 0x01, 0x3a, 0x00, 0x00, 0x0b]; // i32.store8
    const tlsBody = [...leb_u(0), 0x41, ...leb_s(0x1234), 0x0b]; // i32.const 0x1234
    const codeSec = sectb(
      10,
      [
        ...leb_u(3),
        ...leb_u(readBody.length),
        ...readBody,
        ...leb_u(writeBody.length),
        ...writeBody,
        ...leb_u(tlsBody.length),
        ...tlsBody,
      ].flat(),
    );

    return new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...typeSec,
      ...importSec,
      ...funcSec,
      ...memSec,
      ...exportSec,
      ...codeSec,
    ]);
  }

  const PT = 0x40000;
  const HEAP = 0x100000;

  /**
   * Instantiate an instrumented checked-fixture module with a real two-level
   * identity page table EXCEPT the page containing `notPresentVa` (left with
   * a zero PTE, i.e. absent), and a mock __wasm_syscall_2 that records every
   * call and, on the first fault for a given page, installs an identity
   * mapping for it (so the retry succeeds) — exactly the contract a real
   * kernel fault handler provides (make present, or don't return).
   */
  function bootChecked(instrumentedBytes, notPresentVa) {
    const mod = new WebAssembly.Module(instrumentedBytes);
    const calls = [];
    const rawCalls = []; // full (sp, tp, nr, ea, kind) — used by the tp round-trip test
    const spGlobal = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    let inst;
    const fault = (sp, tp, nr, ea, kind) => {
      rawCalls.push({
        sp: Number(sp),
        tp: Number(tp),
        nr: Number(nr),
        ea: Number(ea),
        kind: Number(kind),
      });
      calls.push({ nr: Number(nr), ea: Number(ea), kind: Number(kind) });
      const t = new Uint32Array(inst.exports.memory.buffer);
      const va = Number(ea) >>> 0;
      const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = (va & ~0xfff) | 7; // identity, present+write
      return 0;
    };
    // no __tls_base import — tp is sourced by the guest CALLING its own
    // exported __get_tls_base(), which this fixture returns as a fixed
    // sentinel (0x1234); see buildCheckedFixture/buildCheckedBulkFixture.
    inst = new WebAssembly.Instance(mod, {
      env: { __wasm_syscall_2: fault, __stack_pointer: spGlobal },
    });
    const mem = inst.exports.memory;
    const needPages = 64; // 4 MiB, same as the other fixtures' boot()
    if (mem.buffer.byteLength < needPages * 65536) {
      mem.grow(needPages - mem.buffer.byteLength / 65536);
    }
    const pages = mem.buffer.byteLength / PAGE;
    const nPgd = Math.ceil(pages / 1024);
    const t = new Uint32Array(mem.buffer);
    for (let g = 0; g < nPgd; g++) {
      const pteTable = PT + 0x1000 + g * 0x1000;
      t[PT / 4 + g] = pteTable | 3;
      for (let k = 0; k < 1024; k++) {
        const p = g * 1024 + k;
        t[pteTable / 4 + k] = p < pages ? (p << 12) | 7 : 0;
      }
    }
    if (notPresentVa !== undefined) {
      const va = notPresentVa >>> 0;
      const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = 0; // absent
    }
    inst.exports.__mmu_pt_base.value = PT;
    if (inst.exports.__mmu_start) inst.exports.__mmu_start();
    return { inst, mem, calls, rawCalls };
  }

  test("instrument({checked:true}) throws on a module missing the required imports", () => {
    const prog = new Uint8Array(readFileSync(new URL("prog.wasm", FIX)));
    expect(() => instrument(prog, { checked: true })).toThrow(/__wasm_syscall_2/);
  });

  test("instrument({checked:true}) throws on a module missing the __get_tls_base export", () => {
    // Matches the new contract: tp is sourced by CALLING an exported
    // __get_tls_base(), not by reading an imported __tls_base global — so a
    // module with __wasm_syscall_2/__stack_pointer but no __get_tls_base
    // export must fail this specific check (distinct from the two "entirely
    // uninstrumented module" cases above).
    const withoutTlsExport = buildCheckedFixture({ omitTlsExport: true });
    expect(() => instrument(withoutTlsExport, { checked: true })).toThrow(/__get_tls_base/);
  });

  test("a not-present page faults exactly once (kind=0 load), then the load succeeds", () => {
    const V = HEAP + 0x40000; // some page distinct from PT's own pages
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes, V);
    // seed a known byte at the (still virtual) address — the fault handler
    // maps V identity, so this is also where the raw load will land.
    new Uint8Array(b.mem.buffer)[V] = 0x77;

    const val = b.inst.exports.load_u8(V);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 0 });
    expect(val).toBe(0x77);
    // tp (args[1] of __wasm_syscall_2) is sourced by CALLING the module's
    // exported __get_tls_base(), not an imported global — this fixture's
    // __get_tls_base returns the fixed sentinel 0x1234.
    expect(b.rawCalls.length).toBe(1);
    expect(b.rawCalls[0].tp).toBe(0x1234);
  });

  test("a present page never faults", () => {
    const V = HEAP + 0x50000;
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes /* no notPresentVa */);
    new Uint8Array(b.mem.buffer)[V] = 0x11;
    expect(b.inst.exports.load_u8(V)).toBe(0x11);
    expect(b.calls.length).toBe(0);
  });

  test("a not-present page faults exactly once (kind=1 store), then the store succeeds", () => {
    const V = HEAP + 0x60000;
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes, V);

    b.inst.exports.store_u8(V, 0x99);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 1 });
    expect(new Uint8Array(b.mem.buffer)[V]).toBe(0x99);
  });

  test("unchecked instrument() output is unaffected by the checked feature existing", () => {
    // regression guard: instrument(prog) with no opts.checked must still
    // produce the exact byte-for-byte A1 output (no accidental default flip).
    const prog = new Uint8Array(readFileSync(new URL("prog.wasm", FIX)));
    const a = instrument(prog, { exportControls: true });
    const b = instrument(prog, { exportControls: true, checked: false });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  // ---- checked bulk-memory ops (memory.copy/fill through the page table) --
  //
  // The bulk-op fixture in test-fixtures/softmmu/ (bulk.wasm) has no
  // toolchain here to rebuild it with the __wasm_syscall_2/__stack_pointer
  // imports + __get_tls_base export `checked: true` requires, so — matching
  // the SIMD- and scalar-checked fixtures already hand-built above — this
  // hand-builds a minimal module with the same import/export surface as
  // buildCheckedFixture() plus two bulk-op exports: bulk_fill(d,v,n)
  // (memory.fill) and bulk_copy(d,s,n) (memory.copy).
  function buildCheckedBulkFixture() {
    const types = [
      funcType([I32, I32, I32], []), // 0: bulk_fill(d,v,n) / bulk_copy(d,s,n)
      funcType([I32, I32, I32, I32, I32], [I32]), // 1: __wasm_syscall_2
      funcType([], [I32]), // 2: __get_tls_base() -> i32
    ];
    const typeSec = sectb(1, vecb(types));

    const imports = [
      [...strb("env"), ...strb("__wasm_syscall_2"), 0x00, ...leb_u(1)],
      [...strb("env"), ...strb("__stack_pointer"), 0x03, I32, 0x01],
    ];
    const importSec = sectb(2, vecb(imports));

    // defined funcs (func idx 0 is the __wasm_syscall_2 import):
    //   1: bulk_fill (type 0)   2: bulk_copy (type 0)   3: __get_tls_base (type 2)
    const funcSec = sectb(3, vecb([leb_u(0), leb_u(0), leb_u(2)]));
    const memSec = sectb(5, vecb([[0x00, ...leb_u(64)]]));

    const exports = [
      [...strb("memory"), 0x02, ...leb_u(0)],
      [...strb("bulk_fill"), 0x00, ...leb_u(1)],
      [...strb("bulk_copy"), 0x00, ...leb_u(2)],
      [...strb("__get_tls_base"), 0x00, ...leb_u(3)],
    ];
    const exportSec = sectb(7, vecb(exports));

    // bulk_fill(d,v,n): local.get d; local.get v; local.get n; memory.fill 0
    const fillBody = [...leb_u(0), 0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0xfc, 0x0b, 0x00, 0x0b];
    // bulk_copy(d,s,n): local.get d; local.get s; local.get n; memory.copy 0 0
    const copyBody = [
      ...leb_u(0),
      0x20,
      0x00,
      0x20,
      0x01,
      0x20,
      0x02,
      0xfc,
      0x0a,
      0x00,
      0x00,
      0x0b,
    ];
    const tlsBody = [...leb_u(0), 0x41, ...leb_s(0x1234), 0x0b]; // i32.const 0x1234
    const codeSec = sectb(
      10,
      [
        ...leb_u(3),
        ...leb_u(fillBody.length),
        ...fillBody,
        ...leb_u(copyBody.length),
        ...copyBody,
        ...leb_u(tlsBody.length),
        ...tlsBody,
      ].flat(),
    );

    return new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...typeSec,
      ...importSec,
      ...funcSec,
      ...memSec,
      ...exportSec,
      ...codeSec,
    ]);
  }

  test("instrument({checked:true}) throws on bulk.wasm missing the required imports", () => {
    const bulk = new Uint8Array(readFileSync(new URL("bulk.wasm", FIX)));
    expect(() => instrument(bulk, { checked: true })).toThrow(/__wasm_syscall_2/);
  });

  test("unchecked instrument() output for bulk.wasm is unaffected by the checked feature existing", () => {
    const bulk = new Uint8Array(readFileSync(new URL("bulk.wasm", FIX)));
    const a = instrument(bulk, { exportControls: true });
    const bOut = instrument(bulk, { exportControls: true, checked: false });
    expect(Buffer.from(a).equals(Buffer.from(bOut))).toBe(true);
  });

  test("bulk_fill on a not-present page faults exactly once (kind=1 write), then lands", () => {
    const V = HEAP + 0x70000; // page-aligned dest, distinct from every other test's page
    const bytes = instrument(buildCheckedBulkFixture(), { checked: true });
    const b = bootChecked(bytes, V);

    b.inst.exports.bulk_fill(V, 0xab, 16);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 1 });
    const u8 = new Uint8Array(b.mem.buffer);
    for (let k = 0; k < 16; k++) expect(u8[V + k]).toBe(0xab);
  });

  test("bulk_copy: not-present DEST faults kind=1 (write); present SRC never faults", () => {
    const V = HEAP + 0x80000; // dest, not present
    const SRC = HEAP + 0x10000; // src, present (default identity mapping)
    const bytes = instrument(buildCheckedBulkFixture(), { checked: true });
    const b = bootChecked(bytes, V);
    const u8 = new Uint8Array(b.mem.buffer);
    for (let k = 0; k < 8; k++) u8[SRC + k] = k + 1;

    b.inst.exports.bulk_copy(V, SRC, 8);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 1 });
    for (let k = 0; k < 8; k++) expect(u8[V + k]).toBe(k + 1);
  });

  test("bulk_copy: not-present SRC faults kind=0 (read), never write-faults a read-only source", () => {
    const SRC = HEAP + 0x90000; // src, not present
    const DST = HEAP + 0x20000; // dest, present (default identity mapping)
    const bytes = instrument(buildCheckedBulkFixture(), { checked: true });
    const b = bootChecked(bytes, SRC);
    const u8 = new Uint8Array(b.mem.buffer);
    for (let k = 0; k < 8; k++) u8[SRC + k] = k + 10;

    b.inst.exports.bulk_copy(DST, SRC, 8);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: SRC, kind: 0 });
    for (let k = 0; k < 8; k++) expect(u8[DST + k]).toBe(k + 10);
  });
});
