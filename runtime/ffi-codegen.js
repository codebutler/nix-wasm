// ffi-codegen.js — runtime wasm trampoline generator for libffi-on-wasm (#126
// Track C / #130). The production form of spikes/ffi-codegen/gen.mjs.
//
// WHY it exists: a fully-general ffi_call is impossible in static wasm because
// call_indirect needs a statically-known signature at the call site. The
// in-tree wasm32-raw-ffi.c backend enumerates signatures at BUILD time (a fixed
// trampoline table, bounded K=24/M=2, no structs/varargs). This module removes
// that wall the same way emscripten's JS backend does — by generating a wasm
// module PER signature at RUNTIME — but with no JS-host dependency beyond the
// engine we already run in. It is the SAME primitive dlopen uses (instantiate a
// module + wire it into the shared table/memory), so it lives beside dylink.js.
//
// THE CANONICAL-THUNK INTERACTION (the load-bearing subtlety): a target funcref
// may be a fpcast-emu canonical thunk (signature (i64×N)→i64) when it belongs to
// a fpcast'd module (glib/GTK), or a raw-signature function otherwise. The
// static backend gets this right for free — it's compiled INTO the calling
// binary, so its call_indirect is canonicalized by the same fpcast pass as the
// target. A runtime-generated module is NOT fpcast'd, so it must choose the ABI
// explicitly: `canonical` mode marshals every arg up to i64 (toABI: extend/
// reinterpret), pads the param list to N with zeros, does a single (i64×N)→i64
// call_indirect, and converts the i64 result back (fromABI). Non-canonical mode
// emits the target's real signature. The host (kernel-worker's __wasm_ffi_call)
// picks the mode from which module owns the target table slot.
//
// The generated module imports the SHARED memory + table, so trampoline(argPtr,
// retPtr, funcIndex) reads typed args straight from guest memory, calls the real
// funcref, and writes the result back — all in the process's own address space.

// wasm value-type byte encodings.
const VT = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const LOAD = { i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b };
const STORE = { i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39 };
// opcodes used in canonical marshalling.
const OP = {
  i64_extend_i32_u: 0xad,
  i32_wrap_i64: 0xa7,
  i64_reinterpret_f64: 0xbd,
  f64_reinterpret_i64: 0xbf,
  i32_reinterpret_f32: 0xbc,
  f32_reinterpret_i32: 0xbe,
  f64_promote_f32: 0xbb,
  f32_demote_f64: 0xb6,
  i64_const: 0x42,
  local_get: 0x20,
};

// The canonical fpcast-emu ABI param count. binaryen's FuncCastEmulation uses
// `max-func-params` (our fpcast seam passes @128); every fpcast'd call_indirect
// is (i64 × NUM_FUNC_PARAMS) → i64. Must match userspace/fpcast-emu.nix.
export const CANONICAL_PARAMS = 128;

const uleb = (n) => {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const sleb = (n) => {
  const out = [];
  let more = true;
  let v = n | 0;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && b & 0x40)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const str = (s) => vec([...s].map((c) => c.charCodeAt(0)));
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];

/**
 * A signature: { params: ('i32'|'i64'|'f32'|'f64')[], result: same | null }.
 * These are WASM value types — the C ffi backend lowers C types to them (struct
 * by-value → i32 pointer, struct return → leading i32 pointer + void, varargs →
 * trailing i32 pointer; see wasm32-raw-ffi.c) before calling here.
 *
 * @param {{ params: string[], result: string | null }} sig
 * @param {{ canonical?: boolean }} [opts]
 * @returns {Uint8Array}
 */
export function genTrampoline(sig, opts = {}) {
  const canonical = !!opts.canonical;
  // type 0 = trampoline export: (argPtr i32, retPtr i32, funcIndex i32) -> ()
  const trampType = [0x60, ...vec([VT.i32, VT.i32, VT.i32]), ...vec([])];
  // type 1 = the target call_indirect type.
  const targetType = canonical
    ? [0x60, ...vec(Array.from({ length: CANONICAL_PARAMS }, () => VT.i64)), ...vec([VT.i64])]
    : [0x60, ...vec(sig.params.map((p) => VT[p])), ...vec(sig.result ? [VT[sig.result]] : [])];
  const typeSec = section(1, vec([trampType, targetType]));

  const importSec = section(
    2,
    vec([
      [...str("env"), ...str("memory"), 0x02, 0x00, ...uleb(1)],
      [...str("env"), ...str("__indirect_function_table"), 0x01, 0x70, 0x00, ...uleb(1)],
    ]),
  );

  const funcSec = section(3, vec([[...uleb(0)]])); // func 0 : type 0
  const exportSec = section(7, vec([[...str("trampoline"), 0x00, ...uleb(0)]]));

  const body = canonical ? genCanonicalBody(sig) : genRawBody(sig);

  const code = [...uleb(0), ...body]; // 0 local decls
  const codeSec = section(10, vec([[...uleb(code.length), ...code]]));

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSec,
    ...importSec,
    ...funcSec,
    ...exportSec,
    ...codeSec,
  ]);
}

