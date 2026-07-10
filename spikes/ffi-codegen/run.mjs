// Proves the libffi-on-wasm primitive (Track C / #130): call arbitrary-signature
// functions through a shared table via runtime-generated trampoline modules —
// including signatures the fixed trampoline-table backend (K=24 all-i32, M=2
// non-i32) CANNOT express. Run: bash build.sh && node run.mjs
import { readFileSync } from "node:fs";
import { genTrampoline } from "./gen.mjs";

const targets = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(new URL("./targets.wasm", import.meta.url))),
).exports;

// The shared substrate a #130 runtime would own: one memory + one funcref table.
const memory = new WebAssembly.Memory({ initial: 1 });
const table = new WebAssembly.Table({ initial: 16, element: "anyfunc" });
const dv = new DataView(memory.buffer);

// Install target funcrefs into the shared table (like dlsym registering symbols).
const IDX = { add: 1, muld: 2, mixf32: 3, mixi64: 4, mix4d: 5, addmany: 6 };
for (const [name, i] of Object.entries(IDX)) table.set(i, targets[name]);

// --- the FFI seam ---
const cache = new Map();
let generated = 0;
const key = (s) => `${s.params.join("")}>${s.result || "v"}`;
function ffiCall(funcIndex, sig, args) {
  const k = key(sig);
  let tramp = cache.get(k);
  if (!tramp) {
    generated++;
    tramp = new WebAssembly.Instance(new WebAssembly.Module(genTrampoline(sig)), {
      env: { memory, __indirect_function_table: table },
    }).exports.trampoline;
    cache.set(k, tramp);
  }
  const ARG = 0,
    RET = 512;
  sig.params.forEach((p, i) => {
    const off = ARG + i * 8;
    if (p === "i32") dv.setInt32(off, args[i], true);
    else if (p === "i64") dv.setBigInt64(off, BigInt(args[i]), true);
    else if (p === "f32") dv.setFloat32(off, args[i], true);
    else dv.setFloat64(off, args[i], true);
  });
  tramp(ARG, RET, funcIndex);
  if (!sig.result) return undefined;
  if (sig.result === "i32") return dv.getInt32(RET, true);
  if (sig.result === "i64") return dv.getBigInt64(RET, true);
  if (sig.result === "f32") return dv.getFloat32(RET, true);
  return dv.getFloat64(RET, true);
}

// --- cases (incl. ones beyond the fixed backend's K/M bounds) ---
let pass = 0,
  fail = 0;
const check = (label, got, want) => {
  const ok = got === want || (typeof want === "number" && Math.abs(got - want) < 1e-9);
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(34)} got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

check("add(i32,i32)", ffiCall(IDX.add, { params: ["i32", "i32"], result: "i32" }, [7, 35]), 42);
check("muld(f64,f64)", ffiCall(IDX.muld, { params: ["f64", "f64"], result: "f64" }, [6.5, 4]), 26);
check("mixf32(f32,f32)", ffiCall(IDX.mixf32, { params: ["f32", "f32"], result: "f32" }, [3, 4]), 13);
check(
  "mixi64(i64,i32)  [i64]",
  ffiCall(IDX.mixi64, { params: ["i64", "i32"], result: "i64" }, [1000000000000n, 5]),
  3000000000005n,
);
check(
  "mix4d(4×f64,i32)  [M=4 > 2]",
  ffiCall(IDX.mix4d, { params: ["f64", "f64", "f64", "f64", "i32"], result: "f64" }, [1, 2, 3, 4, 10]),
  100,
);
check(
  "addmany(30×i32)  [K=30 > 24]",
  ffiCall(
    IDX.addmany,
    { params: Array(30).fill("i32"), result: "i32" },
    Array.from({ length: 30 }, (_, i) => i + 1),
  ),
  465,
);

// caching: a repeat signature must NOT regenerate a module.
const g0 = generated;
ffiCall(IDX.add, { params: ["i32", "i32"], result: "i32" }, [1, 2]);
check("cache hit on repeat signature", generated - g0, 0);

console.log(
  `\n${pass}/${pass + fail} pass — ${generated} trampoline modules generated (one per distinct signature)`,
);
console.log(
  "Coverage note: mix4d (4 non-i32) and addmany (30 i32) are BEYOND the fixed\n" +
    "trampoline-table backend's K=24 / M=2 bounds — runtime codegen has no such limit.",
);
process.exit(fail ? 1 : 0);
