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

## 2026-07-02 — TWO-LEVEL walk re-measurement (kernel-layout tables)

The pass now emits the kernel's standard 2-level walk (PGDIR_SHIFT=22,
page-sized PTE tables, flag bits masked — design §2 revised: the generic MM
assumes page-sized PTE tables, so the kernel cannot cheaply keep a 4 MiB flat
table per process). Same harness, same binary, 2-level identity tables:

| kernel                          | base(ms) | instr(ms) | overhead |
|---------------------------------|---------:|----------:|---------:|
| sum_scan (i32 load, 8MB DRAM)   |      7.4 |      22.3 | 3.01× |
| fill (i32 store, 8MB DRAM)      |      4.8 |      19.9 | 4.10× |
| chase (ptr-chase, 4MB DRAM)     |     26.1 |      94.2 | 3.60× |
| mixed (ALU per load, 8MB)       |     57.2 |      57.8 | **1.01×** |

Honest read: the second dependent load + masks roughly moved the PURE-MEMORY
poles from ~2.2× (single-level) to ~3–4×, while compute-mixed code — the
realistic shape per FINDINGS.md — stays ≈free. Accepted for A1 (correctness +
standard MM first). If real-guest profiling shows the memory pole matters, the
recorded optimization option is a FLAT SHADOW table: arch set_pte/pte_clear
additionally maintain a flattened single-level mirror the pass walks in one
load (cost: 4 MiB/process + a shadow-sync line in the pte accessors) — an A3
optimization, not a correctness need.
