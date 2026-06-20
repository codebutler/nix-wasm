# Task 0 spike — findings (asyncify double-return / spec risk B3)

**Date:** 2026-06-20 · **Verdict: B3 RESOLVED POSITIVELY.** The asyncify double-return
works through real clang codegen. Both harnesses pass (`./build.sh`):
`run.mjs` (hand-written WAT) and `run-cc.mjs` (clang `-O2`, nested frame + shadow
stack + live locals).

## What was proven

1. **Return-twice.** A single `do_fork()` call site returns twice — the parent's
   instance with a child token, the child's (a second instance on copied memory)
   with `0`. Orchestrated entirely at the **host run-loop**: run → unwind →
   `stop_unwind` → copy memory → `start_rewind` both → re-enter → each returns.
2. **B3 — resume lands at the call site.** The pre-fork marker fires **exactly
   once**. Asyncify rewind jumps straight to the `do_fork()` call inside the
   nested `deep()` frame; code before it (in both `run()` and `deep()`) is **not**
   replayed. Confirmed two frames deep, so it rewinds through a real call chain.
3. **Memory isolation.** Parent and child have genuinely separate
   `WebAssembly.Memory`; post-fork mutations diverge (counter 543 vs 501).
4. **Live state survives.** A live C local (`salt=7`) and the C shadow stack are
   preserved across unwind→copy→rewind on both sides (they ride along in the
   copied linear memory; asyncify restores the wasm VM locals from its buffer).

## Findings that reshape Tasks 2–4 (act on these)

### A. CRITICAL ordering constraint → locks Task 4
A **fresh `WebAssembly.Instance` re-applies the module's active data segments**
to its memory at instantiation, **clobbering the copied `.bss`/`.data`**. The
parent never hits this (it reuses one instance across unwind+rewind); the child
does (it's a new instance). **The verbatim parent→child memory copy MUST happen
AFTER the child instance is created** (so the forked bytes overwrite segment
re-init), or active-segment re-application must be suppressed for fork children.
→ Task 4's host orchestration: create child worker+instance first, *then* copy.

### B. Use a DEDICATED capture import, NOT the generic syscall wrapper → refines Tasks 1–2
Asyncify's unwind trigger is an **import** named via
`--pass-arg=asyncify-imports@<import>`; asyncify instruments that import's callers
up to the export boundary. The import name must match exactly (clang emits the
`env.*` namespace). **Do not** make the generic `__wasm_syscall_N` wrapper an
unwind point — it's on every syscall (cost + the "unwind through the syscall
wrapper cleanly" worry, B3). Instead, musl's `fork()` should call a **dedicated
`capture_stack()` import** that unwinds; the host drives the real `clone` and
rewinds. The generic syscall wrapper stays non-asyncify ⇒ the clone-with-fn fast
path keeps zero asyncify cost, and B3's syscall-boundary concern is sidestepped
(we never unwind through a syscall — fork unwinds at the dedicated import).

### C. Pre-fork state must be materialized in memory → test-design note for Tasks 2/5
At `-O2`, clang folded a pre-fork store into a post-fork one (the file-static was
invisible to the extern import), so the value was never in memory at copy time.
Real heap/observable state is fine, but acceptance programs (Task 5) must witness
fork through genuinely memory-resident state, and musl's seam must ensure the
fork-relevant state is committed to memory before `capture_stack()`.

## The asyncify control surface (for Tasks 1–4)

- Exports after `wasm-opt --asyncify`: `asyncify_start_unwind(dataPtr)`,
  `asyncify_stop_unwind()`, `asyncify_start_rewind(dataPtr)`,
  `asyncify_stop_rewind()`, `asyncify_get_state()` (0 normal / 1 unwinding / 2 rewinding).
- `dataPtr` → a `{ i32 cur, i32 end }` struct; `[cur, end)` is scratch where
  asyncify spills/rebuilds the VM stack. Lives in the process's own linear memory,
  so it is copied to the child automatically. Same `dataPtr` drives both rewinds.
- The capture import pattern: on first (NORMAL) arrival call `start_unwind` and
  return a dummy; on REWINDING arrival call `stop_rewind` and return the real
  value (child pid for parent, 0 for child).

## Size tax (preliminary)

Freestanding probe: 588 → 1213 bytes (+625 B). This is dominated by **fixed**
asyncify scaffolding on a trivially small module; the relative % is meaningless
here. The real, allow-list-bounded measurement belongs on a real fork binary in
Task 1/2 (`asyncify-onlylist@<fork call graph>` to bound which functions are
instrumented; everything else pays nothing).

## Reproduce

```sh
cd spikes/asyncify-fork && ./build.sh
# or with pre-resolved tools (root-daemon setup):
# CLANG=.../clang LLD=.../bin WASM_OPT=.../wasm-opt ./build.sh
```