/** Raw ABI: load each arg at its natural type, call the exact signature. */
function genRawBody(sig) {
  const body = [];
  if (sig.result) body.push(OP.local_get, ...uleb(1)); // retPtr for the later store
  sig.params.forEach((p, i) => {
    body.push(OP.local_get, ...uleb(0)); // argPtr
    body.push(LOAD[p], 0x00, ...uleb(i * 8)); // load p, align=8, offset i*8
  });
  body.push(OP.local_get, ...uleb(2)); // funcIndex
  body.push(0x11, ...uleb(1), 0x00); // call_indirect type=1 table=0
  if (sig.result) body.push(STORE[sig.result], 0x00, ...uleb(0)); // store @ retPtr
  body.push(0x0b);
  return body;
}

/**
 * Canonical fpcast ABI: extend each real arg to i64 (toABI), pad to
 * CANONICAL_PARAMS with i64 0, call (i64×N)->i64, convert the i64 result to the
 * real result type (fromABI). Mirrors binaryen FuncCastEmulation exactly.
 */
function genCanonicalBody(sig) {
  const body = [];
  if (sig.result) body.push(OP.local_get, ...uleb(1)); // retPtr for the store
  // real args, each extended to i64
  sig.params.forEach((p, i) => {
    body.push(OP.local_get, ...uleb(0)); // argPtr
    body.push(LOAD[p], 0x00, ...uleb(i * 8)); // load real type
    toABI(body, p);
  });
  // pad remaining params with i64 0
  for (let i = sig.params.length; i < CANONICAL_PARAMS; i++) {
    body.push(OP.i64_const, ...sleb(0));
  }
  body.push(OP.local_get, ...uleb(2)); // funcIndex
  body.push(0x11, ...uleb(1), 0x00); // call_indirect canonical type=1
  // now an i64 result is on the stack (canonical always returns i64)
  if (sig.result) {
    fromABI(body, sig.result);
    body.push(STORE[sig.result], 0x00, ...uleb(0)); // store @ retPtr
  } else {
    body.push(0x1a); // drop the i64
  }
  body.push(0x0b);
  return body;
}

/** Extend a value of wasm type `t` (on the stack) up to i64 (binaryen toABI). */
function toABI(body, t) {
  switch (t) {
    case "i32":
      body.push(OP.i64_extend_i32_u);
      break;
    case "i64":
      break;
    case "f32":
      body.push(OP.i32_reinterpret_f32, OP.i64_extend_i32_u);
      break;
    case "f64":
      body.push(OP.i64_reinterpret_f64);
      break;
    default:
      throw new Error(`toABI: unsupported type ${t}`);
  }
}

/** Convert an i64 (on the stack) down to wasm type `t` (binaryen fromABI). */
function fromABI(body, t) {
  switch (t) {
    case "i32":
      body.push(OP.i32_wrap_i64);
      break;
    case "i64":
      break;
    case "f32":
      body.push(OP.i32_wrap_i64, OP.f32_reinterpret_i32);
      break;
    case "f64":
      body.push(OP.f64_reinterpret_i64);
      break;
    default:
      throw new Error(`fromABI: unsupported type ${t}`);
  }
}

/**
 * A cache of instantiated trampoline modules, keyed by (canonical, signature).
 * One per process (the trampolines close over the process's Memory + table).
 */
export class FfiTrampolines {
  /**
   * @param {{ memory: WebAssembly.Memory, table: WebAssembly.Table }} opts
   */
  constructor({ memory, table }) {
    this.memory = memory;
    this.table = table;
    /** @type {Map<string, (a: number, r: number, f: number) => void>} */
    this.cache = new Map();
  }

  /** @param {{ params: string[], result: string | null }} sig @param {boolean} canonical */
  key(sig, canonical) {
    return (canonical ? "C:" : "R:") + sig.params.join("") + ">" + (sig.result || "v");
  }

  /**
   * Get (or build + cache) the trampoline for a signature, then invoke it:
   * calls table[funcIndex] with args read from argPtr, result written to retPtr.
   *
   * @param {{ params: string[], result: string | null }} sig
   * @param {boolean} canonical
   * @param {number} funcIndex
   * @param {number} argPtr
   * @param {number} retPtr
   */
  call(sig, canonical, funcIndex, argPtr, retPtr) {
    const k = this.key(sig, canonical);
    let tramp = this.cache.get(k);
    if (!tramp) {
      const bytes = genTrampoline(sig, { canonical });
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(/** @type {BufferSource} */ (bytes)),
        {
          env: { memory: this.memory, __indirect_function_table: this.table },
        },
      );
      tramp = /** @type {any} */ (instance.exports.trampoline);
      this.cache.set(k, tramp);
    }
    tramp(argPtr, retPtr, funcIndex);
  }
}
