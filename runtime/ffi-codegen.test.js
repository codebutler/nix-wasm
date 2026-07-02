// ffi-codegen.test.js — the runtime FFI trampoline generator (#126 Track C /
// #130). Exercises BOTH ABIs against REAL wasm targets installed in a shared
// table: the raw signature path AND the canonical (i64×128)→i64 fpcast path,
// the latter against a genuinely fpcast'd target module (max-func-params@128,
// matching CANONICAL_PARAMS / userspace/fpcast-emu.nix).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DynamicLoader, exportedElemSlots, parseDylinkModule } from "./dylink.js";
import { CANONICAL_PARAMS, FfiTrampolines, genTrampoline } from "./ffi-codegen.js";

const FIX = new URL("./test-fixtures/ffi/", import.meta.url);
const fixture = (name) => new Uint8Array(readFileSync(new URL(name, FIX)));

// A shared harness: instantiate a targets module (raw or fpcast) as "main" via
// the DynamicLoader (so its elem slots are known), and stand up an
// FfiTrampolines over the same Memory + table.
function harness(name) {
  const bytes = fixture(name);
  const memory = new WebAssembly.Memory({ initial: 16 });
  const info = parseDylinkModule(bytes);
  const table = new WebAssembly.Table({
    initial: Math.max(64, 1 + info.tableImportInitial),
    element: "anyfunc",
  });
  const baseEnv = {
    memory,
    __indirect_function_table: table,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0x100),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 1),
    __table_base32: new WebAssembly.Global({ value: "i32", mutable: false }, 1),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 0xff00),
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: baseEnv,
    "GOT.mem": new Proxy(
      {},
      { get: () => new WebAssembly.Global({ value: "i32", mutable: true }, 0) },
    ),
    "GOT.func": new Proxy(
      {},
      { get: () => new WebAssembly.Global({ value: "i32", mutable: true }, 0) },
    ),
  });
  if (instance.exports.__wasm_apply_data_relocs) instance.exports.__wasm_apply_data_relocs();
  const loader = new DynamicLoader({ memory, table, baseEnv });
  loader.registerMain({ instance, bytes, memoryBase: 0x100, tableBase: 1 });
  const ffi = new FfiTrampolines({ memory, table });
  const slots = exportedElemSlots(info);
  const slotOf = (sym) => 1 + slots.get(sym); // tableBase 1 + elem slot
  const dv = new DataView(memory.buffer);
  return { memory, table, loader, ffi, slotOf, dv, instance };
}

describe("genTrampoline byte output", () => {
  test("produces a valid instantiable module (raw)", () => {
    const bytes = genTrampoline({ params: ["i32", "i32"], result: "i32" });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
      env: { memory, __indirect_function_table: table },
    });
    expect(typeof inst.exports.trampoline).toBe("function");
  });

  test("canonical module has the (i64×N)->i64 target type", () => {
    // A smoke check that CANONICAL_PARAMS large modules still assemble.
    const bytes = genTrampoline({ params: ["f64", "i32"], result: "i64" }, { canonical: true });
    expect(bytes[0]).toBe(0); // \0asm
    expect(CANONICAL_PARAMS).toBe(128);
    new WebAssembly.Module(bytes); // must validate
  });
});

