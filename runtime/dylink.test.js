// dylink.test.js — engine unit tests for the runtime dynamic loader (#126
// Track C / #130). Fixtures are REAL PIC dylink modules built with the
// production link model (test-fixtures/dylink/build.sh) so the tests exercise
// the actual wasm-ld/binaryen ABI, not a mock: GOT.mem/GOT.func resolution,
// elem-slot dlsym, the fpcast canonical-thunk rule, ctor/data-reloc gating,
// and the fork/clone replay contract (Track 0 §4).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DynamicLoader, exportedElemSlots, parseDylinkModule } from "./dylink.js";

const FIX = new URL("./test-fixtures/dylink/", import.meta.url);
const fixture = (name) => new Uint8Array(readFileSync(new URL(name, FIX)));

const MAIN_MEMORY_BASE = 0x100; // the "kernel"-chosen data_start for main
const MAIN_TABLE_BASE = 1; // slot 0 stays null (the NULL function pointer)

/**
 * Instantiate a fixture main module the way kernel-worker.js does (same import
 * shape), register it in a fresh loader, and return the harness pieces.
 */
function bootMain(name) {
  const bytes = fixture(name);
  const memory = new WebAssembly.Memory({ initial: 32 });
  const info = parseDylinkModule(bytes);
  const table = new WebAssembly.Table({
    initial: Math.max(64, MAIN_TABLE_BASE + info.tableImportInitial),
    element: "anyfunc",
  });
  const baseEnv = {
    memory,
    __indirect_function_table: table,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MAIN_MEMORY_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, MAIN_TABLE_BASE),
    __table_base32: new WebAssembly.Global({ value: "i32", mutable: false }, MAIN_TABLE_BASE),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 0xfff0),
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
  const ex = /** @type {any} */ (instance.exports);
  if (ex.__wasm_apply_data_relocs) ex.__wasm_apply_data_relocs();
  const loader = new DynamicLoader({ memory, table, baseEnv });
  loader.registerMain({
    instance,
    bytes,
    memoryBase: MAIN_MEMORY_BASE,
    tableBase: MAIN_TABLE_BASE,
  });
  // The fixture main's bump allocator stands in for guest malloc.
  const alloc = (n, align) => Number(ex.alloc(n, Math.max(1, align)));
  return { bytes, memory, table, baseEnv, instance, loader, alloc, exports: ex };
}

/** Guest-style dlopen: probe → alloc(memSize) → load. */
function dlopen(h, name, opts = {}) {
  const bytes = fixture(name);
  const probed = h.loader.probe(bytes);
  expect(typeof probed).toBe("object");
  const memoryBase = h.alloc(Math.max(1, probed.memSize), 1 << probed.memAlign);
  const handle = h.loader.load(bytes, memoryBase, { name, ...opts });
  expect(handle).toBeGreaterThan(1);
  return { handle, memoryBase, probed };
}

describe("parseDylinkModule", () => {
  test("reads dylink.0 mem/table requirements", () => {
    const info = parseDylinkModule(fixture("side.wasm"));
    expect(info.dylink).not.toBeNull();
    expect(info.dylink.memSize).toBeGreaterThan(0); // side_data + pointers
    expect(info.elem).not.toBeNull();
    expect(info.elem.funcIndices.length).toBeGreaterThan(0);
  });

  test("maps exported address-taken functions to elem slots", () => {
    const info = parseDylinkModule(fixture("side.wasm"));
    const slots = exportedElemSlots(info);
    expect(slots.has("side_taken")).toBe(true); // address-taken
    expect(slots.has("side_fn")).toBe(false); // exported, never address-taken
  });

  test("rejects non-wasm bytes", () => {
    expect(() => parseDylinkModule(new Uint8Array([1, 2, 3, 4]))).toThrow(/magic/);
  });
});

