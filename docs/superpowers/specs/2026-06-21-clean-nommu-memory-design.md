# Clean-NOMMU process model — ratify the shared arena, harden the spawn edges

Date: 2026-06-21
Status: Design — pending implementation plan
Baseline: **master** (`e90170d`), which **already runs the single shared NOMMU arena**.
Supersedes: the elastic-per-process-memory design and the per-process-memory model of
PR #20 (closed, never merged to master).

## TL;DR — what this actually is

After a long investigation (elastic per-process memory → windowed/hybrid → clean
NOMMU), the conclusion is that **master is already the right architecture.** This
spec is therefore *not* a rewrite or a revert — it:

1. **Ratifies and documents** master's existing single-shared-arena NOMMU model, with
   the measured rationale for why per-process Memory is the wrong path.
2. **Hardens the process-creation edges**: make `fork()`/`vfork()` fail at **link
   time** instead of master's current runtime abort/SIGILL, and **centralize**
   `posix_spawn`/`system`/`popen` in musl so the existing per-program clone-with-fn
   patches become one documented platform contract rather than ad-hoc commits.

The code delta vs master is small (a couple of musl patches + documentation). The
large deliverable of the investigation was **negative knowledge** that kept us on
this sound model and off two dead-ends (see Non-goals).

## Master's current state (the baseline — verified)

- **Memory:** single shared `WebAssembly.Memory`; `mm/nommu.c` allocates each process
  a region and the runtime wires `data_start → __memory_base`
  (`runtime/kernel-worker.js`). No `userMems`/per-process Memory; `kernel.nix` carries
  **none** of the per-process-memory/fork patches. (Confirmed: 0 such patches on
  master.) Soft NOMMU isolation; `MAP_SHARED` works; scales to thousands.
- **Process creation:** clone-with-fn spawn already in place — busybox patches
  `0001/0003/0004/0005/0006` + the ash patches; musl `0000`–`0007`. `vfork()` is a
  runtime **abort stub** ("not implemented, use clone()"); `fork()` **SIGILLs** at
  runtime (no asyncify seam — `0008-fork-asyncify-seam` is *not* on master).
- PR #20's per-process-Memory + asyncify-fork is **closed**, not present here.

## Goals

- Keep master's shared-arena NOMMU memory model; document it and the rationale.
- Process creation is a **centralized, documented platform contract** (kernel + musl),
  not scattered per-program hacks. Programs using the libc spawn APIs
  (`posix_spawn`/`system`/`popen`) run unmodified.
- `fork`/`vfork` **fail loudly at build time** rather than master's silent runtime
  abort/SIGILL — never a faked success that hides a future crash's cause.

## Non-goals (the two measured dead-ends + the obvious one)

