// dylink.js — the runtime dynamic loader for PIC wasm SIDE_MODULEs (#126 Track C,
// #130; contract: docs/superpowers/specs/2026-07-01-process-model-track0-design.md).
//
// Every guest binary is already emitted as a `-shared` dylink module
// (`-shared -Bsymbolic --export-all --import-memory --import-table` + GOT +
// `__wasm_apply_data_relocs`, wasm-cross.nix). This module supplies the missing
// half — a loader that can instantiate ADDITIONAL such modules into a running
// process at runtime, which is what `dlopen(3)` is on wasm:
//
//   dlopen  = sync-instantiate the side module against the process's Memory +
//             shared __indirect_function_table: table.grow(tableSize) → the
//             module's tableBase, resolve its imports (env.<sym> direct calls,
//             GOT.func.<sym> function addresses, GOT.mem.<sym> data addresses)
//             against the already-loaded module chain, run
//             __wasm_apply_data_relocs + __wasm_call_ctors.
//   dlsym   = a symbol's "address": for data, definingModule.memoryBase +
//             exported-global value (dylink data exports are RELATIVE offsets);
//             for functions, a table index — see "the fpcast rule" below.
//
// THE FPCAST RULE (the #33 revert, now honored — Track 0 §6): a binary that went
// through the `--fpcast-emu` post-link pass has every call_indirect rewritten to
// one canonical wide signature, and only its TABLE (elem) entries are rewritten
// to canonical thunks — its EXPORTS still carry the original raw-signature
// functions (verified empirically; binaryen exports no thunks). So a function
// pointer handed out by dlsym MUST be the module's own elem-segment slot
// (thunked), never a raw export pushed into a fresh table slot host-side.
// This loader therefore resolves function addresses in two tiers:
//   1. the symbol's slot in the defining module's OWN elem segment (address-
//      taken at build time → fpcast-thunked if the module is fpcast'd) — found
//      by parsing the binary's export + elem sections;
//   2. only when absent there, a dynamically grown slot holding the raw export
//      (correct for non-fpcast modules; fpcast'd modules are REQUIRED to carry
//      every dlsym-able function in their elem segment — the dynsym-inject
//      build seam, userspace/dynsym.nix, guarantees that).
//
// FORK/CLONE REPLAY (Track 0 §4 step 3): module instances and the wasm table
// are engine objects OUTSIDE linear memory — a memory snapshot does not carry
// them. The loader keeps an ordered log of every table-layout-affecting
// operation ({load}/{install}); `snapshot()` serializes it (plus each side
// module's bytes + memoryBase) and `replay()` reproduces the exact table layout
// in a fresh worker, skipping data relocs + ctors (the shared/copied memory
// already holds initialized data; --shared-memory modules additionally gate
// segment init on their own in-memory flag, so re-instantiation is idempotent).
//
// Deliberately synchronous (new WebAssembly.Module/Instance): dlopen is a
// synchronous guest import call, and this code runs in a Worker where sync
// compilation is unrestricted.

const textDecoder = new TextDecoder("utf-8");

// Wasm section ids.
const SEC_CUSTOM = 0;
const SEC_IMPORT = 2;
const SEC_EXPORT = 7;
const SEC_ELEM = 9;

// Import/export kinds.
const KIND_FUNC = 0;
const KIND_TABLE = 1;
const KIND_MEM = 2;
const KIND_GLOBAL = 3;
const KIND_TAG = 4;

// dylink.0 subsection ids (tool-conventions DynamicLinking.md).
const WASM_DYLINK_MEM_INFO = 1;
const WASM_DYLINK_NEEDED = 2;