describe("DynamicLoader.load", () => {
  test("loads a side module: imports, data relocs, ctors, exports", () => {
    const h = bootMain("main.wasm");
    const { handle, memoryBase } = dlopen(h, "side.wasm");
    const side = h.loader.modules[handle - 1];

    // Its exports run and see their own relocated data (side_data = 42).
    expect(side.instance.exports.side_fn(1, 2)).toBe(45);

    // Direct env import + GOT.mem data import resolved against main:
    // call_main(x) = main_helper(x) + main_data = (x + 1000) + 1000.
    expect(side.instance.exports.call_main(5)).toBe(2005);

    // The ctor ran (ctor_ran = 1) — read through dlsym's data address.
    const ctorAddr = h.loader.dlsym(handle, "ctor_ran");
    expect(ctorAddr).toBeGreaterThan(memoryBase - 1);
    expect(new DataView(h.memory.buffer).getInt32(ctorAddr, true)).toBe(1);

    // __wasm_apply_data_relocs ran: side_reloc_ptr points at side_data.
    const relocPtr = h.loader.dlsym(handle, "side_reloc_ptr");
    const sideDataAddr = h.loader.dlsym(handle, "side_data");
    expect(new DataView(h.memory.buffer).getUint32(relocPtr, true)).toBe(sideDataAddr);
    expect(new DataView(h.memory.buffer).getInt32(sideDataAddr, true)).toBe(42);
  });

  test("GOT.func of a main export works through a call_indirect", () => {
    const h = bootMain("main.wasm");
    const { handle } = dlopen(h, "side.wasm");
    const side = h.loader.modules[handle - 1];
    // call_through_ptr calls imported_fn_ptr = &not_taken (GOT.func.not_taken),
    // dynamically installed since plain main.wasm has no elem slot for it.
    expect(side.instance.exports.call_through_ptr(3)).toBe(10);
  });

  test("chained side modules resolve each other's exports in load order", () => {
    const h = bootMain("main.wasm");
    dlopen(h, "side.wasm");
    const { handle } = dlopen(h, "side2.wasm");
    const side2 = h.loader.modules[handle - 1];
    // side2_sum(x) = side_fn(x, x) = 2x + 42.
    expect(side2.instance.exports.side2_sum(10)).toBe(62);
  });

  test("RTLD_LOCAL modules are skipped in later import resolution", () => {
    const h = bootMain("main.wasm");
    dlopen(h, "side.wasm", { global: false });
    const bytes = fixture("side2.wasm");
    const probed = h.loader.probe(bytes);
    const rc = h.loader.load(bytes, h.alloc(Math.max(1, probed.memSize), 1), {
      name: "side2.wasm",
    });
    expect(rc).toBeLessThan(0); // side_fn not visible from a local module
  });

  test("missing symbols fail the load with ENOEXEC", () => {
    const h = bootMain("main.wasm");
    const rc = h.loader.load(fixture("side2.wasm"), h.alloc(64, 1), { name: "side2.wasm" });
    expect(rc).toBe(-8); // side_fn never loaded
  });

  test("non-dylink bytes fail probe/load cleanly", () => {
    const h = bootMain("main.wasm");
    expect(h.loader.probe(new Uint8Array([0, 1, 2]))).toBe(-22);
    expect(h.loader.load(new Uint8Array([0, 1, 2]), 0)).toBe(-22);
  });
});

describe("DynamicLoader.dlsym", () => {
  test("function symbols: elem slot preferred, dynamic install as fallback", () => {
    const h = bootMain("main.wasm");
    const { handle } = dlopen(h, "side.wasm");
    const side = h.loader.modules[handle - 1];

    // side_taken is address-taken → its address must be its elem slot.
    const takenIdx = h.loader.dlsym(handle, "side_taken");
    expect(takenIdx).toBe(side.tableBase + side.elemSlots.get("side_taken"));
    expect(h.table.get(takenIdx)(9)).toBe(4); // x - 5

    // side_fn is not address-taken → dynamic install past the module range,
    // stable across repeated dlsym calls.
    const fnIdx = h.loader.dlsym(handle, "side_fn");
    expect(fnIdx).toBeGreaterThanOrEqual(side.tableBase + side.tableCount);
    expect(h.loader.dlsym(handle, "side_fn")).toBe(fnIdx);
    expect(h.table.get(fnIdx)(2, 3)).toBe(47);
  });

  test("handle 0 = RTLD_DEFAULT searches main + globals in load order", () => {
    const h = bootMain("main.wasm");
    dlopen(h, "side.wasm");
    expect(h.loader.dlsym(0, "main_helper")).toBeGreaterThan(0);
    expect(h.loader.dlsym(0, "side_fn")).toBeGreaterThan(0);
    expect(h.loader.dlsym(0, "no_such_symbol")).toBe(0);
  });

  test("data symbols resolve to absolute addresses (memoryBase + relative)", () => {
    const h = bootMain("main.wasm");
    const addr = h.loader.dlsym(1, "main_data");
    expect(addr).toBeGreaterThanOrEqual(MAIN_MEMORY_BASE);
    expect(new DataView(h.memory.buffer).getInt32(addr, true)).toBe(1000);
  });
});

