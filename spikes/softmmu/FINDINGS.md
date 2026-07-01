# Software-MMU per-access overhead on native wasm — MEASURED (not estimated)

The clean-NOMMU memory design rejected a software MMU as "10–100× slowdown, not
viable"; issue #24 estimated "2–5× (cf. SAFE_HEAP)". **Neither was ever measured**
(the two estimates disagree — the tell). This spike measures it, under **V8** (the
engine pc ships), replacing the guess.

## What it measures

A wasm module (`bench.c` → `bench.wasm`) where the instrumented variant routes every
load/store through a **single-level page-table translate** — exactly the software-MMU
per-access cost, and exactly WAVEN's model ("each memory access incurs only one page
table visit"):

```c
pte  = pagetable[vaddr >> 12];   // one added memory load per access
phys = pte + (vaddr & 0xfff);    // + shift/mask/add
```

Identity-mapped (`phys == vaddr`) so the two variants are bit-identical in result and
directly comparable. `base` = plain access; `xlate` = forced (volatile) PTE load, no
hoisting; `xlateo` = non-volatile, compiler free to optimize. Run: `bash build.sh &&
node run.mjs` (clang→wasm32, V8 via node).

## Results (node v22 / V8 12.4, min of 9 trials, ~300 ms each)

```
kernel                base(ms)  forced   +%    optimiz  +%
seq  (L1, 32KB)          298   2.07   107%    2.06   106%
seq  (DRAM, 64MB)        287   1.58    58%    1.56    56%
stride64 (DRAM)          290   1.02     2%    1.01     1%
store (DRAM, 64MB)       300   1.86    86%    1.82    82%
mixed (L1, 32KB)         301   1.01     1%    1.02     2%
mixed (DRAM, 64MB)       295   1.01     1%    1.01     1%
chase (L1, 32KB)         298   2.67   167%    2.67   167%
chase (DRAM, 64MB)       297   1.08     8%    1.07     7%
geomean:  forced 1.44×   optimizable 1.43×
```

## What it means

1. **The "10–100×" verdict is decisively refuted.** The *worst* case measured — a
   loop that does nothing but chase cache-resident pointers — is **2.67×**. Realistic
   code is single-digit percent.

2. **Overhead is entirely workload-shaped, and the shape is the finding:**
   - **Realistic code — compute-dense or memory-latency-bound: +1% to +8%.** `mixed`
     (a few ALU ops per load) is **+1–2%**; `chase (DRAM)` and `stride` are **+2–8%**
     because the data cache-miss latency *hides* the (cache-resident) PTE load. This
     reproduces **WAVEN's ~10% geomean** on pc's actual engine.
   - **Pathological — pure memory ops on a cache-resident working set: 1.8×–2.7×.**
     `seq (L1)`, `chase (L1)`, `store` are loops whose *every instruction* is a
     load/store, so adding a second load (the PTE) per access ~doubles them. Real
     programs are never this memory-dense.

3. **The cost is fundamental, not a benchmark artifact.** `xlateo` (compiler free to
   hoist/CSE the PTE load) ≈ `xlate` (forced) on *every* kernel — the optimizer cannot
   remove the per-access page-table load. A software TLB wouldn't help either (WAVEN
   measured it *worse*).

4. **These ratios are the honest end for pc.** The baseline here is V8 with guard-page
   bounds checks (≈ free) — the *fastest* possible baseline. WAVEN's smaller delta came
   partly from *replacing* WAMR's existing explicit bounds checks; pc runs the guest in
   V8, so the plain-load baseline is the right one and these ratios are what pc would
   actually see.

## Bottom line for the plan (§1 of the design doc, issue #24)

- **Realistic guest workloads: ~1.05–1.3×.** A per-access-translate software MMU is
  viable — nowhere near "non-starter."
- **Known worst case: cache-resident pointer-chasing hot loops → up to ~2.7×.** This is
  exactly the pattern of interpreters / GC walks — and **nix eval is pointer-chase
  heavy**. BUT the same chase, once its working set spills to DRAM (sustained real
  eval), drops to **+8%** (latency hides the PTE load). So even nix eval likely lands
  well under 1.5×, not 2.7×.
- **Mitigation levers if a hot path bites:** don't instrument provably-in-bounds
  stack/TLS accesses; exempt the shadow-stack; selective instrumentation. Each trades
  isolation completeness for speed.

## Caveats (what this does NOT measure)

- **COW / demand-paging fault handling** — rare, amortized (cost only on a fault), not
  modeled here. The steady-state per-access cost is what's measured.
- **SIMD** — built without `-msimd128`, so both variants are scalar (fair). A guest
  built with wasm SIMD would see a *larger* gap on vectorizable numeric kernels, because
  per-access translation defeats autovectorization (each access becomes a gather).
- **Whole-guest instrumentation** — this is the per-access marginal cost; whole-program
  overhead ≈ per-access-cost × memory-op-density, which is exactly what the `mixed`
  kernel shows for real code (~+1–2%).
- **Multi-level page tables** — single-level here (matches WAVEN); a real Linux MMU
  layer may add levels, though a software impl can keep it flat.

Reproduce: `bash build.sh && node run.mjs`. Deterministic modulo machine/timing noise.