class Cursor {
  /** @param {Uint8Array} bytes */
  constructor(bytes, at = 0) {
    this.b = bytes;
    this.i = at;
  }
  u8() {
    return this.b[this.i++];
  }
  uleb() {
    let r = 0;
    let s = 0;
    let x;
    do {
      x = this.b[this.i++];
      r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r;
  }
  sleb() {
    let r = 0;
    let s = 0;
    let x;
    do {
      x = this.b[this.i++];
      r |= (x & 0x7f) << s;
      s += 7;
    } while (x & 0x80);
    if (s < 32 && x & 0x40) r |= -1 << s;
    return r;
  }
  bytes(n) {
    const v = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return v;
  }
  name() {
    return textDecoder.decode(this.bytes(this.uleb()));
  }
  skip(n) {
    this.i += n;
  }
}

/** Skip one limits encoding (flags + min [+ max]). */
function skipLimits(c) {
  const flags = c.uleb();
  c.uleb();
  if (flags & 1) c.uleb();
  return flags;
}

/**
 * Parse the sections of a wasm module this loader needs: the dylink.0 memory/
 * table requirements, the import list, the export list, and the (single,
 * __table_base-anchored) elem segment's function indices.
 *
 * @param {Uint8Array} bytes
 * @returns {{
 *   dylink: { memSize: number, memAlign: number, tableSize: number, tableAlign: number, needed: string[] } | null,
 *   imports: { module: string, name: string, kind: number }[],
 *   funcImportCount: number,
 *   tableImportInitial: number,
 *   exports: { name: string, kind: number, index: number }[],
 *   elem: { offsetKind: "global" | "const", offsetConst: number, funcIndices: number[] } | null,
 *   dynsym: Map<string, number>,
 * }}
 */
export function parseDylinkModule(bytes) {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new Error("not a wasm module (bad magic)");
  }
  const c = new Cursor(bytes, 8);
  /** @type {ReturnType<typeof parseDylinkModule>} */
  const info = {
    dylink: null,
    imports: [],
    funcImportCount: 0,
    tableImportInitial: 0,
    exports: [],
    elem: null,
    dynsym: new Map(),
  };

  while (c.i < bytes.length) {
    const id = c.u8();
    const size = c.uleb();
    const end = c.i + size;
    if (id === SEC_CUSTOM) {
      const start = c.i;
      const name = c.name();
      if (name === "cb.dynsym") {
        // The dynsym-inject build seam's name → elem-slot map (see
        // scripts/wasm-dynsym-inject.py). Authoritative under fpcast, where
        // the elem entries are replaced by fresh thunk functions and the
        // export-index ↔ elem link below no longer holds.
        const n = c.uleb();
        for (let k = 0; k < n; k++) {
          const sym = c.name();
          info.dynsym.set(sym, c.uleb());
        }
      } else if (name === "dylink.0") {
        const d = { memSize: 0, memAlign: 0, tableSize: 0, tableAlign: 0, needed: [] };
        while (c.i < end) {
          const sub = c.u8();
          const subSize = c.uleb();
          const subEnd = c.i + subSize;
          if (sub === WASM_DYLINK_MEM_INFO) {
            d.memSize = c.uleb();
            d.memAlign = c.uleb();
            d.tableSize = c.uleb();
            d.tableAlign = c.uleb();
          } else if (sub === WASM_DYLINK_NEEDED) {
            const n = c.uleb();
            for (let k = 0; k < n; k++) d.needed.push(c.name());
          }
          c.i = subEnd;
        }
        info.dylink = d;
      }
      c.i = start; // rewind; unified skip below
    } else if (id === SEC_IMPORT) {
      const n = c.uleb();
      for (let k = 0; k < n; k++) {
        const module = c.name();
        const name = c.name();
        const kind = c.u8();
        info.imports.push({ module, name, kind });
        if (kind === KIND_FUNC) {
          c.uleb(); // type index
          info.funcImportCount++;
        } else if (kind === KIND_TABLE) {
          c.u8(); // reftype
          const flags = c.uleb();
          info.tableImportInitial = c.uleb();
          if (flags & 1) c.uleb();
        } else if (kind === KIND_MEM) {
          skipLimits(c);
        } else if (kind === KIND_GLOBAL) {
          c.skip(2); // valtype + mutability
        } else if (kind === KIND_TAG) {
          c.u8(); // attribute
          c.uleb(); // type index
        } else {
          throw new Error(`unknown import kind ${kind}`);
        }
      }
    } else if (id === SEC_EXPORT) {
      const n = c.uleb();
      for (let k = 0; k < n; k++) {
        const name = c.name();
        const kind = c.u8();
        const index = c.uleb();
        info.exports.push({ name, kind, index });
      }
    } else if (id === SEC_ELEM) {
      const n = c.uleb();
      for (let k = 0; k < n; k++) {
        const flags = c.uleb();
        if (flags !== 0) {
          // wasm-ld -shared emits exactly one flags=0 active funcref segment
          // anchored at __table_base (or a const in non-PIC output). Anything
          // else is outside the dylink ABI this loader supports.
          throw new Error(`unsupported elem segment flags ${flags}`);
        }
        // offset expr: (i32.const N | global.get G) end
        const op = c.u8();
        /** @type {"const" | "global"} */
        let offsetKind = "const";
        let offsetConst = 0;
        if (op === 0x41) {
          offsetKind = "const";
          offsetConst = c.sleb();
        } else if (op === 0x23) {
          offsetKind = "global";
          c.uleb(); // global index (the __table_base import)
        } else {
          throw new Error(`unsupported elem offset opcode 0x${op.toString(16)}`);
        }
        if (c.u8() !== 0x0b) throw new Error("elem offset expr not terminated");
        const count = c.uleb();
        const funcIndices = [];
        for (let j = 0; j < count; j++) funcIndices.push(c.uleb());
        if (info.elem) throw new Error("multiple elem segments unsupported");
        info.elem = { offsetKind, offsetConst, funcIndices };
      }
    }
    c.i = end;
  }
  return info;
}