describe("the fpcast canonical-thunk rule", () => {
  // Canonical ABI for the fixtures: (i64 × 8) → i64 (max-func-params@8).
  const canonArgs = (...vals) => {
    const a = Array.from({ length: 8 }, () => 0n);
    vals.forEach((v, i) => {
      a[i] = BigInt(v);
    });
    return a;
  };

  test("dlsym on a fpcast'd side module returns the canonical thunk slot", () => {
    const h = bootMain("main.dynsym.fpcast.wasm");
    const { handle } = dlopen(h, "side.dynsym.fpcast.wasm");
    const idx = h.loader.dlsym(handle, "side_taken");
    const thunk = h.table.get(idx);
    // The slot holds the canonical (i64×8)→i64 thunk, not the raw export:
    // callable with the wide signature, dispatching to side_taken(x) = x - 5.
    expect(thunk(...canonArgs(9))).toBe(4n);
  });

  test("fpcast'd GOT.func through a dynsym-injected main works end-to-end", () => {
    const h = bootMain("main.dynsym.fpcast.wasm");
    const { handle } = dlopen(h, "side.dynsym.fpcast.wasm");
    const side = h.loader.modules[handle - 1];
    // call_through_ptr does a CANONICAL call_indirect through
    // GOT.func.not_taken. main.dynsym.fpcast has not_taken in its elem segment
    // (the injector put it there; fpcast thunked it) → resolves to the thunk
    // → the wide call dispatches correctly: not_taken(3) = 10.
    expect(side.instance.exports.call_through_ptr(3)).toBe(10);
  });

  test("WITHOUT dynsym injection the same call traps (the #33 revert, reproduced)", () => {
    const h = bootMain("main.fpcast.wasm");
    const { handle } = dlopen(h, "side.dynsym.fpcast.wasm");
    const side = h.loader.modules[handle - 1];
    // main.fpcast.wasm has NO elem slot for not_taken → the loader falls back
    // to installing the raw export → the canonical call_indirect signature
    // mismatches → trap. This documents WHY the dynsym-inject seam exists.
    expect(() => side.instance.exports.call_through_ptr(3)).toThrow();
  });

  test("every exported function of a dynsym-injected module has an elem slot", () => {
    const info = parseDylinkModule(fixture("main.dynsym.fpcast.wasm"));
    const slots = exportedElemSlots(info);
    for (const e of info.exports) {
      if (e.kind === 0) expect(slots.has(e.name)).toBe(true);
    }
  });
});

describe("fork/clone replay (Track 0 §4)", () => {
  test("replay reproduces the exact table layout without re-running ctors/relocs", () => {
    // Parent: load side + side2, then dlsym a non-elem function (dynamic install).
    const parent = bootMain("main.wasm");
    const a = dlopen(parent, "side.wasm");
    dlopen(parent, "side2.wasm");
    const dynIdx = parent.loader.dlsym(a.handle, "side_fn");
    const takenIdx = parent.loader.dlsym(a.handle, "side_taken");
    const snap = parent.loader.snapshot();

    // Child: same memory contents (CLONE_VM shares; fork copies) — simulate by
    // reusing the parent's memory with a FRESH table + instances, exactly the
    // new-worker situation.
    const childBytes = fixture("main.wasm");
    const childInfo = parseDylinkModule(childBytes);
    const childTable = new WebAssembly.Table({
      initial: Math.max(64, MAIN_TABLE_BASE + childInfo.tableImportInitial),
      element: "anyfunc",
    });
    const childEnv = { ...parent.baseEnv, __indirect_function_table: childTable };
    const childInstance = new WebAssembly.Instance(new WebAssembly.Module(childBytes), {
      env: childEnv,
      "GOT.mem": new Proxy(
        {},
        { get: () => new WebAssembly.Global({ value: "i32", mutable: true }, 0) },
      ),
      "GOT.func": new Proxy(
        {},
        { get: () => new WebAssembly.Global({ value: "i32", mutable: true }, 0) },
      ),
    });
    // NOTE: no __wasm_apply_data_relocs on the child either — shared memory.
    const childLoader = new DynamicLoader({
      memory: parent.memory,
      table: childTable,
      baseEnv: childEnv,
    });
    childLoader.registerMain({
      instance: childInstance,
      bytes: childBytes,
      memoryBase: MAIN_MEMORY_BASE,
      tableBase: MAIN_TABLE_BASE,
    });
    childLoader.replay(snap);

    // Identical layout: the parent's function-pointer VALUES (table indices,
    // living in the copied memory) resolve to the right functions in the child.
    expect(childLoader.dlsym(2, "side_fn")).toBe(dynIdx);
    expect(childLoader.dlsym(2, "side_taken")).toBe(takenIdx);
    expect(childTable.get(dynIdx)(2, 3)).toBe(47);
    expect(childTable.get(takenIdx)(9)).toBe(4);

    // Ctors did NOT re-run in the child (would be a double-init bug): the
    // parent's memory still shows exactly one initialization. Mutate the
    // parent's side_data and confirm the child's instance SEES the mutation
    // (same memory), proving data segments weren't re-applied.
    const sideDataAddr = childLoader.dlsym(2, "side_data");
    new DataView(parent.memory.buffer).setInt32(sideDataAddr, 100, true);
    const child2 = childLoader.modules[1];
    expect(child2.instance.exports.side_fn(1, 2)).toBe(103);

    // The child's own snapshot is replayable again (grandchild forks).
    expect(childLoader.snapshot().opLog.length).toBe(snap.opLog.length);
  });
});
