// softmmu spike runner — measures xlate/base slowdown for each kernel under V8.
// Usage: node run.mjs   (after build.sh)
//
// Two translate variants per kernel:
//   xlate   — forced (volatile) PTE load, no hoisting: "instrument every access"
//   xlateo  — non-volatile PTE load, compiler free to hoist/CSE (WAVEN-style cleanup)
import { readFileSync } from "node:fs";

const mod = new WebAssembly.Module(readFileSync(new URL("./bench.wasm", import.meta.url)));
const { exports: e } = new WebAssembly.Instance(mod);
e.init();

const L1 = 8192;               // 32 KB working set (fits L1/L2)
const DRAM = 16 * 1024 * 1024; // 64 MB working set (out of cache)

const nowMs = (fn) => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};
const best = (invoke, w, trials = 9) => {
  for (let i = 0; i < 3; i++) invoke(w); // warmup / JIT
  const xs = [];
  for (let i = 0; i < trials; i++) xs.push(nowMs(() => invoke(w)));
  xs.sort((a, b) => a - b);
  return xs[0]; // min — most stable for CPU timing
};
const calibrate = (invoke, targetMs = 300) => {
  let w = 1;
  while (nowMs(() => invoke(w)) < 40 && w < (1 << 30)) w *= 8;
  const ms = nowMs(() => invoke(w));
  return Math.max(1, Math.round((w * targetMs) / ms));
};

const K = (name, base, xlate, xlateo, pre) => ({ name, base, xlate, xlateo, pre });
const kernels = [
  K("seq  (L1, 32KB)",    (r) => e.seq_base(L1, r),     (r) => e.seq_xlate(L1, r),     (r) => e.seq_xlateo(L1, r)),
  K("seq  (DRAM, 64MB)",  (r) => e.seq_base(DRAM, r),   (r) => e.seq_xlate(DRAM, r),   (r) => e.seq_xlateo(DRAM, r)),
  K("stride64 (DRAM)",    (r) => e.stride_base(DRAM, r),(r) => e.stride_xlate(DRAM, r),(r) => e.stride_xlateo(DRAM, r)),
  K("store (DRAM, 64MB)", (r) => e.store_base(DRAM, r), (r) => e.store_xlate(DRAM, r), (r) => e.store_xlateo(DRAM, r)),
  K("mixed (L1, 32KB)",   (r) => e.mixed_base(L1, r),   (r) => e.mixed_xlate(L1, r),   (r) => e.mixed_xlateo(L1, r)),
  K("mixed (DRAM, 64MB)", (r) => e.mixed_base(DRAM, r), (r) => e.mixed_xlate(DRAM, r), (r) => e.mixed_xlateo(DRAM, r)),
  K("chase (L1, 32KB)",   (s) => e.chase_base(s), (s) => e.chase_xlate(s), (s) => e.chase_xlateo(s), () => e.build_chase(L1)),
  K("chase (DRAM, 64MB)", (s) => e.chase_base(s), (s) => e.chase_xlate(s), (s) => e.chase_xlateo(s), () => e.build_chase(DRAM)),
  // nix-eval shape: value-graph walk (alloc + data-dependent pointer-chase + compute + store)
  K("nix-eval (hot, 64KB)",  (s) => e.nixeval_base(s), (s) => e.nixeval_xlate(s), (s) => e.nixeval_xlateo(s), () => e.build_graph(4096)),
  K("nix-eval (48MB graph)", (s) => e.nixeval_base(s), (s) => e.nixeval_xlate(s), (s) => e.nixeval_xlateo(s), () => e.build_graph(3 * 1024 * 1024)),
];

console.log(`node ${process.version} — V8 ${process.versions.v8}\n`);
console.log("kernel                base(ms)  forced   +%    optimiz  +%");
console.log("-".repeat(60));

const rF = [], rO = [];
for (const k of kernels) {
  if (k.pre) k.pre();
  const w = calibrate(k.base);
  if (k.pre) k.pre();
  const b = best(k.base, w);
  const xf = best(k.xlate, w);
  const xo = best(k.xlateo, w);
  const rf = xf / b, ro = xo / b;
  rF.push(rf); rO.push(ro);
  const p = (r) => ((r - 1) * 100).toFixed(0).padStart(4);
  console.log(
    `${k.name.padEnd(20)}  ${b.toFixed(0).padStart(6)}  ${rf.toFixed(2).padStart(5)}  ${p(rf)}%  ${ro.toFixed(2).padStart(6)}  ${p(ro)}%`,
  );
}
const geo = (a) => Math.exp(a.reduce((s, r) => s + Math.log(r), 0) / a.length);
console.log("-".repeat(60));
console.log(`geomean:  forced ${geo(rF).toFixed(2)}× (+${((geo(rF) - 1) * 100).toFixed(0)}%)   optimizable ${geo(rO).toFixed(2)}× (+${((geo(rO) - 1) * 100).toFixed(0)}%)`);
