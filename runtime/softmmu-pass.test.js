// softmmu-pass.test.js — the software-MMU instrumentation pass (#126 Track A /
// #128). Instruments a REAL compiled program (test-fixtures/softmmu/prog.wasm:
// scalar loads/stores across widths, a pointer chase, i64/f64 mixes) and proves:
//   1. the instrumented module still VALIDATES + INSTANTIATES;
//   2. under an IDENTITY page table it computes bit-identically to the original
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
  const PT = 0x40000; // page table base (256 KiB in)
  const HEAP = 0x100000; // working area (1 MiB in)
  if (instrumented) {
    // identity page table over the whole memory: PTE[p] = p << 12
    const pages = mem.buffer.byteLength / PAGE;
    const t = u32();
    for (let p = 0; p < pages; p++) t[PT / 4 + p] = p << 12;
    if (remap) remap(t, PT / 4);
    inst.exports.__mmu_pt_base.value = PT;
  }
  return { inst, mem, HEAP, PT, u32 };
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
      remap: (t, ptWord) => {
        t[ptWord + (V >>> 12)] = P2; // PTE holds phys page BASE (P2 is page-aligned)
      },
    });
    // fill 4 ints at V — with the remap they must appear at P2.
    b.inst.exports.fill(V, 4, 100);
    const u = b.u32();
    expect(u[P2 / 4]).toBe(100);
    expect(u[P2 / 4 + 3]).toBe(103);
    // and the identity location V is untouched (still 0)
    expect(u[V / 4]).toBe(0);
  });

  test("refuses a module containing atomics (documented follow-up)", () => {
    // Hand-craft a tiny module with an i32.atomic.load (0xfe 0x10).
    const atomicMod = new Uint8Array([
      0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      // type: () -> i32
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
      // func: 1 func type 0
      0x03, 0x02, 0x01, 0x00,
      // memory: 1, shared, min 1 max 1
      0x05, 0x04, 0x01, 0x03, 0x01, 0x01,
      // code: 1 body: i32.const 0; i32.atomic.load align=2 off=0; end
      0x0a, 0x0b, 0x01, 0x09, 0x00, 0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x0b,
    ]);
    expect(scanUnhandled(atomicMod).atomics).toBe(true);
    expect(() => instrument(atomicMod)).toThrow(/atomic/);
  });
});