/**
 * Map exported function names to their slot OFFSET within the module's elem
 * segment (i.e. the table index relative to the module's tableBase). Only
 * functions that are address-taken at build time appear (the fpcast rule).
 *
 * @param {ReturnType<typeof parseDylinkModule>} info
 * @returns {Map<string, number>}
 */
export function exportedElemSlots(info) {
  // The cb.dynsym custom section (dynsym-inject seam) is authoritative when
  // present — it survives fpcast, which renumbers elem entries to thunks and
  // breaks the export-index matching below.
  if (info.dynsym.size > 0) return new Map(info.dynsym);
  const slots = new Map();
  if (!info.elem) return slots;
  const slotByFuncIndex = new Map();
  info.elem.funcIndices.forEach((funcIndex, slot) => {
    // First slot wins if a function appears twice (it can't under wasm-ld,
    // which dedupes table entries, but be deterministic anyway).
    if (!slotByFuncIndex.has(funcIndex)) slotByFuncIndex.set(funcIndex, slot);
  });
  for (const e of info.exports) {
    if (e.kind !== KIND_FUNC) continue;
    const slot = slotByFuncIndex.get(e.index);
    if (slot !== undefined) slots.set(e.name, slot);
  }
  return slots;
}

/** dl error codes (negated Linux errno), the guest musl maps them to dlerror text. */
export const DL_ERRNO = { ENOENT: 2, ENOMEM: 12, EINVAL: 22, ENOEXEC: 8 };

/**
 * One loaded module's record (Track 0 §2 `modules[]` entry).
 * @typedef {{
 *   handle: number,
 *   name: string,
 *   bytes: Uint8Array | null,
 *   memoryBase: number,
 *   tableBase: number,
 *   tableCount: number,
 *   global: boolean,
 *   instance: WebAssembly.Instance,
 *   elemSlots: Map<string, number>,
 *   dynSlots: Map<string, number>,
 * }} DlModule
 */

/**
 * The per-process dynamic loader. One instance per user program image (reset on
 * exec). The MAIN module is registered by the worker after it instantiates it;
 * side modules are loaded through probe()/load() on behalf of the guest's
 * dlopen, and dlsym() serves both.
 */
export class DynamicLoader {
  /**
   * @param {{
   *   memory: WebAssembly.Memory,
   *   table: WebAssembly.Table,
   *   baseEnv: Record<string, unknown>,
   *   archBits?: number,
   *   log?: (msg: string) => void,
   * }} opts baseEnv = the worker's host-provided env import object (syscalls,
   *   abort, lsan stubs, …) — the FINAL fallback for a side module's unresolved
   *   env imports, exactly the set the main module gets.
   */
  constructor({ memory, table, baseEnv, archBits = 32, log = () => {} }) {
    this.memory = memory;
    this.table = table;
    this.baseEnv = baseEnv;
    this.archBits = archBits;
    this.log = log;
    /** @type {DlModule[]} */
    this.modules = [];
    /**
     * Ordered log of table-layout-affecting operations, for fork/clone replay
     * (Track 0 §4). {op:"load"} entries reference this.modules by index;
     * {op:"install"} entries record a dynamic raw-export table install.
     * @type {({ op: "load", module: number } | { op: "install", module: number, name: string } | { op: "grow", count: number })[]}
     */
    this.opLog = [];
    this.lastError = 0;
  }

  /** @param {number} v */
  ulong(v) {
    return this.archBits === 64 ? BigInt(v) : Number(v);
  }

