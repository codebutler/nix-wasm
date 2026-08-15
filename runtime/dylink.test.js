// dylink.test.js — engine unit tests for the runtime dynamic loader (#126
// Track C / #130). Fixtures are REAL PIC dylink modules built with the
// production link model (test-fixtures/dylink/build.sh) so the tests exercise
// the actual wasm-ld/binaryen ABI, not a mock: GOT.mem/GOT.func resolution,
// elem-slot dlsym, the fpcast canonical-thunk rule, ctor/data-reloc gating,
// and the fork/clone replay contract (Track 0 §4).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DynamicLoader, exportedElemSlots, parseDylinkModule } from "./dylink.js";
import { genCanonicalThunk, CANONICAL_PARAMS } from "./ffi-codegen.js";
import { translateUser } from "./mmu-uaccess.js";
import { NR_MMU_FAULT } from "./softmmu-pass.js";

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
  const memory = name.includes(".shared.")
    ? new WebAssembly.Memory({ initial: 32, maximum: 0x10000, shared: true })
    : new WebAssembly.Memory({ initial: 32 });
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

/**
 * Re-wrap the ordinary main fixture in an MMU-aware loader. Low virtual memory
 * stays identity mapped for main's data; side-module VA 0x00100000 is mapped
 * to a deliberately different physical arena.
 */
