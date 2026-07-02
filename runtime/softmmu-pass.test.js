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
import { instrument, scanUnhandled } from "./softmmu-pass.js";

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
  }
  return { inst, mem, HEAP, PT, u32, setPte };
}

describe("scanUnhandled", () => {
  test("prog.wasm has no atomics or SIMD", () => {
    expect(scanUnhandled(prog)).toEqual({ atomics: false, simd: false });
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