  /**
   * Register the already-instantiated MAIN module (handle 1). `bytes` may be a
   * view over shared kernel memory — only parsed here, never retained.
   *
   * @param {{ instance: WebAssembly.Instance, bytes: Uint8Array, memoryBase: number, tableBase: number }} m
   */
  registerMain({ instance, bytes, memoryBase, tableBase }) {
    const info = parseDylinkModule(bytes);
    this.modules.push({
      handle: 1,
      name: "<main>",
      bytes: null, // the kernel owns the main image; replay re-registers it
      memoryBase,
      tableBase,
      tableCount: info.elem ? info.elem.funcIndices.length : 0,
      global: true,
      instance,
      elemSlots: exportedElemSlots(info),
      dynSlots: new Map(),
    });
  }

  /**
   * dlopen phase 1 — parse the module's dylink requirements so the GUEST can
   * allocate memoryBase in its own address space (its malloc owns the arena).
   *
   * @param {Uint8Array} bytes
   * @returns {{ memSize: number, memAlign: number, tableSize: number } | number} negative errno on failure
   */
  probe(bytes) {
    let info;
    try {
      info = parseDylinkModule(bytes);
    } catch (e) {
      this.log(`[dylink] probe: ${e}`);
      return -DL_ERRNO.EINVAL;
    }
    if (!info.dylink) return -DL_ERRNO.ENOEXEC;
    return {
      memSize: info.dylink.memSize,
      memAlign: info.dylink.memAlign,
      tableSize: Math.max(info.dylink.tableSize, info.elem ? info.elem.funcIndices.length : 0),
    };
  }

  /**
   * Resolve a symbol to an exported value across the loaded chain: main first,
   * then global side modules in load order. (A module's OWN symbols never reach
   * here — -Bsymbolic binds them at link time.) Returns { module, value } or null.
   *
   * @param {string} name
   */
  resolveExport(name) {
    for (const m of this.modules) {
      if (!m.global) continue;
      const v = m.instance.exports[name];
      if (v !== undefined) return { module: m, value: v };
    }
    return null;
  }

  /**
   * A function symbol's TABLE INDEX (the wasm form of &fn), honoring the fpcast
   * rule: prefer the defining module's own elem slot; fall back to a dynamic
   * raw-export install (logged for replay).
   *
   * @param {DlModule} m the defining module
   * @param {string} name
   * @param {Function} fn the module's export
   * @param {boolean} [logged] false while building a load's GOT imports: those
   *   installs are deterministic consequences of the load and are reproduced
   *   by replaying the load itself — logging them too would double-install on
   *   replay and shift every later index.
   * @returns {number}
   */
  functionAddress(m, name, fn, logged = true) {
    const slot = m.elemSlots.get(name);
    if (slot !== undefined) return m.tableBase + slot;
    const cached = m.dynSlots.get(name);
    if (cached !== undefined) return cached;
    const idx = this.table.grow(1);
    this.table.set(idx, /** @type {any} */ (fn));
    m.dynSlots.set(name, idx);
    if (logged) this.opLog.push({ op: "install", module: this.modules.indexOf(m), name });
    return idx;
  }

  /** A data symbol's absolute address: defining module's memoryBase + relative export. */
  dataAddress(m, value) {
    return m.memoryBase + Number(/** @type {WebAssembly.Global} */ (value).value);
  }

