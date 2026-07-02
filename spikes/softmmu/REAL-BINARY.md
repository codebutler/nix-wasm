# Software-MMU overhead on a REAL instrumented binary (Track A1, #128)

The A0 spike (`bench.c`, this dir) measured a *hand-written* per-access translate.
This is the follow-up the #128 comment asked for: **run the PRODUCTION
instrumentation pass (`runtime/softmmu-pass.js`) over a REAL compiled binary and
confirm the overhead holds on compiler-generated code.**

`runtime/test-fixtures/softmmu/prog.c` is compiled to wasm, instrumented by the
actual pass (every load/store rewritten to an inlined single-level page-table
translate), run under an identity page table, and timed against the original.

## Result (node v22 / V8, `node spikes/softmmu/measure-real.mjs`)

| kernel | overhead | what it is |
|---|---|---|
| **mixed** (ALU per load, 8 MB) | **+−1% (free)** | Several arithmetic ops per load — the shape of NORMAL code. The compute dilutes the translate to nothing. |
| chase (pointer-chase, 4 MB) | ~2.1× | Data-dependent load with almost zero compute — the translate's page-table load is a *second dependent* load per access. |
| sum_scan (i32 load, 8 MB) | ~2.2× | Bandwidth-bound scan, no compute. |
| fill (i32 store, 8 MB) | ~2.2× | Bandwidth-bound store, no compute. |

This reproduces `FINDINGS.md`'s central shape on real compiler output:
**overhead scales with how memory-dense the code is.** Ordinary code (the `mixed`
kernel) pays ≈0; pure-memory loops that do nothing but load/store hit the
pathological 1.8–2.7× pole — exactly the microbench's finding, now confirmed
through the real pass.

## The lesson baked into the pass: INLINE, don't call a helper

The first cut of the pass replaced each access with `call $mmu_load_T`. That
measured **~12×** — because V8 does not inline the helper, so every memory op ate
a function-call round-trip, and the spike's ~1.1× assumed an *inlined* translate.
The pass now emits the translate **inline** at each access (per-function scratch
locals hold the effective address + the store value). That is the difference
between the 12× above and the ~2.2×-worst / ≈0-typical here — and it's why the
pass carries the comment that it must never regress to a helper call.

## Scope honesty

- These are worst-case kernels (pure memory) plus one realistic (`mixed`). Real
  nix-eval-shaped work lands between — the A0 spike measured **+24% to 1.9×** for
  a value-graph interpreter (`FINDINGS.md` § nix-eval).
- This measures the STEADY-STATE per-access cost under an identity table. COW /
  demand-paging faults (Track A2) are rare + amortized and not modeled here.
- The pass currently covers scalar int/float loads/stores; it ABORTS LOUDLY on
  SIMD + atomics (each needs its own translate variant — a documented follow-up,
  and the guest's atomics are heavy, so that follow-up gates a real-guest boot).
- The KERNEL half (CONFIG_MMU=y arch layer that builds page tables + handles
  faults) is designed in `docs/superpowers/specs/2026-07-01-softmmu-kernel-design.md`
  and is where the end-to-end guest-with-MMU boot happens — that requires the
  joelseverin/linux source + nix/LLVM builds, i.e. the teleported box / CI, not
  this measurement.