- **Per-process `WebAssembly.Memory`** (PR #20's model). Measured to hard-cap at
  **~124 concurrent Memory objects per browser tab** (`spikes/elastic-mem/`): a fixed
  ~8 GiB V8 guard reservation each inside a ~1 TiB per-renderer cage, immune to size,
  `shared`, memory64 (worse, ~61), Worker spread, and `--no-wasm-trap-handler`. This
  is why PR #20 was closed.
- **Real `fork()`/`vfork()` (return-twice).** Impossible on wasm without a multi-shot
  continuation: it requires re-entering the call frame. **WasmFX/JSPI are one-shot** —
  verified in Chromium 149 (`spikes/stackswitch/`): a second `resume` traps
  ("resuming an invalid continuation"). Multi-shot is the un-adopted ask
  (WebAssembly/stack-switching#110). Only asyncify gives multi-shot (serialize stack →
  copyable memory), and that's the per-binary tax we reject for general use.
  **Escape hatch:** if multi-shot continuations ship, clean `vfork` becomes expressible
  centrally in the runtime (and `vfork` shares memory, so it dodges the ~124 cap) —
  revisit then. One-shot stack-switching does **not** qualify.
- A software MMU (per-access translation) — 10–100× slowdown, not viable.

## Background

- **NOMMU semantics.** Real uClinux manages one flat physical address space; every
  process loads at a different offset, soft isolation. Master is exactly this. The
  guest even prints "This architecture does not have kernel memory protection."
- **Why wasm is *weaker* than NOMMU.** Real NOMMU hardware has a working `vfork()`
  (the CPU continues as the child on the shared stack). wasm cannot: a new task is a
  fresh instance that can't resume a function mid-execution. So `vfork` — the standard
  NOMMU spawn primitive — is unavailable here. busybox proves it: its `vfork`-based
  NOMMU code is correct on real boards and only needs adapting because *our* substrate
  lacks `vfork`.
- **No prior art for Nix-on-NOMMU.** Every "wasm + Nix" project builds *for* wasm;
  nobody runs Nix *inside* a NOMMU/wasm guest. The no-fork porting *technique* has
  decades of uClinux precedent; running Nix this way is novel.

## Design

### 1. Memory — keep master's shared arena (no change)

Unchanged from master: one `WebAssembly.Memory`, `mm/nommu.c` placing each process at
its `data_start` offset, soft isolation, `MAP_SHARED` everywhere, thousands of
processes. This spec only *documents* it as the deliberate model and records why the
per-process alternative was measured and rejected.

### 2. Process creation — centralized contract; harden the edges

`fork`/`vfork` cannot exist on wasm (return-twice). The only spawn needing no
return-twice is `clone(CLONE_VM, fn)` / `posix_spawn` (the child runs a fresh
function). So this is a **`posix_spawn`-only platform**, defined once in kernel + musl:

- **Kernel:** `clone(CLONE_VM|CLONE_VFORK|SIGCHLD, fn)` is the documented spawn
  primitive (standard `clone()`-with-a-function — the same one `pthread_create` uses).
  Already implemented on master.
- **musl (centralized):** `posix_spawn` rides that primitive (already works on
  master). Ensure `system()`/`popen()` route through `posix_spawn` (verify 1.2.5 — one
  musl patch if not), so libc-spawn users need **zero** local modification.
- **`fork()`/`vfork()` removed at the libc level — no symbol** (replacing master's
  runtime abort-stub / SIGILL). A caller then **fails to link in its Nix build**:
  loud, early, traceable — and autoconf correctly detects no-fork. This is the one
  behavioral change to existing master code.
- **The residual** (programs hard-coding raw `fork`/`vfork` and a few that we want
  anyway) is ported via **one documented `vfork`→`posix_spawn` pattern**, applied
  uniformly and labeled as the platform port. **busybox is kept** — its spawn is
  already centralized in `libbb` (`vfork_daemon_rexec.c` + a couple applet sites);
  master's existing busybox/ash clone-with-fn patches are consolidated and documented
  as *the* busybox-on-wasm spawn port (not removed, not ad-hoc). nix's builder spawn
  goes through `posix_spawn`.

Result: a curated, `posix_spawn`-clean userspace. `posix_spawn`/`system`/`popen`
programs run unmodified; raw-`fork` holdouts fail at build and are ported via the one
pattern or deliberately unsupported. No silent per-package hacks.

## The actual delta vs master

- **musl** (`toolchain/musl.nix` + `patches/musl/`): route `system`/`popen` through
  `posix_spawn` if not already (verify first); **remove the `fork`/`vfork` symbols**
  (delete the `0000` `vfork`-abort stub's body in favor of clean absence; ensure
  `fork` is absent too). Keep `posix_spawn` on `clone(CLONE_VM, fn)`.
- **Docs**: a `docs/` (or CLAUDE.md) section defining the spawn contract and labeling
  the busybox/ash clone-with-fn patches as the documented `vfork`→`posix_spawn` port.
- **Possibly busybox/ash**: relabel/consolidate the existing spawn patches; no new
  per-program surgery beyond what master already carries.
- **No kernel change**, **no runtime change**, **no memory-model change** — master
  already has those right.

## Implementation note — verify first

The plan's **first step** confirms whether musl 1.2.5's `system()`/`popen()` already
route through `posix_spawn` (a clean source fetch was inconclusive). This decides the
size of the musl change before anything else.

## Edge cases / risks

- **Raw-`fork`/`vfork` packages** fail to link (symbols absent). Ported via the one
  documented `posix_spawn` pattern if wanted, else unsupported. Risk: the
  `posix_spawn`-clean set is smaller than "all of nixpkgs" — accepted.
- **Removing `fork`/`vfork` symbols must not break musl internals** — hence the
  verify-first step (musl's own `system`/`popen` must not call them).
- **Soft isolation** — inherent to NOMMU; acceptable for a single-user environment.

## Testing strategy

- **No regression on master's working behavior:** the full nix system still boots in
  the node runner and `nix-env -iA sl` renders (the existing Phase-A/B gate).
- **Spawn coverage:** a guest program using `posix_spawn`/`system`/`popen` builds and
  runs unmodified; a program calling raw `fork()`/`vfork()` **fails to link at build
  time** (symbol absent) — a clean Nix build error, never a guest crash/abort.
- **Existing suites** (engine unit tests, smoke) stay green.

## Acceptance criteria

- Memory model unchanged from master; documented as the deliberate NOMMU choice.
- `posix_spawn`/`system`/`popen` work; raw `fork()`/`vfork()` fail at **link time**
  (no more runtime abort-stub/SIGILL).
- The spawn contract is documented; busybox/ash spawn patches are the single labeled
  `vfork`→`posix_spawn` port; no new ad-hoc per-program hacks.
- The two dead-ends (per-process Memory ~124 cap; WasmFX one-shot) are recorded with
  their spikes so the path is not re-explored.