  /**
   * dlopen phase 2 — instantiate the side module at the guest-allocated
   * memoryBase. Synchronous. Returns the module handle (>1) or negative errno.
   *
   * @param {Uint8Array} bytes the module image (copied; retained for replay)
   * @param {number} memoryBase
   * @param {{ name?: string, global?: boolean, replay?: boolean }} [opts]
   * @returns {number}
   */
  load(bytes, memoryBase, opts = {}) {
    const { name = "<side>", global = true, replay = false } = opts;
    let info;
    try {
      info = parseDylinkModule(bytes);
    } catch (e) {
      this.log(`[dylink] load(${name}): ${e}`);
      return -DL_ERRNO.EINVAL;
    }
    if (!info.dylink) {
      this.log(`[dylink] load(${name}): no dylink.0 section (not a side module)`);
      return -DL_ERRNO.ENOEXEC;
    }
    const tableCount = Math.max(
      info.dylink.tableSize,
      info.elem ? info.elem.funcIndices.length : 0,
    );

    /** @type {DlModule} */
    const record = {
      handle: this.modules.length + 1,
      name,
      bytes: replay ? bytes : bytes.slice(), // own copy — the guest may free its buffer
      memoryBase,
      tableBase: 0, // assigned below, after fallible resolution
      tableCount,
      global,
      instance: /** @type {any} */ (null),
      elemSlots: exportedElemSlots(info),
      dynSlots: new Map(),
    };

    // PHASE 1 — fallible resolution, with NO side effects on the table or the
    // op log, so a failed dlopen leaves the process layout untouched (and
    // therefore needs no replay entry). Unresolvable direct imports fail the
    // load (RTLD_NOW semantics, matching the no-undef contract); GOT entries
    // are deferred to phase 2 (their dynamic installs mutate the table) but
    // never fail — unresolvable GOT resolves to NULL (weak-undef semantics,
    // matching the worker's main-module Proxy behavior).
    let module;
    try {
      // Always compile from an owned, non-shared copy: `bytes` may be a view
      // over the guest's SharedArrayBuffer-backed memory, which the
      // WebAssembly.Module constructor rejects.
      module = new WebAssembly.Module(/** @type {BufferSource} */ (record.bytes));
    } catch (e) {
      this.log(`[dylink] load(${name}): compile failed: ${e}`);
      return -DL_ERRNO.ENOEXEC;
    }
    /** @type {Record<string, unknown>} */
    const envImports = {};
    for (const imp of info.imports) {
      if (imp.module !== "env") continue;
      if (
        imp.name === "memory" ||
        imp.name === "__indirect_function_table" ||
        imp.name === "__memory_base" ||
        imp.name === "__table_base" ||
        imp.name === "__table_base32" ||
        imp.name === "__stack_pointer"
      ) {
        continue; // pre-wired below
      }
      if (imp.kind === KIND_FUNC) {
        const r = this.resolveExport(imp.name);
        if (r && typeof r.value === "function") {
          envImports[imp.name] = r.value;
        } else if (typeof (/** @type {any} */ (this.baseEnv)[imp.name]) !== "undefined") {
          envImports[imp.name] = /** @type {any} */ (this.baseEnv)[imp.name];
        } else {
          this.log(`[dylink] load(${name}): unresolved function import env.${imp.name}`);
          return -DL_ERRNO.ENOEXEC;
        }
      } else if (imp.kind === KIND_GLOBAL) {
        const r = this.resolveExport(imp.name);
        if (r && r.value instanceof WebAssembly.Global) envImports[imp.name] = r.value;
        else if (/** @type {any} */ (this.baseEnv)[imp.name] instanceof WebAssembly.Global)
          envImports[imp.name] = /** @type {any} */ (this.baseEnv)[imp.name];
        else {
          this.log(`[dylink] load(${name}): unresolved global import env.${imp.name}`);
          return -DL_ERRNO.ENOEXEC;
        }
      } else if (imp.kind === KIND_TAG) {
        envImports[imp.name] = /** @type {any} */ (this.baseEnv)[imp.name];
        if (!envImports[imp.name]) {
          this.log(`[dylink] load(${name}): unresolved tag import env.${imp.name}`);
          return -DL_ERRNO.ENOEXEC;
        }
      }
    }

    // PHASE 2 — table mutations, logged FIRST so the op log mirrors the true
    // mutation order (the module's own grow precedes any GOT.func dynamic
    // install made while building its GOT imports — a replay that reversed
    // them would shift every index; this exact bug is covered by the replay
    // test). From here on the only failure mode is instantiate itself; that
    // path converts the log entry to a plain "grow" tombstone so the layout
    // (a grown hole) is still reproduced in a forked child.
    const logIndex = this.opLog.length;
    this.opLog.push({ op: "load", module: this.modules.length });
    const tableBase = tableCount > 0 ? this.table.grow(tableCount) : this.table.length;
    record.tableBase = tableBase;
    this.modules.push(record);

    const g = (v, mutable = true) =>
      new WebAssembly.Global(
        { value: this.archBits === 64 ? "i64" : "i32", mutable },
        this.ulong(v),
      );
    /** @type {Record<string, Record<string, unknown>>} */
    const imports = {
      env: {
        ...envImports,
        memory: this.memory,
        __indirect_function_table: this.table,
        __memory_base: g(memoryBase, false),
        __table_base: g(tableBase, false),
        __table_base32: new WebAssembly.Global({ value: "i32", mutable: false }, tableBase),
        __stack_pointer: /** @type {any} */ (this.baseEnv).__stack_pointer,
      },
      "GOT.mem": {},
      "GOT.func": {},
    };
    for (const imp of info.imports) {
      if (imp.module === "GOT.mem") {
        const r = this.resolveExport(imp.name);
        imports["GOT.mem"][imp.name] = g(
          r && r.value instanceof WebAssembly.Global ? this.dataAddress(r.module, r.value) : 0,
        );
      } else if (imp.module === "GOT.func") {
        const r = this.resolveExport(imp.name);
        imports["GOT.func"][imp.name] = g(
          r && typeof r.value === "function"
            ? this.functionAddress(r.module, imp.name, r.value, false)
            : 0,
        );
      }
    }

    let instance;
    try {
      instance = new WebAssembly.Instance(module, /** @type {any} */ (imports));
    } catch (e) {
      this.log(`[dylink] load(${name}): instantiate failed: ${e}`);
      this.modules.pop();
      this.opLog[logIndex] = { op: "grow", count: tableCount };
      return -DL_ERRNO.ENOEXEC;
    }
    record.instance = instance;

    // Apply the module's own data relocations + run its ctors — but NOT on
    // fork/clone replay, where the (shared or copied) memory already holds the
    // parent's initialized/mutated data (Track 0 §4 step 3).
    if (!replay) {
      const ex = /** @type {any} */ (instance.exports);
      if (ex.__wasm_apply_data_relocs) ex.__wasm_apply_data_relocs();
      if (ex.__wasm_call_ctors) ex.__wasm_call_ctors();
    }
    return record.handle;
  }

