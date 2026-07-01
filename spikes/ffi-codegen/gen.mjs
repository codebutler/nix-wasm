// Runtime wasm trampoline generator — the libffi-on-wasm primitive (Track C / #130).
//
// Given an arbitrary call signature, emit a tiny wasm module at runtime whose
// exported `trampoline(argPtr, retPtr, funcIndex)`:
//   - reads each typed arg from linear memory at argPtr + i*8,
//   - `call_indirect`s table[funcIndex] with the exact signature type,
//   - writes the result to retPtr.
// It imports the SHARED memory + table, so it calls real funcrefs and marshals
// through the same memory the host wrote. This is exactly what a software MMU /
// dynamic-linking runtime (#130) would host, and it covers ANY signature —
// unbounded arity, any mix of i32/i64/f32/f64 — unlike the fixed trampoline
// table (K/M bounds). See FINDINGS.md.

const VT = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const LOAD = { i32: 0x28, i64: 0x29, f32: 0x2a, f64: 0x2b };
const STORE = { i32: 0x36, i64: 0x37, f32: 0x38, f64: 0x39 };

const uleb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const str = (s) => vec([...s].map((c) => c.charCodeAt(0)));
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];

// sig = { params: ['i32','f64',...], result: 'i32' | null }
export function genTrampoline(sig) {
  const trampType = [0x60, ...vec([VT.i32, VT.i32, VT.i32]), ...vec([])]; // (i32,i32,i32)->()
  const targetType = [
    0x60,
    ...vec(sig.params.map((p) => VT[p])),
    ...vec(sig.result ? [VT[sig.result]] : []),
  ];
  // type 0 = trampoline, type 1 = target (referenced by call_indirect)
  const typeSec = section(1, vec([trampType, targetType]));

  const importSec = section(
    2,
    vec([
      [...str("env"), ...str("memory"), 0x02, 0x00, ...uleb(1)], // memory {min:1}
      [...str("env"), ...str("__indirect_function_table"), 0x01, 0x70, 0x00, ...uleb(1)], // table funcref {min:1}
    ]),
  );

  const funcSec = section(3, vec([[...uleb(0)]])); // one func, type index 0
  const exportSec = section(7, vec([[...str("trampoline"), 0x00, ...uleb(0)]])); // func 0

  // body: [retPtr] arg0..argN [funcIndex] call_indirect(type1) [store]
  const body = [];
  if (sig.result) body.push(0x20, ...uleb(1)); // local.get retPtr (store addr)
  sig.params.forEach((p, i) => {
    body.push(0x20, ...uleb(0)); // local.get argPtr
    body.push(LOAD[p], 0x00, ...uleb(i * 8)); // load p @ align0, offset i*8
  });
  body.push(0x20, ...uleb(2)); // local.get funcIndex
  body.push(0x11, ...uleb(1), 0x00); // call_indirect type=1, table=0
  if (sig.result) body.push(STORE[sig.result], 0x00, ...uleb(0)); // store result @ retPtr
  body.push(0x0b); // end

  const code = [...uleb(0), ...body]; // 0 local groups + body
  const codeSec = section(10, vec([[...uleb(code.length), ...code]]));

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
    ...typeSec, ...importSec, ...funcSec, ...exportSec, ...codeSec,
  ]);
}
