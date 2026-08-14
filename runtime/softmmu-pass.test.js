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
import { ByteSink, NR_MMU_FAULT, concatBytes, instrument, scanUnhandled } from "./softmmu-pass.js";

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

  test("#128 page-crossing scalar access reaches TWO non-adjacent physical frames", () => {
    // The bug this proves fixed: a multi-byte scalar store/load whose bytes span
    // a page boundary must reach the two frames the two virtual pages map to —
    // NOT write the tail bytes into the frame physically-after the first one.
    // Map two ADJACENT virtual pages to two NON-adjacent physical frames:
    //   virtual 0x300xxx -> phys frame P1=0x210000
    //   virtual 0x301xxx -> phys frame P2=0x260000  (P1's next frame is 0x211000)
    const VB = 0x300000; // virtual page 0x300 base
    const P1 = 0x210000;
    const P2 = 0x260000; // deliberately != P1 + 0x1000
    const b = boot(instrument(prog, { exportControls: true }), {
      instrumented: true,
      remap: (setPte) => {
        setPte(VB, P1);
        setPte(VB + 0x1000, P2);
      },
    });
    // a single i32.store at VB+0xffe spans 0xffe,0xfff (page 0x300 -> P1) and
    // 0x1000,0x1001 (page 0x301 -> P2). value little-endian 44 33 22 11.
    const CROSS = VB + 0xffe;
    b.inst.exports.fill(CROSS, 1, 0x11223344);
    const u8 = new Uint8Array(b.mem.buffer);
    // low two bytes land in P1's tail...
    expect(u8[P1 + 0xffe]).toBe(0x44);
    expect(u8[P1 + 0xfff]).toBe(0x33);
    // ...high two bytes land in P2's head (the correct frame, NOT P1+0x1000).
    expect(u8[P2 + 0]).toBe(0x22);
    expect(u8[P2 + 1]).toBe(0x11);
    // the frame physically after P1 (what the pre-fix raw store would have hit)
    // is untouched.
    expect(u8[P1 + 0x1000]).toBe(0);
    expect(u8[P1 + 0x1001]).toBe(0);
    // and a crossing i32.load reads the value back whole across both frames.
    expect(b.inst.exports.sum_scan(CROSS, 1) >>> 0).toBe(0x11223344);
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

describe("helper-call translate under stress (#164 segfault triage)", () => {
  // The nix.wasm runtime segfault (prove-then-flip run 29352263382) appeared in
  // the FIRST binary big enough to take the #164 helper-call fallback. Rule the
  // helper path in/out as the cause by running the REAL compiled fixtures —
  // every scalar width, data-dependent loads, page-table redirection, and the
  // full atomics battery — with inlineLimit:1 (every function via helper) and
  // asserting bit-identical behavior with the original / the inline path.
  const atomics = new Uint8Array(readFileSync(new URL("atomics.wasm", FIX)));
  const viaHelper = (bytes) => instrument(bytes, { exportControls: true, inlineLimit: 1 });

  test("prog.wasm via helper == original (all scalar widths + f64)", () => {
    const orig = boot(prog, {});
    const insn = boot(viaHelper(prog), { instrumented: true });
    const N = 1000;
    const buf = 0x100000;
    orig.inst.exports.fill(buf, N, 7);
    insn.inst.exports.fill(buf, N, 7);
    expect(insn.inst.exports.sum_scan(buf, N)).toBe(orig.inst.exports.sum_scan(buf, N));
    const bytes = 0x180000;
    const o8 = new Uint8Array(orig.mem.buffer);
    const i8 = new Uint8Array(insn.mem.buffer);
    for (let k = 0; k < 500; k++) {
      o8[bytes + k] = (k * 31) & 0xff;
      i8[bytes + k] = (k * 31) & 0xff;
    }
    expect(insn.inst.exports.widen(bytes, 500)).toBe(orig.inst.exports.widen(bytes, 500));
    const dbuf = 0x1c0000;
    const od = new Float64Array(orig.mem.buffer);
    const idf = new Float64Array(insn.mem.buffer);
    for (let k = 0; k < 300; k++) {
      od[dbuf / 8 + k] = k * 0.5 - 1.25;
      idf[dbuf / 8 + k] = k * 0.5 - 1.25;
    }
    expect(insn.inst.exports.dsum(dbuf, 300)).toBe(orig.inst.exports.dsum(dbuf, 300));
  });

  test("prog.wasm via helper: pointer-chase + page-table redirection", () => {
    const orig = boot(prog, {});
    const insn = boot(viaHelper(prog), { instrumented: true });
    const N = 256;
    const next = 0x100000;
    const setNext = (m) => {
      const t = new Uint32Array(m.buffer);
      for (let k = 0; k < N; k++) t[next / 4 + k] = (k * 7 + 1) % N;
    };
    setNext(orig.mem);
    setNext(insn.mem);
    expect(insn.inst.exports.chase(next, 0, 1000)).toBe(orig.inst.exports.chase(next, 0, 1000));
    // remap: a store to V lands in P2 through the helper's walk too
    const V = 0x200000;
    const P2 = 0x210000;
    const b = boot(viaHelper(prog), { instrumented: true, remap: (setPte) => setPte(V, P2) });
    b.inst.exports.fill(V, 4, 100);
    const u = b.u32();
    expect(u[P2 / 4]).toBe(100);
    expect(u[P2 / 4 + 3]).toBe(103);
    expect(u[V / 4]).toBe(0);
  });

  test("atomics via helper == original (load/add/store/xchg/cas/add64) + remap", () => {
    // nix.wasm is the first heavily-THREADED binary through the fallback — its
    // musl pthread path is atomics-dense, so atomics×helper is the prime
    // suspect surface. Mirror the full inline atomics battery through the
    // helper, then the remap redirection.
    const orig = boot(atomics, {});
    const insn = boot(viaHelper(atomics), { instrumented: true });
    const P = 0x100000;
    const Q = 0x100008;
    for (const h of [orig, insn]) {
      const dv = new DataView(h.mem.buffer);
      dv.setUint32(P, 7, true);
      expect(h.inst.exports.a_load(P)).toBe(7);
      expect(h.inst.exports.a_add(P, 5) >>> 0).toBe(7);
      expect(dv.getUint32(P, true)).toBe(12);
      h.inst.exports.a_store(P, 100);
      expect(dv.getUint32(P, true)).toBe(100);
      expect(h.inst.exports.a_xchg(P, 200) >>> 0).toBe(100);
      expect(dv.getUint32(P, true)).toBe(200);
      expect(h.inst.exports.a_cas(P, 200, 300) >>> 0).toBe(200);
      expect(dv.getUint32(P, true)).toBe(300);
      expect(h.inst.exports.a_cas(P, 999, 42) >>> 0).toBe(300);
      expect(dv.getUint32(P, true)).toBe(300);
      dv.setBigUint64(Q, 0n, true);
      expect(h.inst.exports.a_add64(Q, 1000000000000n)).toBe(0n);
      expect(dv.getBigUint64(Q, true)).toBe(1000000000000n);
    }
    const V = 0x200000;
    const P2 = 0x220000;
    const b = boot(viaHelper(atomics), { instrumented: true, remap: (setPte) => setPte(V, P2) });
    const dv = new DataView(b.mem.buffer);
    b.inst.exports.a_store(V, 0xabcd);
    expect(dv.getUint32(P2, true)).toBe(0xabcd);
    expect(dv.getUint32(V, true)).toBe(0);
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
   * @param {{omitTlsExport?: boolean, leadingTag?: boolean}} [opts]
   *   `omitTlsExport` builds the function but does NOT export it — used to test
   *   resolveCheckedImports' dedicated "requires __get_tls_base export" error
   *   path. `leadingTag` prepends an `env.__cpp_exception` TAG import (kind
   *   0x04) BEFORE the `__wasm_syscall_2` function import — reproducing the
   *   real guest layout (#152: every `-fwasm-exceptions` C++ binary imports
   *   this tag). A tag import does NOT occupy the function-index space, so the
   *   defined-function indices below are unchanged; the point is that the
   *   import DECODER must skip the tag or every later import (incl. the
   *   syscall) goes unseen (sommelier was read as `func-imports=1`).
   */
  function buildCheckedFixture(opts = {}) {
    const types = [
      funcType([I32], [I32]), // 0: load_u8(va) -> i32
      funcType([I32, I32], []), // 1: store_u8(va, v)
      funcType([I32, I32, I32, I32, I32], [I32]), // 2: __wasm_syscall_2
      funcType([], [I32]), // 3: __get_tls_base() -> i32
      funcType([I32], []), // 4: __cpp_exception tag type ((i32)->())
    ];
    const typeSec = sectb(1, vecb(types));

    const imports = [
      // TAG import first (kind 0x04, attribute 0x00, type index 4) — only when
      // leadingTag, mirroring wasm-ld's real ordering for a guest C++ binary.
      ...(opts.leadingTag
        ? [[...strb("env"), ...strb("__cpp_exception"), 0x04, 0x00, ...leb_u(4)]]
        : []),
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
   *
   * `pgdNotPresentVa` (#202 §6.2 hazard case): like `notPresentVa`, but zeros
   * the LEVEL-1 (PGD) entry instead of the leaf, AND pokes the module's own
   * low-memory location the combined predicate's UNCONDITIONAL level-2 read
   * lands on when pgd_e==0 (`idx*4` for idx=(va>>>12)&0x3ff — see
   * `emitCheckedPresentPredicate`'s doc comment) with a value whose low bits
   * (0b11) are deliberately set — i.e. "garbage that would pass the leaf
   * present/permission test if the pgd_e!=0 conjunct were missing or wrong".
   * The fault mock re-attaches the (still fully populated, only the POINTER
   * was zeroed) pte table on a level-1 miss — a real fault handler would
   * likewise create/attach a fresh table — so a correctly-gated access
   * faults exactly once and then succeeds; an INCORRECTLY-gated one would
   * either never fault (walks through to wrong physical memory) or loop
   * forever (this mock does not "fix" the garbage location itself, only the
   * real PGD pointer, so a buggy implementation that keeps reading the
   * garbage address would keep re-triggering the level-2 permission check
   * against unchanged garbage — that failure mode is caught by the "bounded
   * fault count" assertion in the test itself, not silently accepted here).
   */
  function bootChecked(instrumentedBytes, notPresentVa, roVa, pgdNotPresentVa) {
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
      const g = va >>> 22;
      if (t[PT / 4 + g] === 0) {
        // level-1 (PGD) not present — re-attach the SAME pte table the
        // initial setup loop below already populated for this slot (still
        // fully identity-mapped underneath; only the PGD pointer itself was
        // zeroed to simulate "not present"), exactly as a real fault
        // handler creates/attaches a table on a genuine level-1 miss.
        t[PT / 4 + g] = (PT + 0x1000 + g * 0x1000) | 3;
      }
      const pteTable = t[PT / 4 + g] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = (va & ~0xfff) | 7; // identity, present+write
      return 0;
    };
    // no __tls_base import — tp is sourced by the guest CALLING its own
    // exported __get_tls_base(), which this fixture returns as a fixed
    // sentinel (0x1234); see buildCheckedFixture/buildCheckedBulkFixture.
    inst = new WebAssembly.Instance(mod, {
      env: {
        __wasm_syscall_2: fault,
        __stack_pointer: spGlobal,
        // Provided unconditionally; ignored by fixtures that don't import it,
        // supplied to the leadingTag fixture that DOES (guest C++ EH tag).
        __cpp_exception: new WebAssembly.Tag({ parameters: ["i32"] }),
      },
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
    if (roVa !== undefined) {
      // Model a COW / mprotect(PROT_READ) page: PRESENT but write-protected
      // (flag 1 = _PAGE_PRESENT only, no _PAGE_WRITE). A load must NOT fault; a
      // store MUST fault (kind=1) so the fault handler above upgrades it to
      // present+write (flag 7) — exactly the do_wp_page COW upgrade.
      const va = roVa >>> 0;
      const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = (va & ~0xfff) | 1; // present, RO
    }
    if (pgdNotPresentVa !== undefined) {
      const va = pgdNotPresentVa >>> 0;
      t[PT / 4 + (va >>> 22)] = 0; // level-1 (PGD) absent
      const idx = (va >>> 12) & 0x3ff;
      t[idx] = 0xffffffff; // the deceptive "garbage" the unconditional level-2 read lands on
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

  test("a leading __cpp_exception TAG import does not hide the syscall import (#152)", () => {
    // The #152 sommelier panic: a guest C++ binary imports the
    // `__cpp_exception` tag (import kind 0x04) BEFORE its `__wasm_syscall_*`
    // function imports. The pass's import decoders (parseImportsDetailed /
    // countImports) had no case for kind 0x04, so the walk desynced on the tag
    // and every later import vanished — resolveCheckedImports then wrongly threw
    // "requires __wasm_syscall_2" (sommelier reported as func-imports=1). With
    // the tag case, the syscall is found AND the imported-function count is
    // correct, so instrument({checked}) succeeds and the module still faults
    // correctly (a wrong func-count base would misnumber the fault call).
    const V = HEAP + 0x58000;
    const bytes = instrument(buildCheckedFixture({ leadingTag: true }), { checked: true });
    const b = bootChecked(bytes, V);
    new Uint8Array(b.mem.buffer)[V] = 0x5c;

    const val = b.inst.exports.load_u8(V);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 0 });
    expect(val).toBe(0x5c);
  });

  test("skipInstr walks all wasm exception-handling opcodes (#152)", () => {
    // Once the tag import no longer hides the syscall, instrument() proceeds to
    // WALK the code — and a `-fwasm-exceptions` C++ body contains EH opcodes.
    // Build a fixture whose store_u8 body is a well-nested EH region covering
    // BOTH the legacy (try/catch/rethrow/catch_all + throw) and the standard
    // (try_table/throw_ref) opcode sets, then assert instrument() does NOT throw
    // "unknown opcode" on any of them. Not instantiated — this exercises the
    // static walker (skipInstr) independent of the host's EH-feature support.
    // Hand-crafted EH body (a minimal module carrying only the checked-required
    // imports/exports + one EH function). Body locals: none. Sequence (each
    // op's immediates are what skipInstr must
    // consume correctly):
    //   try (void)                 06 40
    //     local.get 0              20 00
    //     i32.load8_u [a0 o0]      2d 00 00   (a real mem op inside the try)
    //     drop                     1a
    //   catch 0                    07 00      (tag index)
    //     rethrow 0                09 00      (relative depth)
    //   catch_all                  19
    //   delegate 0                 18 00      (relative depth; ends the try)
    //   try_table (void) [0]       1f 40 00   (blocktype void, 0 catch clauses)
    //   end                        0b         (closes try_table)
    //   throw_ref                  0a
    //   i32.const 0 / throw 0      41 00 08 00  (throw a tag)
    //   end                        0b         (function end)
    const ehBody = [
      ...leb_u(0), // 0 local groups
      0x06,
      0x40,
      0x20,
      0x00,
      0x2d,
      0x00,
      0x00,
      0x1a,
      0x07,
      0x00,
      0x09,
      0x00,
      0x19,
      0x18,
      0x00,
      0x1f,
      0x40,
      0x00,
      0x0b,
      0x0a,
      0x41,
      0x00,
      0x08,
      0x00,
      0x0b,
    ];
    // Splice ehBody in place of store_u8's body by rebuilding the code section
    // through the public builder is awkward; instead assert on a minimal module
    // that carries ONLY the EH function plus the checked-required imports/exports.
    const types = [
      funcType([I32, I32], []), // 0: store-shaped (unused signature is fine)
      funcType([I32, I32, I32, I32, I32], [I32]), // 1: __wasm_syscall_2
      funcType([], [I32]), // 2: __get_tls_base
      funcType([I32], []), // 3: tag type
      funcType([], []), // 4: eh() -> void
    ];
    const typeSec = sectb(1, vecb(types));
    const imports = [
      [...strb("env"), ...strb("__cpp_exception"), 0x04, 0x00, ...leb_u(3)],
      [...strb("env"), ...strb("__wasm_syscall_2"), 0x00, ...leb_u(1)],
      [...strb("env"), ...strb("__stack_pointer"), 0x03, I32, 0x01],
    ];
    const importSec = sectb(2, vecb(imports));
    // defined funcs: idx 1 = __get_tls_base (type 2), idx 2 = eh (type 4)
    const funcSec = sectb(3, vecb([leb_u(2), leb_u(4)]));
    const memSec = sectb(5, vecb([[0x00, ...leb_u(32)]]));
    const exportSec = sectb(
      7,
      vecb([
        [...strb("memory"), 0x02, ...leb_u(0)],
        [...strb("__get_tls_base"), 0x00, ...leb_u(1)],
        [...strb("eh"), 0x00, ...leb_u(2)],
      ]),
    );
    const tlsBody = [...leb_u(0), 0x41, ...leb_s(0x1234), 0x0b];
    const codeSec = sectb(
      10,
      [
        ...leb_u(2),
        ...leb_u(tlsBody.length),
        ...tlsBody,
        ...leb_u(ehBody.length),
        ...ehBody,
      ].flat(),
    );
    const mod = new Uint8Array([
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
    // The pass must walk every EH opcode without a "unknown opcode" throw. Run
    // both the unchecked (A1) and checked (A2) instrument paths.
    expect(() => instrument(mod)).not.toThrow();
    expect(() => instrument(mod, { checked: true })).not.toThrow();
    // The mem op inside the try was found + translated: the instrumented module
    // grows (the inline translate is bytes longer than the raw load).
    expect(instrument(mod).length).toBeGreaterThan(mod.length);
  });

  test("helper-call fallback (over inlineLimit) still faults + translates correctly (#164)", () => {
    // #164: a function whose inline instrumentation would exceed V8's max
    // function size is re-emitted with a CALL to __mmu_translate_ck instead of
    // the inline walk. Force that path for EVERY function with inlineLimit:1,
    // then prove the checked semantics are byte-for-byte preserved: a not-
    // present page faults exactly once (right kind), then the access succeeds.
    const V = HEAP + 0x64000;
    const bytes = instrument(buildCheckedFixture(), { checked: true, inlineLimit: 1 });
    const b = bootChecked(bytes, V);
    new Uint8Array(b.mem.buffer)[V] = 0x42;

    // load: kind=0 fault, then reads the byte (translated through the helper)
    expect(b.inst.exports.load_u8(V)).toBe(0x42);
    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 0 });
    // tp still sourced by calling __get_tls_base (fixture sentinel), unchanged
    expect(b.rawCalls[0].tp).toBe(0x1234);

    // store to a DIFFERENT not-present page: kind=1 fault, then writes
    const W = HEAP + 0x66000;
    // re-map W absent (bootChecked only made V absent); reuse the running inst
    const t = new Uint32Array(b.mem.buffer);
    const wpte = t[PT / 4 + (W >>> 22)] & ~0xfff;
    t[wpte / 4 + ((W >>> 12) & 0x3ff)] = 0;
    b.inst.exports.store_u8(W, 0x99);
    expect(new Uint8Array(b.mem.buffer)[W]).toBe(0x99);
    expect(b.calls.some((c) => c.ea === W && c.kind === 1)).toBe(true);
  });

  test("helper-call fallback yields a smaller module than the inline path (#164)", () => {
    // The point of the fallback: the helper-call body is materially smaller than
    // the inline walk, which is what keeps an over-limit function under V8's
    // ceiling. A tiny inlineLimit forces the fallback; the inline build (huge
    // limit) is the baseline. Same fixture, so any size delta is the emit mode.
    const inline = instrument(buildCheckedFixture(), { checked: true, inlineLimit: 1e9 });
    const viaHelper = instrument(buildCheckedFixture(), { checked: true, inlineLimit: 1 });
    expect(viaHelper.length).toBeLessThan(inline.length);
  });

  test("helper-call fallback: store fault (kind=1) + COW RO-page semantics (#164)", () => {
    // The checked helper (__mmu_translate_ck) must preserve the permission-aware
    // fault semantics the inline path has: a store to a not-present page faults
    // kind=1; a store to a PRESENT-but-read-only page (COW) ALSO faults kind=1
    // instead of writing through; a load from the RO page never faults.
    const bytes = instrument(buildCheckedFixture(), { checked: true, inlineLimit: 1 });
    // not-present store
    const V1 = HEAP + 0x70000;
    const b1 = bootChecked(bytes, V1);
    b1.inst.exports.store_u8(V1, 0x99);
    expect(b1.calls).toEqual([{ nr: NR_MMU_FAULT, ea: V1, kind: 1 }]);
    expect(new Uint8Array(b1.mem.buffer)[V1]).toBe(0x99);
    // present-but-RO: store faults (COW), load does not
    const V2 = HEAP + 0x78000;
    const b2 = bootChecked(bytes, undefined, V2);
    expect(b2.inst.exports.load_u8(V2)).toBe(0);
    expect(b2.calls.length).toBe(0);
    b2.inst.exports.store_u8(V2, 0xab);
    expect(b2.calls).toEqual([{ nr: NR_MMU_FAULT, ea: V2, kind: 1 }]);
    expect(new Uint8Array(b2.mem.buffer)[V2]).toBe(0xab);
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

  // #202 §6.2: the SPECIFIC hazard the combined-predicate rewrite introduces
  // (documented at length in emitCheckedPresentPredicate's doc comment) — a
  // not-present LEVEL-1 (PGD) entry whose UNCONDITIONAL level-2 read lands on
  // low-memory "garbage" that happens to satisfy the permission mask MUST
  // still fault, not silently walk through. If the `pgd_e != 0` conjunct were
  // dropped (or ANDed as a raw value instead of a normalised boolean), this
  // access would see the deceptive garbage's low bits, conclude "present +
  // correct permission", and read/write the WRONG physical address with no
  // fault at all — silent corruption. This test fails loudly instead: any
  // regression here manifests as either a wrong final value (walked through)
  // or a wrong/missing fault call, not a crash — exactly the class of bug
  // the task calls out.
  test("#202 hazard: not-present level-1 entry with deceptive garbage bits at the level-2 address still faults (load)", () => {
    const V = HEAP + 0x90000;
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes, undefined, undefined, V);
    new Uint8Array(b.mem.buffer)[V] = 0x5c; // the byte a WRONG (non-faulted) walk would also happen to read correctly if it landed on the SAME identity page — the fault-call assertion below is what actually proves the gate fired, not the returned value alone

    const val = b.inst.exports.load_u8(V);

    expect(b.calls.length).toBe(1); // MUST fault — not zero (walked through) and not unbounded (retry loop stuck on the garbage)
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 0 });
    expect(val).toBe(0x5c); // and, after the fault handler properly attaches the table, the access succeeds
  });

  test("#202 hazard: not-present level-1 entry with deceptive garbage bits at the level-2 address still faults (store)", () => {
    const V = HEAP + 0x98000;
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes, undefined, undefined, V);

    b.inst.exports.store_u8(V, 0x77);

    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 1 });
    expect(new Uint8Array(b.mem.buffer)[V]).toBe(0x77);
  });

  test("a store to a PRESENT-but-read-only page faults (COW/mprotect), then succeeds", () => {
    // The store-permission check: a copy-on-write page is mapped present but
    // write-protected. A store must fault (kind=1) into the kernel's
    // do_wp_page, NOT walk straight through to the shared physical page (which
    // would corrupt it). The mock handler upgrades the PTE to present+write.
    const V = HEAP + 0x70000;
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes, undefined, V); // V present-but-RO
    b.inst.exports.store_u8(V, 0xa5);
    expect(b.calls.length).toBe(1);
    expect(b.calls[0]).toEqual({ nr: NR_MMU_FAULT, ea: V, kind: 1 });
    expect(new Uint8Array(b.mem.buffer)[V]).toBe(0xa5);
  });

  test("a load from a PRESENT-but-read-only page does NOT fault", () => {
    // Loads need only _PAGE_PRESENT — a read-only (COW/mprotect-READ) page is
    // readable without a fault. Only stores gate on the write bit.
    const V = HEAP + 0x80000;
    const bytes = instrument(buildCheckedFixture(), { checked: true });
    const b = bootChecked(bytes, undefined, V); // V present-but-RO
    new Uint8Array(b.mem.buffer)[V] = 0x5a;
    expect(b.inst.exports.load_u8(V)).toBe(0x5a);
    expect(b.calls.length).toBe(0);
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

describe("checked + page-crossing scalar access (#202 §6.2 combined predicate, emitCheckedSplitLoad/Store)", () => {
  // A hand-built fixture identical in shape to buildCheckedFixture above, but
  // with a width>=4 i32.load/i32.store (opcode 0x28/0x36) instead of the
  // 1-byte ops — this is what actually routes through splitFns and exercises
  // the NEW emitCheckedSplitLoad/emitCheckedSplitStore code path (a width==1
  // access never crosses a page, so buildCheckedFixture's load_u8/store_u8
  // never reach it).
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

  function buildCheckedSplitFixture() {
    const types = [
      funcType([I32], [I32]), // 0: load_i32(va) -> i32
      funcType([I32, I32], []), // 1: store_i32(va, v)
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
    //   1: load_i32 (type 0)   2: store_i32 (type 1)   3: __get_tls_base (type 3)
    const funcSec = sectb(3, vecb([leb_u(0), leb_u(1), leb_u(3)]));
    const memSec = sectb(5, vecb([[0x00, ...leb_u(32)]]));
    const exports = [
      [...strb("memory"), 0x02, ...leb_u(0)],
      [...strb("load_i32"), 0x00, ...leb_u(1)],
      [...strb("store_i32"), 0x00, ...leb_u(2)],
      [...strb("__get_tls_base"), 0x00, ...leb_u(3)],
    ];
    const exportSec = sectb(7, vecb(exports));
    const readBody = [...leb_u(0), 0x20, 0x00, 0x28, 0x02, 0x00, 0x0b]; // i32.load align=2 off=0
    const writeBody = [...leb_u(0), 0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00, 0x0b]; // i32.store align=2 off=0
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

  /** Same shape/contract as the sibling `bootChecked` above, duplicated
   * locally (the split fixture's exports differ — load_i32/store_i32, not
   * load_u8/store_u8 — so it cannot literally reuse that closure, but the
   * page-table setup + mock fault handler are identical). */
  function bootCheckedSplit(instrumentedBytes, { notPresentVa, notPresentVa2, remap } = {}) {
    const mod = new WebAssembly.Module(instrumentedBytes);
    const calls = [];
    const spGlobal = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    let inst;
    const fault = (sp, tp, nr, ea, kind) => {
      calls.push({ nr: Number(nr), ea: Number(ea), kind: Number(kind) });
      const t = new Uint32Array(inst.exports.memory.buffer);
      const va = Number(ea) >>> 0;
      const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = (va & ~0xfff) | 7; // identity, present+write
      return 0;
    };
    inst = new WebAssembly.Instance(mod, {
      env: { __wasm_syscall_2: fault, __stack_pointer: spGlobal },
    });
    const mem = inst.exports.memory;
    const needPages = 64;
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
    const setAbsent = (va) => {
      va = va >>> 0;
      const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = 0;
    };
    if (notPresentVa !== undefined) setAbsent(notPresentVa);
    if (notPresentVa2 !== undefined) setAbsent(notPresentVa2);
    if (remap) {
      const setPte = (va, physBase) => {
        va = va >>> 0;
        const pteTable = t[PT / 4 + (va >>> 22)] & ~0xfff;
        t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = physBase | 7;
      };
      remap(setPte);
    }
    inst.exports.__mmu_pt_base.value = PT;
    if (inst.exports.__mmu_start) inst.exports.__mmu_start();
    return { inst, mem, calls };
  }

  test("present, within-page width>=2 access takes the fast arm: correct value, no fault", () => {
    const V = HEAP + 0x10000;
    const bytes = instrument(buildCheckedSplitFixture(), { checked: true });
    const b = bootCheckedSplit(bytes);
    b.inst.exports.store_i32(V, 0x11223344);
    expect(b.calls.length).toBe(0);
    expect(b.inst.exports.load_i32(V) >>> 0).toBe(0x11223344);
    expect(b.calls.length).toBe(0);
  });

  test("present, PAGE-CROSSING access takes the slow byte-helper arm and reaches the correct two (non-adjacent) physical frames — no fault (both pages present)", () => {
    // Mirrors the pre-#202 unchecked page-crossing test, but under CHECKED
    // mode with both pages present — proves the combined predicate's
    // page-fits conjunct correctly routes a straddling access to the
    // byte-wise helper even when the present+permission conjunct is true.
    const VB = HEAP + 0x20000;
    const P1 = HEAP + 0x30000;
    const P2 = HEAP + 0x50000; // deliberately NOT P1's next frame
    const b = bootCheckedSplit(instrument(buildCheckedSplitFixture(), { checked: true }), {
      remap: (setPte) => {
        setPte(VB, P1);
        setPte(VB + 0x1000, P2);
      },
    });
    const CROSS = VB + 0xffe; // spans [P1+0xffe,P1+0xfff] and [P2+0,P2+1]
    b.inst.exports.store_i32(CROSS, 0x11223344);
    expect(b.calls.length).toBe(0); // both pages present — no fault expected
    const u8 = new Uint8Array(b.mem.buffer);
    expect(u8[P1 + 0xffe]).toBe(0x44);
    expect(u8[P1 + 0xfff]).toBe(0x33);
    expect(u8[P2 + 0]).toBe(0x22);
    expect(u8[P2 + 1]).toBe(0x11);
    expect(u8[P1 + 0x1000]).toBe(0); // NOT the frame physically after P1
    expect(b.inst.exports.load_i32(CROSS) >>> 0).toBe(0x11223344);
    expect(b.calls.length).toBe(0);
  });

  test("not-present, WITHIN-page width>=2 access: predicate rejects it (not present), byte-helper faults it in, then succeeds", () => {
    const V = HEAP + 0x60000;
    const bytes = instrument(buildCheckedSplitFixture(), { checked: true });
    const b = bootCheckedSplit(bytes, { notPresentVa: V });
    b.inst.exports.store_i32(V, 0xdeadbeef);
    // the byte-wise helper fault-checks per BYTE (4 bytes here, all on the
    // same not-present page) — assert it faulted (>=1) and, critically,
    // landed on the right value with the right kind every time it did.
    expect(b.calls.length).toBeGreaterThan(0);
    for (const c of b.calls) expect(c).toEqual({ nr: NR_MMU_FAULT, ea: c.ea, kind: 1 });
    expect(new Uint8Array(b.mem.buffer)[V]).toBe(0xef);
    expect(b.inst.exports.load_i32(V) >>> 0).toBe(0xdeadbeef);
  });

  test("not-present, PAGE-CROSSING width>=2 access: each not-present page faults independently, then succeeds", () => {
    const VB = HEAP + 0x70000;
    const b = bootCheckedSplit(instrument(buildCheckedSplitFixture(), { checked: true }), {
      notPresentVa: VB, // page containing VB
      notPresentVa2: VB + 0x1000, // the NEXT virtual page
    });
    const CROSS = VB + 0xffe;
    b.inst.exports.store_i32(CROSS, 0x89abcdef);
    expect(b.calls.length).toBeGreaterThan(0);
    for (const c of b.calls) expect(c.kind).toBe(1);
    expect(b.inst.exports.load_i32(CROSS) >>> 0).toBe(0x89abcdef);
  });

  test("#202 hazard (split path): not-present level-1 entry with deceptive garbage bits at the level-2 address still faults", () => {
    // Same hazard as the plain (non-split) test above, exercised through
    // emitCheckedSplitStore's own combined-predicate call site.
    const V = HEAP + 0x80000;
    const mod = new WebAssembly.Module(instrument(buildCheckedSplitFixture(), { checked: true }));
    const calls = [];
    const spGlobal = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
    let inst;
    const fault = (sp, tp, nr, ea, kind) => {
      calls.push({ nr: Number(nr), ea: Number(ea), kind: Number(kind) });
      const t = new Uint32Array(inst.exports.memory.buffer);
      const va = Number(ea) >>> 0;
      const g = va >>> 22;
      if (t[PT / 4 + g] === 0) t[PT / 4 + g] = (PT + 0x1000 + g * 0x1000) | 3;
      const pteTable = t[PT / 4 + g] & ~0xfff;
      t[pteTable / 4 + ((va >>> 12) & 0x3ff)] = (va & ~0xfff) | 7;
      return 0;
    };
    inst = new WebAssembly.Instance(mod, {
      env: { __wasm_syscall_2: fault, __stack_pointer: spGlobal },
    });
    const mem = inst.exports.memory;
    if (mem.buffer.byteLength < 64 * 65536) mem.grow(64 - mem.buffer.byteLength / 65536);
    const t = new Uint32Array(mem.buffer);
    const pages = mem.buffer.byteLength / PAGE;
    const nPgd = Math.ceil(pages / 1024);
    for (let g = 0; g < nPgd; g++) {
      const pteTable = PT + 0x1000 + g * 0x1000;
      t[PT / 4 + g] = pteTable | 3;
      for (let k = 0; k < 1024; k++) {
        const p = g * 1024 + k;
        t[pteTable / 4 + k] = p < pages ? (p << 12) | 7 : 0;
      }
    }
    t[PT / 4 + (V >>> 22)] = 0; // level-1 absent
    t[(V >>> 12) & 0x3ff] = 0xffffffff; // deceptive garbage at the landing address
    inst.exports.__mmu_pt_base.value = PT;
    if (inst.exports.__mmu_start) inst.exports.__mmu_start();

    inst.exports.store_i32(V, 0x01020304);

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.kind).toBe(1);
    expect(inst.exports.load_i32(V) >>> 0).toBe(0x01020304);
  });
});

describe("concatBytes — code-section assembly must not use Array.flat", () => {
  test("byte-exact concatenation of mixed number[] / Uint8Array chunks", () => {
    const chunks = [[1, 2, 3], new Uint8Array([4, 5]), [], new Uint8Array([]), [6]];
    const out = concatBytes(chunks);
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("empty input yields an empty Uint8Array", () => {
    const out = concatBytes([]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(0);
  });

  test("truncates each byte to 8 bits exactly like a wasm code section copy", () => {
    // values are always emitted as bytes upstream; assert the typed-array copy
    // semantics are the ones the assembler relies on (no accidental widening).
    expect([...concatBytes([[0xff, 0x100 & 0xff], new Uint8Array([0x00])])]).toEqual([
      0xff, 0x00, 0x00,
    ]);
  });

  // NOTE: the bug this replaced — `newCodeEntries.flat()` throwing
  // `RangeError: Invalid array length` on nix.wasm's ~hundreds-of-MB
  // instrumented code section — is V8-specific (Array.flat's FixedArray
  // ceiling, ~128M elements). These engine unit tests run under bun
  // (JavaScriptCore), which has a different/higher ceiling, so the crash can
  // only be reproduced end-to-end by the Node boot smoke (mmu prove-then-flip);
  // asserting `.flat()` throws here would be a false engine-specific gate.
});

describe("ByteSink — #202 streaming encoder", () => {
  // Local LEB128 decoders mirroring softmmu-pass.js's internal (unexported)
  // readU/readS, so these tests can read back what ByteSink wrote without
  // depending on module internals — same technique the checked-translate
  // fixture builder above already uses for leb_u/leb_s.
  function decodeU(b, i = 0) {
    let r = 0,
      sh = 0,
      x;
    do {
      x = b[i++];
      r += (x & 0x7f) * 2 ** sh;
      sh += 7;
    } while (x & 0x80);
    return [r >>> 0, i];
  }

  test("push (variadic, Array.push-compatible) + toUint8Array", () => {
    const sink = new ByteSink();
    sink.push(1, 2, 3);
    sink.push(4);
    expect([...sink.toUint8Array()]).toEqual([1, 2, 3, 4]);
    expect(sink.len).toBe(4);
  });

  test("pushBytes accepts both number[] and Uint8Array sources", () => {
    const sink = new ByteSink();
    sink.pushBytes([1, 2, 3]);
    sink.pushBytes(new Uint8Array([4, 5]));
    sink.pushBytes([]); // empty is a no-op
    sink.pushBytes(new Uint8Array([]));
    expect([...sink.toUint8Array()]).toEqual([1, 2, 3, 4, 5]);
  });

  test("grows past its initial capacity (doubling) without losing or corrupting bytes", () => {
    const sink = new ByteSink(4); // deliberately tiny — forces several doublings
    const n = 10_000;
    for (let k = 0; k < n; k++) sink.push(k & 0xff);
    const out = sink.toUint8Array();
    expect(out.length).toBe(n);
    for (let k = 0; k < n; k++) expect(out[k]).toBe(k & 0xff);
  });

  test("reserve() returns the pre-reservation offset and leaves room for later content", () => {
    const sink = new ByteSink();
    sink.push(0xaa);
    const off = sink.reserve(5);
    expect(off).toBe(1);
    expect(sink.len).toBe(6);
    sink.push(0xbb);
    expect(sink.len).toBe(7);
    expect(sink.toUint8Array()[6]).toBe(0xbb);
  });

  test("truncating .len (the discard-and-retry pattern #164's fallback uses) drops already-written bytes", () => {
    // Mirrors instrument()'s "emit inline, discover it's too big, roll back to
    // just past the reserved size field, re-emit via the helper path" dance —
    // the exact mechanism that lets a single shared sink replace the old
    // per-function number[] + a second whole-body re-emission on overflow.
    const sink = new ByteSink();
    const off = sink.reserve(5);
    const bodyStart = sink.len;
    sink.push(1, 2, 3, 4, 5); // "inline" attempt — too big, discard it
    expect(sink.len).toBe(bodyStart + 5);
    sink.len = bodyStart; // roll back
    sink.push(9, 9); // "helper" attempt — smaller, kept
    sink.patch5(off, sink.len - bodyStart);
    const out = sink.toUint8Array();
    expect(out.length).toBe(5 + 2);
    expect([...out.subarray(5)]).toEqual([9, 9]);
    expect(decodeU(out, off)[0]).toBe(2);
  });

  // #202: "V8 was directly verified to accept padded 5-byte LEBs for section
  // size, body size, and vector count" — these boundary values are exactly
  // where a MINIMAL LEB128 encoding changes byte-length (1→2 bytes at 128,
  // 2→3 at 16384, 3→4 at 2097152, 4→5 at 268435456), so a decoder that only
  // ever saw minimal encodings could plausibly special-case the byte count.
  // patch5 always emits exactly 5 bytes regardless of which side of a
  // boundary `value` falls on; assert both the padded WIDTH (always 5) and
  // that decoding round-trips to the exact original value on every one of
  // these boundaries, plus 0 and the full 32-bit max.
  const LEB_BOUNDARY_VALUES = [
    0, // minimal 1 byte (all-zero case)
    1,
    127, // last value a minimal 1-byte LEB can hold
    128, // first value that NEEDS a minimal 2nd byte
    16383, // last minimal-2-byte value
    16384, // first minimal-3-byte value
    2097151, // last minimal-3-byte value
    2097152, // first minimal-4-byte value
    268435455, // last minimal-4-byte value
    268435456, // first minimal-5-byte value (padded and minimal coincide here)
    0xffffffff, // full 32-bit max (minimal encoding is ALSO 5 bytes here)
  ];

  test("patch5: padded 5-byte LEB round-trips every value across every LEB byte-length boundary", () => {
    for (const v of LEB_BOUNDARY_VALUES) {
      const sink = new ByteSink();
      const off = sink.reserve(5);
      sink.patch5(off, v);
      const bytes = sink.toUint8Array();
      expect(bytes.length).toBe(5);
      // padded: the first 4 bytes carry the continuation bit UNCONDITIONALLY,
      // the 5th never does — this is what distinguishes "padded" from
      // "minimal" and is exactly what #202 verified V8 accepts.
      for (let k = 0; k < 4; k++) expect(bytes[k] & 0x80).toBe(0x80);
      expect(bytes[4] & 0x80).toBe(0);
      const [decoded, next] = decodeU(bytes, 0);
      expect(decoded).toBe(v >>> 0);
      expect(next).toBe(5);
    }
  });

  test("pushPadded5 (reserve+patch5 for an already-known value) matches manual reserve/patch5", () => {
    for (const v of [0, 128, 16384, 268435456, 0xffffffff]) {
      const a = new ByteSink();
      a.pushPadded5(v);
      const b = new ByteSink();
      const off = b.reserve(5);
      b.patch5(off, v);
      expect([...a.toUint8Array()]).toEqual([...b.toUint8Array()]);
    }
  });

  test("reserve+write-real-content+patch5 round-trips (declared length == actual content length), at every SMALL/MEDIUM boundary", () => {
    // The actual USE pattern instrument() relies on: reserve 5, write N REAL
    // bytes of content, patch the reserved field with N — proven here with
    // genuine content (not just a patched-in number) at every 1-, 2-, and
    // 3-byte-LEB boundary from the list above. (The 4-/5-byte boundaries
    // (2097152+) are covered by the pure patch5 round-trip test above, where
    // writing that many real bytes would defeat the point of this fast unit
    // test; the end-to-end "instrument() output" test below additionally
    // proves a REAL, much larger code section's declared size is consistent.)
    for (const n of [0, 1, 127, 128, 16383, 16384]) {
      const sink = new ByteSink();
      const off = sink.reserve(5);
      const start = sink.len;
      for (let k = 0; k < n; k++) sink.push(k & 0xff);
      const bodyLen = sink.len - start;
      expect(bodyLen).toBe(n);
      sink.patch5(off, bodyLen);
      const out = sink.toUint8Array();
      const [decodedLen, afterLen] = decodeU(out, off);
      expect(decodedLen).toBe(n);
      // and the declared length really does span exactly the written content
      expect(out.length - afterLen).toBe(n);
      for (let k = 0; k < n; k++) expect(out[afterLen + k]).toBe(k & 0xff);
    }
  });

  test("instrument() output: the code section's declared size and every function's declared body size read back exactly (real pass, real fixture)", () => {
    // End-to-end proof that the padded fields instrument() ACTUALLY emits
    // (not just the ByteSink primitive in isolation) decode correctly and are
    // internally consistent: the code section's own size must equal its true
    // byte content, and the sum of (5-byte size field + body) over every
    // vector entry must exactly fill it — i.e. no drift between what was
    // reserved/patched and what was actually written.
    const out = instrument(prog, { exportControls: true });
    expect(out[0]).toBe(0x00);
    expect(out[1]).toBe(0x61); // "wasm" magic, sanity
    let i = 8;
    let codeSecStart = -1;
    let codeSecBodyLen = -1;
    while (i < out.length) {
      const id = out[i++];
      const [size, next] = decodeU(out, i);
      i = next;
      if (id === 10) {
        codeSecStart = i;
        codeSecBodyLen = size;
      }
      i += size;
    }
    expect(codeSecStart).toBeGreaterThan(0);
    expect(codeSecStart + codeSecBodyLen).toBeLessThanOrEqual(out.length);
    // walk the code section's own function vector and confirm each declared
    // body size is consistent (sum of size-field-relative body lengths does
    // not run past the section's own declared end).
    let j = codeSecStart;
    const [nFuncs, afterCount] = decodeU(out, j);
    j = afterCount;
    let seen = 0;
    const sectionEnd = codeSecStart + codeSecBodyLen;
    while (j < sectionEnd) {
      const [bodyLen, afterLen] = decodeU(out, j);
      j = afterLen + bodyLen;
      seen++;
    }
    expect(j).toBe(sectionEnd); // no drift: bodies exactly fill the section
    expect(seen).toBe(nFuncs);
  });
});