  /**
   * dlsym — resolve `name` against `handle` (0 = RTLD_DEFAULT: global scope in
   * load order). Returns the wasm "address" (data address or fn table index),
   * 0 when not found.
   *
   * @param {number} handle
   * @param {string} name
   * @returns {number}
   */
  dlsym(handle, name) {
    /** @type {DlModule[]} */
    let search;
    if (handle === 0) {
      search = this.modules.filter((m) => m.global);
    } else {
      const m = this.modules[handle - 1];
      if (!m) return 0;
      search = [m];
    }
    for (const m of search) {
      const v = m.instance.exports[name];
      if (v === undefined) continue;
      if (typeof v === "function") return this.functionAddress(m, name, v);
      if (v instanceof WebAssembly.Global) return this.dataAddress(m, v);
    }
    return 0;
  }

  /**
   * Serialize the side-module set + op log for fork/clone replay in a fresh
   * worker (structured-cloneable; module bytes ride as ArrayBuffers).
   */
  snapshot() {
    return {
      modules: this.modules
        .filter((m) => m.handle !== 1)
        .map((m) => ({
          name: m.name,
          bytes: /** @type {Uint8Array} */ (m.bytes).slice().buffer,
          memoryBase: m.memoryBase,
          global: m.global,
        })),
      opLog: this.opLog.map((e) => ({ ...e })),
    };
  }

  /**
   * Reproduce a parent's table layout after the child's main module is
   * instantiated: walk the op log, re-loading side modules (relocs/ctors
   * skipped) and re-doing dynamic installs, in the exact original order.
   *
   * @param {ReturnType<DynamicLoader["snapshot"]>} snap
   */
  replay(snap) {
    let next = 0; // index into snap.modules, consumed by "load" entries in order
    for (const entry of snap.opLog) {
      if (entry.op === "load") {
        const m = snap.modules[next++];
        const h = this.load(new Uint8Array(m.bytes), m.memoryBase, {
          name: m.name,
          global: m.global,
          replay: true,
        });
        if (typeof h === "number" && h < 0) {
          throw new Error(`[dylink] replay: reload of ${m.name} failed (${h})`);
        }
      } else if (entry.op === "grow") {
        // A tombstone for a load that failed at instantiate in the parent:
        // reproduce the grown hole so later indices line up.
        this.table.grow(entry.count);
        this.opLog.push({ ...entry });
      } else {
        const m = this.modules[entry.module];
        const fn = m.instance.exports[entry.name];
        if (typeof fn !== "function") {
          throw new Error(`[dylink] replay: ${m.name} lost export ${entry.name}`);
        }
        // Re-install at a fresh slot; growth order matches the original log,
        // so the index comes out identical.
        m.dynSlots.delete(entry.name);
        this.functionAddress(m, entry.name, fn);
      }
    }
  }
}