describe("raw ABI trampolines (non-fpcast targets)", () => {
  test("i32/i32->i32, i64, f64, f32, and a 10-arg i32 call past the old K bound", () => {
    const h = harness("targets.wasm");
    const argPtr = 0x1000;
    const retPtr = 0x2000;

    // add(19, 23) = 42
    h.dv.setInt32(argPtr, 19, true);
    h.dv.setInt32(argPtr + 8, 23, true);
    h.ffi.call({ params: ["i32", "i32"], result: "i32" }, false, h.slotOf("add"), argPtr, retPtr);
    expect(h.dv.getInt32(retPtr, true)).toBe(42);

    // mulll(1_000_000_000, 7) = 7e9 (i64 arg + i64 return)
    h.dv.setBigInt64(argPtr, 1000000000n, true);
    h.dv.setInt32(argPtr + 8, 7, true);
    h.ffi.call({ params: ["i64", "i32"], result: "i64" }, false, h.slotOf("mulll"), argPtr, retPtr);
    expect(h.dv.getBigInt64(retPtr, true)).toBe(7000000000n);

    // scaled(2.5, 4.0) = 11.0
    h.dv.setFloat64(argPtr, 2.5, true);
    h.dv.setFloat64(argPtr + 8, 4.0, true);
    h.ffi.call(
      { params: ["f64", "f64"], result: "f64" },
      false,
      h.slotOf("scaled"),
      argPtr,
      retPtr,
    );
    expect(h.dv.getFloat64(retPtr, true)).toBe(11.0);

    // mixf(3.0, 4.0) = 10.0
    h.dv.setFloat32(argPtr, 3.0, true);
    h.dv.setFloat32(argPtr + 8, 4.0, true);
    h.ffi.call({ params: ["f32", "f32"], result: "f32" }, false, h.slotOf("mixf"), argPtr, retPtr);
    expect(h.dv.getFloat32(retPtr, true)).toBe(10.0);

    // sum10(1..10) = 55 — 10 args, past the K=... "mixed" bound and trivially
    // within all-i32; the point is unbounded arity via codegen.
    for (let i = 0; i < 10; i++) h.dv.setInt32(argPtr + i * 8, i + 1, true);
    h.ffi.call(
      { params: Array.from({ length: 10 }, () => "i32"), result: "i32" },
      false,
      h.slotOf("sum10"),
      argPtr,
      retPtr,
    );
    expect(h.dv.getInt32(retPtr, true)).toBe(55);
  });

  test("void result with a pointer arg (struct-return / out-param lowering)", () => {
    const h = harness("targets.wasm");
    const argPtr = 0x1000;
    const outPtr = 0x3000;
    // store_sum(out, 5, 6): out written to *outPtr
    h.dv.setInt32(argPtr, outPtr, true);
    h.dv.setInt32(argPtr + 8, 5, true);
    h.dv.setInt32(argPtr + 16, 6, true);
    h.ffi.call(
      { params: ["i32", "i32", "i32"], result: null },
      false,
      h.slotOf("store_sum"),
      argPtr,
      0,
    );
    expect(h.dv.getInt32(outPtr, true)).toBe(11);
  });

  test("trampolines are cached per (canonical, signature)", () => {
    const h = harness("targets.wasm");
    h.dv.setInt32(0x1000, 1, true);
    h.dv.setInt32(0x1008, 2, true);
    h.ffi.call({ params: ["i32", "i32"], result: "i32" }, false, h.slotOf("add"), 0x1000, 0x2000);
    expect(h.ffi.cache.size).toBe(1);
    h.ffi.call({ params: ["i32", "i32"], result: "i32" }, false, h.slotOf("add"), 0x1000, 0x2000);
    expect(h.ffi.cache.size).toBe(1); // same key, no new module
  });
});

describe("canonical ABI trampolines (fpcast'd targets)", () => {
  // The fpcast'd targets have EVERY function rewritten to (i64×128)->i64
  // thunks; a raw-signature trampoline would trap. The canonical trampoline
  // marshals through the same wide ABI binaryen produced.
  test("i32/i64/f64/f32 args and results dispatch through the canonical thunk", () => {
    const h = harness("targets.fpcast.wasm");
    const argPtr = 0x1000;
    const retPtr = 0x2000;

    h.dv.setInt32(argPtr, 19, true);
    h.dv.setInt32(argPtr + 8, 23, true);
    h.ffi.call({ params: ["i32", "i32"], result: "i32" }, true, h.slotOf("add"), argPtr, retPtr);
    expect(h.dv.getInt32(retPtr, true)).toBe(42);

    h.dv.setBigInt64(argPtr, 1000000000n, true);
    h.dv.setInt32(argPtr + 8, 7, true);
    h.ffi.call({ params: ["i64", "i32"], result: "i64" }, true, h.slotOf("mulll"), argPtr, retPtr);
    expect(h.dv.getBigInt64(retPtr, true)).toBe(7000000000n);

    h.dv.setFloat64(argPtr, 2.5, true);
    h.dv.setFloat64(argPtr + 8, 4.0, true);
    h.ffi.call({ params: ["f64", "f64"], result: "f64" }, true, h.slotOf("scaled"), argPtr, retPtr);
    expect(h.dv.getFloat64(retPtr, true)).toBe(11.0);

    h.dv.setFloat32(argPtr, 3.0, true);
    h.dv.setFloat32(argPtr + 8, 4.0, true);
    h.ffi.call({ params: ["f32", "f32"], result: "f32" }, true, h.slotOf("mixf"), argPtr, retPtr);
    expect(h.dv.getFloat32(retPtr, true)).toBe(10.0);
  });

  test("a RAW trampoline against a fpcast'd target traps (why the mode matters)", () => {
    const h = harness("targets.fpcast.wasm");
    h.dv.setInt32(0x1000, 1, true);
    h.dv.setInt32(0x1008, 2, true);
    expect(() =>
      h.ffi.call({ params: ["i32", "i32"], result: "i32" }, false, h.slotOf("add"), 0x1000, 0x2000),
    ).toThrow();
  });
  test("the loader structurally detects the @128 canonical width", () => {
    // The production fpcast width (userspace/fpcast-emu.nix -pa
    // max-func-params@128 == CANONICAL_PARAMS). isCanonicalSlot drives the
    // host raw-vs-canonical trampoline choice in kernel-worker.
    const raw = harness("targets.wasm");
    expect(raw.loader.isCanonicalSlot(raw.slotOf("add"))).toBe(false);
    const fp = harness("targets.fpcast.wasm");
    expect(fp.loader.isCanonicalSlot(fp.slotOf("add"))).toBe(true);
  });
});
