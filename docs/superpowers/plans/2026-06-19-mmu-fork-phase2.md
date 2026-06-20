# Phase 2 — True `fork()` via the Double-Return Seam (asyncify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user process can call POSIX `fork()` and have **both parent and child return at the call site** — parent with the child pid, child with `0` — each with a **private, verbatim-copied** address space, with correct `waitpid`/exit-status/signal semantics handled by the real in-wasm kernel. Built on the Phase-1 per-process-`Memory` substrate; the clone-with-fn fast path (`posix_spawn`/`vfork`+exec) is preserved and pays no asyncify cost.

**Status of prerequisite:** Phase 1 (per-process address spaces) is COMPLETE and merged into this branch's base (`mmu-fork` @ `2848edc`). Each process already has its own base-0 `WebAssembly.Memory`; all kernel↔user access flows through the host-bridge; `CLONE_VM` threads share the parent's `Memory`. This plan adds **only the second half of `fork()` — the double-return** — over that substrate.

## The central architectural fact (drives the whole design)

The **user program and the kernel are separate wasm instances**. A user `fork()` issues `__wasm_syscall_5(SYS_clone, …)`, which is a **host (JS) import** — not a direct call into the kernel. The runtime's worker run-loop is the one that bounces that syscall into the kernel instance and returns the result to the user instance.

Therefore the double-return is orchestrated **at the host run-loop**, not inside a single wasm module:

1. User `fork()` calls **`capture_stack()`** → Binaryen-asyncify **unwinds the user instance's call stack** into a buffer *in the user's own linear memory*, propagating the return all the way up to the user export the runtime last entered.
2. The runtime's worker run-loop observes the unwind (a pending-fork flag) and drives the **real kernel `clone`** (so the kernel allocates the child task struct / pid / `mm`), then asks the host to **duplicate the parent `Memory` verbatim into a fresh child `Memory`** (the asyncify buffer rides along, being in linear memory), then **starts the child worker**.
3. Parent and child each **`resume_stack(buf)`** → asyncify **rewinds** → both return out of `fork()` — parent with child pid, child with `0`.
4. `waitpid` / exit-status / signals are **unchanged real-kernel semantics**.

This is exactly spec risk **B3** ("capture/resume lands exactly at the libc `fork()` frame, not mid-syscall; asyncify must unwind *through* musl's syscall wrapper cleanly"). Because it is the highest-uncertainty item, **Task 0 is a standalone spike that proves the mechanism end-to-end before any musl/kernel work**, mirroring Phase-1's "de-risk the ABI first" Task 1.

**Decomposition past Task 0 is provisional and WILL be revised from the spike's findings** (e.g., whether asyncify can unwind through the existing syscall wrapper unchanged, or whether `fork()` must avoid issuing the typed `SYS_clone` and instead signal the host purely via `capture_stack`).

## Architecture

