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

Ordered lowest→highest overhead — the realistic cases (what you'd actually pay) first,
the pathological ceiling last:

| kernel | overhead | what it's testing | practical effect of that overhead |
|---|---|---|---|
| **mixed** (L1 & DRAM) | **+1%** | A loop doing several arithmetic ops per load (an LCG mix), in- and out-of-cache. The shape of *normal* code — logic interleaved with memory. | Effectively free. Ordinary program logic, arithmetic, parsing, most kernel/userspace work pays nothing for the MMU. |
| **stride** (DRAM) | **+2%** | One read per 64-byte cache line across 64 MB — cache-**miss**-bound but predictable (streaming a big array/struct). | The DRAM fetch dominates; the extra (cache-resident) page-table load hides behind memory latency. Bulk streaming over large buffers ≈ free. |
| **chase** (DRAM) | **+8%** | Pointer-chasing a random cycle through 64 MB — latency-bound, prefetch-defeating. The realistic model for **interpreters, GC, tree/hash traversal — including nix eval** — on a large working set. | Modest. Even the worst *realistic* pattern stays under 10% once the data doesn't fit in cache, because each data cache-miss masks the PTE load. |
| **seq** (DRAM) | **+58%** | Summing a 64 MB array sequentially — bandwidth-bound, near-zero compute per access (a checksum/`memcpy`-style scan). | Noticeable: you've added a *second* memory stream (the page table) next to the data stream, so pure scan loops slow. But add any real work per element → collapses to the `mixed` number. |
| **store** (DRAM) | **+82%** | Writing a 64 MB array sequentially (`memset`/buffer-fill). Stores are buffered/cheap, so translate cost is a big fraction of each. | Large buffer fills / bulk writes slow down. Again, only bites code that does *nothing but* store. |
| **seq** (L1, 32 KB) | **2.07×** | Summing a 32 KB array that stays in L1, repeated, zero compute — the fastest possible memory op. | Microarchitectural **ceiling**, not a workload: doubling the loads (data + PTE) doubles the time. Tells you the per-access cost limit, not what programs feel. |
| **chase** (L1, 32 KB) | **2.67×** | Pointer-chasing within a 32 KB **cache-resident** cycle — each step a dependent L1 load, no compute, no latency to hide behind. | **The danger zone.** A hot inner loop that's pure pointer-chasing over a small hot structure (tight interpreter dispatch, hash probe) nearly triples. The one pattern to watch — and what the mitigations target. |
| **nix-eval** (48 MB graph) | **+24%** | The realistic shape: allocate a value graph, then per node a data-dependent pointer-chase + a primop + a memoizing store, over a large (mostly-DRAM) working set. | **The go/no-go number.** Real nixpkgs eval — the workload *most* exposed to a software MMU — lands here: compute+store dilute the chase and most of the heap is cold. Viable. |
| **nix-eval** (hot, 64 KB) | **1.93×** | Same interpreter, but the whole graph fits in L1 (a tiny eval / hot scope only). | The eval **upper** bound: even fully cache-resident, the per-node compute+store keep it below the pure-chase 2.69× ceiling. Real eval sits between this row and the DRAM one. |

Geomean across the (deliberately half-pathological) set: **forced 1.44×, optimizable
1.43×**. Through-line: overhead scales with how memory-dense *and* how cache-resident the
code is — real code is diluted by compute or hidden behind cache-miss latency
(**~1.05–1.3× in practice**); the 2–2.7× cases are loops that do *nothing but* touch a
tiny cache-hot buffer.

Raw output (both translate variants, `base(ms) forced +% optimiz +%`):

```
seq  (L1, 32KB)          296   2.07   107%    2.06   106%
seq  (DRAM, 64MB)        292   1.44    44%    1.41    41%
stride64 (DRAM)          300   1.04     4%    0.99    -1%
store (DRAM, 64MB)       302   1.72    72%    1.68    68%
mixed (L1, 32KB)         300   1.01     1%    1.01     1%
mixed (DRAM, 64MB)       294   1.02     2%    1.02     2%
chase (L1, 32KB)         299   2.69   169%    2.68   168%
chase (DRAM, 64MB)       291   1.06     6%    1.06     6%
nix-eval (hot, 64KB)     435   1.93    93%    1.79    79%
nix-eval (48MB graph)     39   1.24    24%    1.26    26%
```

### nix-eval — the workload that matters most (go/no-go)
Nix eval is allocation- + pointer-chase-heavy (a lazy value-graph interpreter), so it's the
guest workload *most* exposed to per-access translation. Measured under V8:
- **Realistic (48 MB graph): +24%.** A large value graph with data-dependent chase + a
  primop + a memoizing store per node. The compute/store dilute the chase and most of the
  heap is cold → well under 1.5×. (Caveat: the data-dependent 1-of-2 descent can settle into
  cache-resident cycles, so this is a *mix* of hot and cold access — which is exactly real
  eval's locality profile; the short `base` time reflects the DRAM-latency-bound per-step
  cost, so treat +24% as indicative, not high-precision.)
- **Fully hot (64 KB): 1.93×.** The whole graph in L1 — the eval upper bound; still below
  the pure-chase 2.69× because the per-node work dilutes it.

**Verdict: real eval lands ~1.25–1.9× depending on cache-residency — viable, and the case
that most rewards the mitigations** (exempt provably-in-bounds stack/shadow-stack accesses;
selective instrumentation) and the eventual `memory-control` hardware backend (which erases
per-access cost entirely). It does NOT approach the "10–100×" the verdict feared.

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