function bootMmuMain(name) {
  const h = bootMain(name);
  const ptBase = 0x10000;
  const lowPtes = 0x11000;
  const sideVa = 0x00100000;
  const sidePhys = 0x20000;
  const dv = new DataView(h.memory.buffer);
  dv.setUint32(ptBase, lowPtes, true); // virtual 0..4 MiB identity mapped
  for (let page = 0; page < 512; page++) {
    dv.setUint32(lowPtes + page * 4, (page << 12) | 7, true);
  }
  for (let page = 0; page < 16; page++) {
    const va = sideVa + page * 0x1000;
    dv.setUint32(lowPtes + (((va >>> 12) & 0x3ff) << 2), (sidePhys + page * 0x1000) | 7, true);
  }
  const faults = [];
  const logs = [];
  const loader = new DynamicLoader({
    memory: h.memory,
    table: h.table,
    baseEnv: h.baseEnv,
    log: (message) => logs.push(message),
    mmu: {
      ptBase,
      syscall2: (...args) => {
        faults.push(args);
        const va = Number(args[3]) >>> 0;
        const pageVa = va & ~0xfff;
        const pagePhys =
          pageVa >= sideVa && pageVa < sideVa + 16 * 0x1000 ? sidePhys + (pageVa - sideVa) : pageVa;
        dv.setUint32(lowPtes + (((va >>> 12) & 0x3ff) << 2), pagePhys | 7, true);
        return 0;
      },
      stackPointer: h.baseEnv.__stack_pointer,
      getTlsBase: () => 0x7000,
    },
  });
  loader.registerMain({
    instance: h.instance,
    bytes: h.bytes,
    memoryBase: MAIN_MEMORY_BASE,
    tableBase: MAIN_TABLE_BASE,
  });
  return { ...h, loader, ptBase, sideVa, sidePhys, faults, logs };
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

  // The exec-ABI loader parses straight out of the SHARED kernel memory, and
  // BROWSERS reject SAB-backed views in TextDecoder.decode() while Node accepts
  // them — so the Node smokes shipped a parser that crashed every in-browser
  // dlopen/dlsym (pc: gtk3-demo exit 132). Emulate the browser restriction by
  // patching TextDecoder.prototype.decode (dispatch is via the prototype, so
  // dylink's module-level instance is covered), then parse from a SAB copy.
  test("parses from a SharedArrayBuffer-backed view (browser TextDecoder rules)", () => {
    const plain = fixture("side.wasm");
    const sab = new SharedArrayBuffer(plain.length);
    const shared = new Uint8Array(sab);
    shared.set(plain);

    const proto = TextDecoder.prototype;
    const realDecode = proto.decode;
    proto.decode = function (input, options) {
      if (input && input.buffer instanceof SharedArrayBuffer) {
        throw new TypeError(
          "Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.",
        );
      }
      return realDecode.call(this, input, options);
    };
    try {
      const info = parseDylinkModule(shared);
      expect(info.dylink).not.toBeNull();
      const slots = exportedElemSlots(info);
      expect(slots.has("side_taken")).toBe(true);
    } finally {
      proto.decode = realDecode;
    }
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

describe("DynamicLoader.load under checked software MMU", () => {
  test("side data, relocations, ctor, and imports use non-identity translation", () => {
    const h = bootMmuMain("main.shared.wasm");
    const bytes = fixture("side.shared.wasm");
    const handle = h.loader.load(bytes, h.sideVa, { name: "side.shared.wasm" });
    if (handle < 0) throw new Error(h.logs.join("\n"));
    expect(handle).toBeGreaterThan(1);
    const side = h.loader.modules[handle - 1];

    expect(side.instance.exports.side_fn(1, 2)).toBe(45);
    expect(side.instance.exports.call_main(5)).toBe(2005);

    const ctorAddr = h.loader.dlsym(handle, "ctor_ran");
    const relocAddr = h.loader.dlsym(handle, "side_reloc_ptr");
    const dataAddr = h.loader.dlsym(handle, "side_data");
    const dv = new DataView(h.memory.buffer);
    expect(dv.getInt32(translateUser(dv, h.ptBase, ctorAddr), true)).toBe(1);
    expect(dv.getUint32(translateUser(dv, h.ptBase, relocAddr), true)).toBe(dataAddr);
    expect(dv.getInt32(translateUser(dv, h.ptBase, dataAddr), true)).toBe(42);
    expect(h.faults).toEqual([]);

    // Evict the data page, then prove the loader-installed bridge reaches the
    // kernel-style fault path and the instrumented side module retries.
    const pteOff = 0x11000 + (((dataAddr >>> 12) & 0x3ff) << 2);
    dv.setUint32(pteOff, 0, true);
    expect(side.instance.exports.side_fn(1, 2)).toBe(45);
    expect(h.faults).toHaveLength(1);
    expect(Number(h.faults[0][2])).toBe(NR_MMU_FAULT);
    expect(Number(h.faults[0][4])).toBe(0); // load
  });

  test("fpcast side-module table entries survive checked instrumentation", () => {
    const h = bootMmuMain("main.dynsym.fpcast.wasm");
    const bytes = fixture("side.dynsym.fpcast.wasm");
    const handle = h.loader.load(bytes, h.sideVa, { name: "side.dynsym.fpcast.wasm" });
    if (handle < 0) throw new Error(h.logs.join("\n"));
    expect(handle).toBeGreaterThan(1);

    const idx = h.loader.dlsym(handle, "side_taken");
    const args = Array.from({ length: 8 }, () => 0n);
    args[0] = 9n;
    expect(h.table.get(idx)(...args)).toBe(4n);
    expect(h.faults).toEqual([]);
  });

  test("fork replay reserves the same fault-bridge and side-module table slots", () => {
    const parent = bootMmuMain("main.shared.wasm");
    const bytes = fixture("side.shared.wasm");
    const handle = parent.loader.load(bytes, parent.sideVa, { name: "side.shared.wasm" });
    if (handle < 0) throw new Error(parent.logs.join("\n"));
    const takenIdx = parent.loader.dlsym(handle, "side_taken");
    const dynamicIdx = parent.loader.dlsym(handle, "side_fn");
    const snap = parent.loader.snapshot();

    const mainBytes = fixture("main.shared.wasm");
    const info = parseDylinkModule(mainBytes);
    const table = new WebAssembly.Table({
      initial: Math.max(64, MAIN_TABLE_BASE + info.tableImportInitial),
      element: "anyfunc",
    });
    const baseEnv = { ...parent.baseEnv, __indirect_function_table: table };
    const instance = new WebAssembly.Instance(new WebAssembly.Module(mainBytes), {
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
    const child = new DynamicLoader({
      memory: parent.memory,
      table,
      baseEnv,
      mmu: {
        ptBase: parent.ptBase,
        syscall2: () => -1,
        stackPointer: baseEnv.__stack_pointer,
        getTlsBase: () => 0x7000,
      },
    });
    child.registerMain({
      instance,
      bytes: mainBytes,
      memoryBase: MAIN_MEMORY_BASE,
      tableBase: MAIN_TABLE_BASE,
    });
    child.replay(snap);

    expect(child.dlsym(handle, "side_taken")).toBe(takenIdx);
    expect(child.dlsym(handle, "side_fn")).toBe(dynamicIdx);
    expect(child.modules[handle - 1].instance.exports.side_fn(1, 2)).toBe(45);
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

  // NB: the fpcast STRUCTURAL fingerprint (isCanonicalSlot / info.fpcast) is
  // keyed on the production canonical width (max-func-params@128 =
  // CANONICAL_PARAMS). These main/side fixtures are built @8 (for readable
  // canonArgs); the @128 detection is tested in ffi-codegen.test.js against the
  // targets.fpcast.wasm fixture. isCanonicalSlot on the non-fpcast fixtures
  // must be raw regardless:
  test("isCanonicalSlot on a NON-fpcast program is always raw", () => {
    const h = bootMain("main.wasm");
    const { handle } = dlopen(h, "side.wasm");
    expect(h.loader.isCanonicalSlot(h.loader.dlsym(handle, "side_taken"))).toBe(false);
    expect(h.loader.isCanonicalSlot(h.loader.dlsym(handle, "side_fn"))).toBe(false);
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

// The gtk3-demo/pango regression (pc prod): an fpcast'd main dlsym's raw
// exports (hb_*) that were never address-taken; installing them RAW in the
// table traps ("function signature mismatch") when fpcast'd code
// call_indirects them with the canonical (i64×N)->i64 convention.
// functionAddress must install runtime canonical thunks instead.
describe("canonical dynSlot thunks (fpcast world)", () => {
  const canonArgs = (...real) => {
    const a = Array.from({ length: CANONICAL_PARAMS }, () => 0n);
    real.forEach((v, i) => (a[i] = BigInt(v)));
    return a;
  };

  test("genCanonicalThunk adapts a raw (i32,i32)->i32 to the canonical ABI", () => {
    const mod = new WebAssembly.Module(
      genCanonicalThunk({ params: ["i32", "i32"], result: "i32" }),
    );
    const { thunk } = new WebAssembly.Instance(mod, { e: { f: (a, b) => a + b } }).exports;
    expect(thunk(...canonArgs(2, 40))).toBe(42n);
  });

  test("genCanonicalThunk handles void results", () => {
    let called = 0;
    const mod = new WebAssembly.Module(genCanonicalThunk({ params: ["i32"], result: null }));
    const { thunk } = new WebAssembly.Instance(mod, { e: { f: () => void (called = 1) } }).exports;
    expect(thunk(...canonArgs(7))).toBe(0n);
    expect(called).toBe(1);
  });

  // A funcref table only accepts exported wasm functions (production's `fn`
  // is always m.instance.exports[name]) — wrap a JS fn in a re-exporting
  // wasm module so the raw-install paths are exercised realistically.
  const asWasmFn = (params, result, jsFn) => {
    const VTB = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
    const uleb = (n) => {
      const o = [];
      let v = n >>> 0;
      do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v) b |= 0x80;
        o.push(b);
      } while (v);
      return o;
    };
    const vec = (a) => [...uleb(a.length), ...a.flat()];
    const str = (t) => vec([...t].map((c) => c.charCodeAt(0)));
    const sec = (id, pl) => [id, ...uleb(pl.length), ...pl];
    const type = [0x60, ...vec(params.map((q) => VTB[q])), ...vec(result ? [VTB[result]] : [])];
    const bytes = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...sec(1, vec([type])),
      ...sec(2, vec([[...str("e"), ...str("f"), 0x00, ...uleb(0)]])),
      ...sec(7, vec([[...str("f"), 0x00, ...uleb(0)]])),
    ]);
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: jsFn } }).exports.f;
  };

  const makeLoader = () => {
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
    return new DynamicLoader({ memory: null, table, baseEnv: {}, log: () => {} });
  };
  const fakeMain = (fpcast, sigOf) => ({
    handle: 1,
    name: "<main>",
    bytes: null,
    memoryBase: 0,
    tableBase: 0,
    tableCount: 0,
    global: true,
    instance: /** @type {any} */ (null),
    elemSlots: new Map(),
    dynSlots: new Map(),
    fpcast,
    sigOf,
  });

  test("functionAddress thunks raw exports in an fpcast world; isCanonicalSlot agrees", () => {
    const dl = makeLoader();
    const m = fakeMain(true, () => ({ params: ["i32", "i32"], result: "i32" }));
    dl.modules.push(m);
    const raw = asWasmFn(["i32", "i32"], "i32", (a, b) => a * b);
    const slot = dl.functionAddress(m, "mul", raw);
    // the installed table entry follows the CANONICAL convention, not raw
    const fn = dl.table.get(slot);
    expect(fn(...canonArgs(6, 7))).toBe(42n);
    expect(dl.isCanonicalSlot(slot)).toBe(true);
    // cached second lookup returns the same slot
    expect(dl.functionAddress(m, "mul", raw)).toBe(slot);
  });

  test("unknown signature falls back to a raw install (isCanonicalSlot false)", () => {
    const dl = makeLoader();
    const m = fakeMain(true, () => null);
    dl.modules.push(m);
    const raw = asWasmFn(["i32"], "i32", (a) => a + 1);
    const slot = dl.functionAddress(m, "mystery", raw);
    expect(dl.table.get(slot)(41)).toBe(42);
    expect(dl.isCanonicalSlot(slot)).toBe(false);
  });

  test("non-fpcast world installs raw (unchanged behavior)", () => {
    const dl = makeLoader();
    const m = fakeMain(false, () => ({ params: ["i32"], result: "i32" }));
    dl.modules.push(m);
    const slot = dl.functionAddress(
      m,
      "id",
      asWasmFn(["i32"], "i32", (x) => x),
    );
    expect(dl.table.get(slot)(5)).toBe(5);
    expect(dl.isCanonicalSlot(slot)).toBe(false);
  });
});