```
┌─ Toolchain (toolchain/guest-cc.nix, guest-cxx.nix, musl.nix) ──────────────┐
│  wasm-opt --asyncify (allow-listed to the fork call graph) at link          │
│  musl fork(): capture_stack() ▸ [host orchestrates clone+dup] ▸ resume_stack │
│  capture_stack/resume_stack = thin wrappers over asyncify_start/stop_*       │
└────────────────────────────── THE SEAM ────────────────────────────────────┘
┌─ Kernel arch/wasm (patches/kernel/00NN) ───────────────────────────────────┐
│  non-CLONE_VM clone from a user task ▸ request runtime "duplicate AS"        │
│  (distinct from CLONE_VM share-path and exec fresh-memory-path)              │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ Runtime (runtime/kernel-worker.js, kernel-host.js, hostbridge.js) ─────────┐
│  run-loop catches the user unwind; drives kernel clone; host mints child     │
│  Memory+table; verbatim byte-copy parent→child; spawns child worker;         │
│  both instances asyncify-rewind → double return                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Tech Stack:** joelseverin/linux wasm port (kernel C as `patches/kernel/00NN-*.patch`, applied by `kernel.nix`); musl 1.2.5 (`patches/musl/00NN-*.patch`, applied by `toolchain/musl.nix`); Binaryen `wasm-opt` (`pkgs.binaryen`); guest toolchain drivers (`toolchain/guest-cc.nix`, `guest-cxx.nix`); the in-repo `runtime/` harness (`kernel-worker.js`, `kernel-host.js`, `hostbridge.js`, `boot.js`); Nix flake build; `runtime/node/*.mjs` test harness.

## Global Constraints

- **PRIME DIRECTIVE:** no shortcuts/hacks/stubs. Every nix-wasm artifact is a reproducible derivation; kernel changes are numbered `patches/kernel/00NN-*.patch`, musl changes numbered `patches/musl/00NN-*.patch`, both referenced in their `.nix`. **No "fork without the double-return" shortcut** — a child that "restarts libc from scratch" fails the fork-without-exec acceptance and is forbidden.
- **Wasm-guard everything shared.** Asyncify is **opt-in / off by default**: the canonical `.#guest-cc` / `.#guest-clang` / `.#musl` derivation hashes stay byte-identical when the asyncify flag is off (echoes the ccache opt-in discipline). No native-package build changes.
- **The clone-with-fn fast path is sacred.** `posix_spawn` / `vfork`+exec keep using clone-with-fn with **zero asyncify cost**. Only true `fork()`-without-exec pays asyncify. The Phase-1 B2 regression guard (`runtime/node/task2.5-fastpath.test.mjs`) must stay green throughout.
- **Host-bridge ABI is a versioned contract.** Bump `WASM_HOSTBRIDGE_ABI` (currently 2 → 3) on any kernel↔runtime ABI addition; kernel `#define` and runtime constant must match (exec-ABI-skew lesson).
- **Single page-aware choke point preserved.** All kernel↔user byte access still flows through the host-bridge (forward-compat rule 1). The fork memory-dup is a **discrete, replaceable step** (forward-compat rule 2: eager-copy → COW is a single-site swap later).
- **Reference, don't rebuild oracle.** Kernel source for reading: `/home/vbvntv/lwbuild/ws/src/kernel` (rev `039e5f3e`). Author changes as patches against that rev. Don't `nix store gc`; don't kill running LLVM builds.
- **Build invocation:** `export NIX_CONFIG="experimental-features = nix-command flakes"`; run each `sudo nix build` as its own command (`echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#<attr> --print-out-paths`). Sudo password in agent memory, NOT the repo.
- **Two RED static gates pre-exist** on this branch from in-flight Wayland files (`runtime` lint/format on `boot.js`, `virtio/*`) — not this plan's regressions. New files this plan adds must themselves pass `bun run lint` / `format:check` / `typecheck`.

---

## File Structure

**Toolchain (`toolchain/`):**
- Modify `guest-cc.nix` / `guest-cxx.nix` — add an opt-in post-link `wasm-opt --asyncify` pass (allow-listed via `--pass-arg=asyncify-onlylist@…`), gated on an `enableAsyncify` arg (default `false`); add `pkgs.binaryen` to that path's inputs; declare the `capture_stack`/`resume_stack`/asyncify imports. (Tasks 1)
- Create `patches/musl/0008-fork-asyncify-seam.patch` — real `fork()`/`_Fork()` that calls `capture_stack()` and `resume_stack(buf)` around the host-orchestrated clone; the two seam primitives in `src/thread/wasm/`. (Task 2)
- Modify `musl.nix` — add `0008` to the patch list; build a `musl-fork` variant (or condition the seam on a flag) so the canonical `musl` hash is unchanged. (Task 2)

**Kernel (`patches/kernel/`, `kernel.nix`):**
- Create `patches/kernel/0024-wasm-fork-dup-addrspace.patch` — on a non-`CLONE_VM` clone from a user task, request the runtime duplicate the parent address space (new import / message), distinct from the `CLONE_VM` share path and the exec fresh-memory path; bump `WASM_HOSTBRIDGE_ABI` to 3. (Task 3)
- Modify `kernel.nix` — add `0024` to the patch list.

**Runtime (`runtime/`):**
- Modify `kernel-worker.js` — run-loop catches the user-instance asyncify unwind (pending-fork); set `current_user_pid` for the child; resume both instances. (Tasks 0, 4)
- Modify `kernel-host.js` — new message handler that mints the child `Memory`+table, verbatim-copies parent→child bytes, spawns the child worker; teardown. (Tasks 0, 4)
- Modify `hostbridge.js` — `WASM_HOSTBRIDGE_ABI = 3`; any new lifecycle helper for the dup. (Tasks 3, 4)
- Create `runtime/asyncify.js` (or fold into `hostbridge.js`) — the asyncify orchestration helpers (`asyncify_start_unwind`/`stop_unwind`/`start_rewind`/`stop_rewind` import wiring, the pending-fork protocol). (Task 0)

**Tests / acceptance (`runtime/node/`, `userspace/`):**
- Create `userspace/fork-tests.nix` — the in-guest `fork()` correctness programs (returns-twice, private-memory, waitpid/status, fork-without-exec, nested, fork-in-thread, B3 boundary), each built by `guest-cc` + asyncify, baked into an initramfs. (Task 5)
- Create `runtime/node/phase2-acceptance.mjs` + per-case `.test.mjs` runners. (Task 5)
- Modify `flake.nix` — expose `.#fork-tests` (and the asyncify-enabled `guest-cc` variant) as build targets. (Tasks 1, 5)

---

## Task 0: Asyncify double-return SPIKE (de-risk B3 before any musl/kernel work)

**Purpose:** prove, in isolation, that the runtime can take a fork-capable wasm instance, **unwind it via asyncify back to the host run-loop, verbatim-copy its `Memory` into a second instance/worker, and rewind BOTH so a single call returns twice** — with the resume landing exactly at the call site. No kernel `clone`, no musl `fork()` yet: a hand-built minimal C program compiled with `guest-cc` + `wasm-opt --asyncify`, driven by a throwaway harness. This validates the spec's hardest open question (B3) and fixes the host↔worker fork protocol shape that Tasks 3–4 implement for real.

**Files:**
- Create: `spikes/asyncify-fork/probe.c` — a program that calls a `do_fork()` host import: prints a pre-fork line, calls `do_fork()`, then prints `RET=<n>` (run twice: parent sees a nonzero token, child sees 0), then both mutate a global and print it to prove memory independence.
- Create: `spikes/asyncify-fork/run.mjs` — a throwaway harness wiring the asyncify imports + the copy/spawn/rewind orchestration against `runtime/` primitives.
- (Spike code may live outside the normal build; it is exploratory and need not be a polished derivation — but record findings in the spec.)

**Interfaces (the protocol this spike pins down, consumed by Tasks 3–4):**
- `capture_stack()` user→host: triggers `asyncify_start_unwind(buf)`; the host run-loop sees the export return with a pending-fork flag set.
- host orchestration: mint child `Memory` (`shared:true`, same `maximum`), `new Uint8Array(child.buffer).set(new Uint8Array(parent.buffer))`, spawn child worker, deliver child `Memory`.
- `resume_stack(buf)` host→both instances: `asyncify_start_rewind(buf)` then re-enter the same export; on reaching the original `capture_stack` call site, return the per-side value (parent token vs `0`).

- [ ] **Step 1: Write the failing spike harness**

Create `spikes/asyncify-fork/run.mjs` that boots the probe instance, expects two `RET=` lines (one `RET=<nonzero>`, one `RET=0`) and two **different** post-fork global values. Initially it must FAIL (no asyncify pass, imports absent).

- [ ] **Step 2: Run it — verify it fails**

`node spikes/asyncify-fork/run.mjs` → FAIL (asyncify imports missing / single return only).

- [ ] **Step 3: Build the probe with asyncify**

Compile `probe.c` with `guest-cc` then `wasm-opt --asyncify --pass-arg=asyncify-onlylist@do_fork,capture_stack,resume_stack,main` (allow-list the fork call graph only). Confirm the asyncify globals/exports (`asyncify_start_unwind`, `asyncify_stop_unwind`, `asyncify_start_rewind`, `asyncify_stop_rewind`, `__asyncify_state`, `__asyncify_data`) are present.

- [ ] **Step 4: Implement the host orchestration**

In `run.mjs`: provide `do_fork` as the unwind trigger; in the run-loop, on pending-fork, allocate the asyncify buffer region (in the instance's own memory), copy memory → child, spawn the child worker (reusing `runtime/` worker creation), and rewind both. **Confirm the resume lands exactly at the `do_fork()` call site** (B3) — assert the pre-fork print is NOT repeated and the post-fork print IS reached on both sides.

- [ ] **Step 5: Measure the asyncify tax**

Record `.wasm` size with/without the pass and a rough cycle cost of one fork. Note the allow-list scope that bounds it. Write findings into the spec (§9 "Asyncify cost (known)" open item).

- [ ] **Step 6: Run the spike — PASS**

`node spikes/asyncify-fork/run.mjs` → two returns (`RET=<token>` + `RET=0`), independent globals, resume at call site. **SPIKE PASS.**

- [ ] **Step 7: Record findings + revise the plan**

Write a short findings note into the spec (B3 resolution: does asyncify unwind cleanly through the syscall wrapper, or must `fork()` avoid the typed `SYS_clone`?). **Update Tasks 2–4 below to match** before implementing them. Commit the spike + findings.

```bash
cd /home/vbvntv/Code/nix-wasm-worktrees/phase2-fork && git add spikes/asyncify-fork docs/superpowers/specs/2026-06-18-mmu-fork-design.md && \
  git commit -m "spike(wasm): asyncify double-return PoC — proves B3 (return-twice + memory dup at host run-loop)"
```

---

## Task 1a: Host-side asyncify build path for fork-capable guest binaries

**SCOPE CORRECTION (discovered at T1 start):** `guest-cc` (`toolchain/guest-cc.nix`)
is the **in-guest** driver — a POSIX-sh wrapper that runs *inside* the wasm guest
over the wasm-built clang/wasm-ld. There is **no `wasm-opt` in-guest** (binaryen is
not cross-built to wasm32), so the asyncify pass cannot live in `guest-cc` as
originally written. Asyncify must instrument the **user's own fork-reachable
frames** (Task 0 proved user frames like `deep()` get rewound), so fork-capable
programs need the pass at their own build.

**Decision (aligned with the caching design goal "host builds, guest
substitutes"):** the fork acceptance programs (Task 5) are built **host-side** as
Nix derivations — the same cross cc-wrapper that builds `userspace/isoa.c`
(`cross.stdenv.cc`) plus host `pkgs.binaryen` `wasm-opt --asyncify`. This is the
realistic, cacheable path and unblocks fork() for the suite.

**IN SCOPE for Phase 2 (user decision 2026-06-20):** in-guest asyncify too — a user
must be able to compile a fork() program *interactively inside the guest*. That
needs `wasm-opt` available in-guest ⇒ cross-build binaryen→wasm32 (Task **T1b**).
Feasible: we already cross-build all of LLVM→wasm32 for `guest-clang`; binaryen is
smaller. Sequenced AFTER the host path proves fork() end-to-end (T1a→T2–T5), so
in-guest fork compilation lands as the capstone, not on the critical path.

This task therefore splits: **T1a** (host-side asyncify build path — below) and
**T1b** (in-guest binaryen — its own section after Task 5).

**Files:**
- Create: `userspace/asyncify-cc.nix` — a host derivation helper: cross-compile a C
  source with `cross.stdenv.cc`, then `wasm-opt --asyncify
  --pass-arg=asyncify-imports@env.capture_stack
  --pass-arg=asyncify-onlylist@<fork call graph>` (Task-0 finding B); expose the
  asyncify control exports. Reused by Tasks 2/5 to build fork binaries.
- Modify: `flake.nix` — expose a smoke target `.#asyncify-cc-smoke` (builds a
  trivial `fork()`-calling C and asserts the asyncify exports), without touching
  `.#guest-cc`.

**Interfaces:**
- Produces: a host build path emitting asyncify-instrumented guest `.wasm` exporting
  `asyncify_{start,stop}_{unwind,rewind}` + `asyncify_get_state`; canonical
  `.#guest-cc`/`.#guest-clang`/`.#musl` hashes unchanged.
- Consumes: Task-0 control surface + allow-list (`asyncify-imports@env.capture_stack`).

- [x] **Step 1: Failing test** — `runtime/node/asyncify-link.test.mjs`: build a trivial `capture_stack()`-calling C via the host helper; assert the `.wasm` exports `asyncify_start_unwind`/`start_rewind`. FAIL initially.
- [x] **Step 2: Run, expect FAIL.**
- [x] **Step 3:** Write `userspace/asyncify-cc.nix` (cross-compile → host `wasm-opt --asyncify` allow-listed); expose `.#asyncify-cc-smoke`.
- [x] **Step 4: Verify canonical hashes unchanged** — `.#guest-cc` / `.#musl` out-paths identical to pre-change.
- [x] **Step 5: Run, expect PASS** (asyncify exports present; measure the allow-list-bounded size tax on this real binary — the Task-0 §9 open item).
- [x] **Step 6: Commit** (`toolchain(wasm): host-side asyncify build path for fork-capable guest binaries`).

---

## Task 2: musl real `fork()` over the seam

`patches/musl/0008`: replace the abort/clone-only `_Fork()` with a real `fork()` that calls `capture_stack()` and `resume_stack(buf)` around the host-orchestrated clone, with the asyncify data buffer in user linear memory. Keep `posix_spawn`/`vfork` clone-with-fn untouched (no asyncify).

**Task-0 RESOLVED the seam shape (finding B):** `capture_stack` is a **dedicated host import** that `fork()` calls directly to trigger the asyncify unwind — NOT the generic `__wasm_syscall_N` wrapper. `fork()` does **not** issue the typed `SYS_clone`; it commits fork-relevant state to memory (finding C), calls `capture_stack()` (unwinds to the host run-loop), and the host drives the real kernel clone + dup + dual rewind; `resume_stack(buf)` is the rewind-side `asyncify_stop_rewind` + return. This keeps the generic syscall path asyncify-free (fast path preserved) and sidesteps B3's "unwind through the syscall wrapper" concern entirely. `asyncify-imports@env.capture_stack` is the only unwind import; `asyncify-onlylist@<fork call graph>` bounds instrumentation.

**Files:**
- Create: `patches/musl/0008-fork-asyncify-seam.patch` — `src/process/_Fork.c` (the seam), `src/thread/wasm/asyncify.{c,S}` (`capture_stack`/`resume_stack` over `asyncify_start/stop_unwind/rewind` + the buffer), import decls.
- Modify: `toolchain/musl.nix` — add `0008`; keep canonical `musl` hash unchanged (seam behind the fork build variant).

**Interfaces:**
- Consumes: Task 1 asyncify pass; Task 0 protocol.
- Produces: a `fork()` that returns twice over the seam; `_Fork`'s clone-with-fn callers (posix_spawn) unaffected.

- [ ] **Step 1: Failing test** — in-guest `fork()` returns-twice program built with the asyncify `guest-cc`, run in the harness; FAIL (musl fork still aborts/single-returns).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3:** Author `0008`; implement `capture_stack`/`resume_stack`; wire the asyncify buffer; condition the seam so `posix_spawn` keeps the fast path.
- [ ] **Step 4:** Build the fork musl variant; rebuild the test binary.
- [ ] **Step 5: Run, expect PASS** (returns-twice in-guest, fast path still green).
- [ ] **Step 6: Commit** (`musl(wasm): real fork() over the capture_stack/resume_stack seam`).

---

## Task 3: Kernel fork-dup hook

`patches/kernel/0024`: on a **non-`CLONE_VM`** clone from a user task, the kernel requests the runtime **duplicate the parent address space** into the child — distinct from the `CLONE_VM` share path (0018) and the exec fresh-memory path (0017). Bump `WASM_HOSTBRIDGE_ABI` → 3. **(Provisional — branch point confirmed against Task 0/the current copy_thread/`wasm_create_and_run_task` flow.)**

**Files:**
- Create: `patches/kernel/0024-wasm-fork-dup-addrspace.patch` — the branch in `arch/wasm` clone handling (`copy_thread`/`__switch_to`/`wasm_create_and_run_task` callout) + the new import decl in `arch/wasm/include/asm/wasm.h` + `WASM_HOSTBRIDGE_ABI 3`.
- Modify: `kernel.nix` — add `0024`.

**Interfaces:**
- Consumes: Phase-1 per-mm allocator + `wasm_user_mem_*`; the runtime dup handler (Task 4).
- Produces: a kernel-side "duplicate AS for parent→child" request fired only for user-task non-`CLONE_VM` clones.

- [ ] **Step 1: Failing test** — instrumented boot asserting the dup request fires exactly once on a fork (not on thread-create, not on exec). FAIL.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3:** Author `0024`; branch on `!(clone_flags & CLONE_VM)` from a user task; call the new import; guard so kthreads/early-boot/exec are untouched.
- [ ] **Step 4:** Add to `kernel.nix`; `nix build .#kernel` + `.#wasm-store-manifest`; re-point artifacts.
- [ ] **Step 5: Run, expect PASS** (dup fires once per fork; CLONE_VM/exec paths unchanged; boot green).
- [ ] **Step 6: Commit** (`kernel(wasm): request runtime address-space dup on non-CLONE_VM user clone (ABI v3)`).

---

## Task 4: Runtime fork orchestration (verbatim dup + dual rewind)

Implement the host-side handler the kernel (Task 3) and musl (Task 2) drive: catch the user unwind, drive the kernel `clone`, mint the child `Memory`+table, **verbatim byte-copy parent→child** (asyncify buffer included), spawn the child worker, rewind both. Plus teardown.

**Files:**
- Modify: `runtime/kernel-host.js` — the dup handler (mint child `Memory`, byte-copy, spawn child worker, deliver), teardown on child exit.
- Modify: `runtime/kernel-worker.js` — pending-fork in the run-loop; set `current_user_pid` for the child before instantiation; rewind both instances; `should_call_clone_callback=false` for fork (resume the *existing* user instance, not `_start`).
- Modify: `runtime/hostbridge.js` — `WASM_HOSTBRIDGE_ABI = 3`; dup lifecycle helper.
- New message types: `fork_dup_request` (worker→host) and `fork_child_ready`/rewind signal (host→worker).

**Interfaces:**
- Consumes: Task 0 protocol; Task 2 seam; Task 3 kernel request.
- Produces: a working host-orchestrated double-return; child `Memory` independent of parent (mutations don't cross); registry teardown on child reap with no leak.

- [ ] **Step 1: Failing test** — the Task 2 returns-twice + private-memory program now run **through the real kernel** (not the spike harness); FAIL until the host handler exists.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3:** Implement the dup handler + worker-side pending-fork/rewind; ABI bump to 3 (match Task 3). **ORDERING (Task-0 finding A, mandatory):** create the child worker+instance FIRST, then verbatim-copy parent→child memory over the top — a fresh instance re-applies active data segments and would otherwise clobber the copied `.bss`/`.data`. (Equivalently, suppress segment re-init for fork children.)
- [ ] **Step 4:** Verify independence (child mutates a var; parent's copy unchanged after `waitpid`) and teardown (registry returns to baseline; no use-after-free under rapid fork/exit — reuse the Phase-1 teardown instrumentation).
- [ ] **Step 5: Run, expect PASS** (returns-twice + private memory + waitpid/status over the real kernel).
- [ ] **Step 6: Commit** (`runtime: host-orchestrated fork double-return (verbatim AS dup + dual asyncify rewind, ABI v3)`).

---

## Task 5: Acceptance suite (imported POSIX/musl subset + bespoke B3)

Assemble the spec §8 acceptance matrix as in-guest programs compiled by the asyncify `guest-cc`, run in the harness, CI-runnable as flake attrs. Map 1:1 to the matrix.

**Files:**
- Create: `userspace/fork-tests.nix` — the matrix programs baked into an initramfs:
  - returns-twice (parent pid>0, child 0)
  - private memory (child mutates a var; parent's unchanged after `waitpid`)
  - `waitpid`/status (`WEXITSTATUS` matches child `exit(n)`)
  - fork-without-exec (child runs parent code to completion — exercises asyncify resume)
  - nested fork (child forks grandchild; pids distinct; both reap)
  - fork in a threaded process (live-pthread process forks; child single-threaded, copied memory, no deadlock)
  - B3 boundary probe (resume lands at the libc `fork()` frame, not mid-syscall)
  - plus a cherry-picked Open POSIX Test Suite `conformance/interfaces/{fork,waitpid}` subset that compiles under `guest-cc`/musl (note any dropped for `ptrace`/`/proc`).
- Create: `runtime/node/phase2-acceptance.mjs` (aggregate; exit-2 = inconclusive boot panic, re-run) + per-case `.test.mjs`.
- Modify: `flake.nix` — expose `.#fork-tests`.
- Modify: `docs/superpowers/specs/2026-06-18-mmu-fork-design.md` — tick the Phase-2 acceptance (§3, §8 matrix, B3) with evidence.

**Interfaces:**
- Consumes: Tasks 1–4. Keeps the Phase-1 B2 fast-path guard green.

- [ ] **Step 1:** Write each matrix case + the aggregate runner (failing).
- [ ] **Step 2:** Run, expect FAIL on the not-yet-covered cases.
- [ ] **Step 3:** Build `.#fork-tests`; wire the harness; cherry-pick the compiling POSIX subset (log drops — the §8 caveat).
- [ ] **Step 4: Run the full suite, expect PASS** (all matrix cases + B3; B2 fast path still green; full nix boot still green).
- [ ] **Step 5:** Tick the spec's Phase-2 acceptance with evidence; commit.

```bash
cd /home/vbvntv/Code/nix-wasm-worktrees/phase2-fork && git add userspace/fork-tests.nix runtime/node/phase2-acceptance.mjs runtime/node/*.test.mjs flake.nix docs/superpowers/specs/2026-06-18-mmu-fork-design.md && \
  git commit -m "test: Phase 2 fork() acceptance suite — returns-twice/private-mem/waitpid/nested/threaded/B3 (spec §8 met)"
```

---

## Task 1b: In-guest asyncify — cross-build binaryen→wasm32 (capstone)

Make `wasm-opt` available **inside the guest** so a user can compile a fork()
program interactively and have it work. Cross-build binaryen to wasm32-nommu with
the same `cross` C++ toolchain that builds the rest of guest userspace, wire it
into the in-guest `cc` driver, and prove an in-guest `cc fork.c && ./fork`.

**Sequenced last** — fork() is already proven end-to-end via the host path
(T1a→T5); this extends it to in-guest compilation. Heaviest single task (a
from-source C++ cross-build); isolate breakage here from the proven core.

**Files:**
- Create: `toolchain/guest-binaryen.nix` — binaryen `wasm-opt` cross-built to
  wasm32-nommu (mirror `guest-clang.nix`'s cross-LLVM recipe: `cross.stdenv`,
  static libc++, NOMMU/no-fork accommodations — `wasm-opt` must run single-process
  under the guest, no threads/fork; pass `-DBUILD_TESTS=OFF`, disable its thread
  pool). Audit binaryen for `fork`/`std::thread`/`mmap-file` use; gate as needed.
- Modify: `toolchain/guest-cc.nix`, `guest-cxx.nix` — when the source's fork call
  graph is present (or always, opt-in via a `cc` flag), run the in-guest
  `wasm-opt --asyncify` allow-listed pass as a third exec after compile+link. NOMMU
  spawn rule: each step is its own process via `posix_spawn` (like the existing
  clang→wasm-ld split) — confirm binaryen doesn't internally fork.
- Modify: `flake.nix` — expose `.#guest-binaryen`; add `wasm-opt` to the served
  closure (`bootstrap.nix`/store manifest) so it's in `/nix` for the guest.
- Create: `userspace/fork-tests.nix` gains an in-guest-compiled variant of one fork
  case (compiled by the in-guest `cc`, not host-baked) to prove the path.

**Interfaces:**
- Consumes: T1a's allow-list/control-surface knowledge; the proven host fork() (T5).
- Produces: in-guest `cc fork.c && ./fork` returns twice; `.#guest-binaryen` in the
  served closure.

- [ ] **Step 1: Failing test** — harness boots, in-guest `cc` compiles a fork() C and runs it; FAIL (no in-guest wasm-opt; fork single-returns).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3:** Author `toolchain/guest-binaryen.nix` (cross-build wasm-opt); audit/gate binaryen's threads/fork/file-mmap for NOMMU wasm.
- [ ] **Step 4:** Wire the in-guest `wasm-opt --asyncify` step into `guest-cc`; add to the served closure.
- [ ] **Step 5:** Build (`.#guest-binaryen`, kernel/manifest if closure changed); boot; run the in-guest fork compile+run.
- [ ] **Step 6: Run, expect PASS** (in-guest `cc fork.c && ./fork` returns twice).
- [ ] **Step 7: Commit** (`toolchain(wasm): in-guest wasm-opt (cross-built binaryen) — interactive in-guest fork() compilation`).

## Self-Review

**Spec coverage (`2026-06-18-mmu-fork-design.md` §6 + Phase-2 portions):**
- §6 the seam (`capture_stack`/`resume_stack`, asyncify-backed) → Tasks 0 (spike), 2 (musl).
- §6 fork() flow (capture → kernel `clone`/`copy_process` → runtime dup → dual resume) → Tasks 0, 2, 3, 4. Steps 1–4 of the flow map to: musl seam (2), kernel request (3), host dup+rewind (4), with §6 step "duplicate the address space" kept a **discrete** step (forward-compat rule 2).
- §6 fast path preserved (posix_spawn/vfork no asyncify) → Global Constraints + Tasks 2/1 (allow-list bounds cost) + Phase-1 B2 guard kept green in Task 5.
- §6 toolchain (Binaryen asyncify allow-listed; musl gains fork + seam) → Tasks 1, 2.
- §7 forward-compat rule 1 (single page-aware host-bridge choke point) → unchanged from Phase 1, preserved. Rule 2 ("duplicate memory" discrete/replaceable) → Task 4 design.
- §8 acceptance (imported POSIX/musl subset + bespoke B3; in-guest `guest-cc`; CI flake attr) → Task 5. Matrix (returns-twice/private-mem/waitpid/fork-without-exec/nested/threaded) → Task 5. B1/B2 (Phase-1) → kept green.
- §9 risks: asyncify cost → Task 0 Step 5 (measure) + allow-list (Tasks 1/2); threaded-fork semantics → Task 5 case + Task 4 (drop other threads' workers); stack capture across syscall boundary (B3) → Task 0 (primary spike goal) + Task 5 B3 probe; worker/Memory lifecycle teardown → Task 4 Step 4; two-repo ABI → `WASM_HOSTBRIDGE_ABI` v3 (single repo now, but kernel↔runtime contract still versioned); `get_user_pages` callers → unchanged from Phase 1.

**Sequencing rationale:** Task 0 (spike) FIRST because B3 is the highest-uncertainty item and its outcome reshapes Tasks 2–4 (it answers "can asyncify unwind through the syscall wrapper, or must fork() signal the host directly?"). Tasks 1→2→3→4 build the seam bottom-up (toolchain → libc → kernel → runtime) so each layer's test can run against the layer below. Task 5 is the spec acceptance gate.

**Provisional-decomposition flag:** Tasks 2–4's exact seam/branch shapes are explicitly marked provisional pending Task 0. This is deliberate — committing the musl/kernel diffs before the spike proves the mechanism would risk the Phase-1 corollary-1 mistake (solving the immediate step, not the goal).

**Out of scope (deferred, per spec §10):** per-page virtual memory / COW fork / file `mmap` (the §7 upgrade); switching user binaries off `-shared` PIC; swapping asyncify for JSPI/stack-switching. The eager copy and fixed stack persist.

## Execution Handoff

Phase 2 is gated on the **Task 0 spike** passing (B3 proven) before the musl/kernel commitments. After the spike, implement Tasks 1–5 task-by-task via superpowers:subagent-driven-development, keeping the Phase-1 acceptance (B1 isolation, B2 fast path, full nix boot) green at every step. The asyncify tax measured in Task 0 sets the allow-list scope for Tasks 1–2.
