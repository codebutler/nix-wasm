# Design: per-process address spaces + true `fork()` for the wasm Linux guest

**Date:** 2026-06-18
**Status:** Design approved; implementation plan to follow (writing-plans).
**Scope owner repos:** `nix-wasm` (kernel `arch/wasm` patches + musl + toolchain) and
`pc` (the JS runtime: `runtime/linux.js`, `kernel-worker.js`, `kernel-host.js`).

## 1. Summary

Give the native wasm Linux guest **real per-process address spaces** and **true
return-twice POSIX `fork()`**, without abandoning native execution (no CPU
emulation). Each process gets its own base-0 `WebAssembly.Memory` + function
table; `fork()` duplicates that memory verbatim and resumes both parent and child
at the call site via a swappable double-return mechanism (asyncify now,
stack-switching later) hidden behind a libc/kernel seam.

This replaces today's model — one shared `WebAssembly.Memory` with every process
relocated to an offset (`__memory_base = data_start`) — which makes real `fork()`
impossible (a child can't occupy the parent's addresses, and copying to a new base
would require relocating un-identifiable pointers). Per-process base-0 memory
dissolves that: `fork()` becomes a verbatim byte copy into a fresh base-0 memory,
so every pointer stays valid with **zero relocation**.

## 2. Background and prior art

- **The blocker (recorded in repo memory `fork-vfork-nommu-strategy`,
  `wasm-feature-set-mismatch`):** the wasm Linux port is NOMMU with one shared
  linear memory; only clone-with-fn spawn works. `fork()`/`vfork()` SIGILL/abort.
- **Why per-process memory is the fix, not a hack:** it is exactly the "MMU-style
  port where each process has its own base-0 memory (pointers valid after bulk
  copy)" that the memory note named as the only real solution.
- **No precedent in any wasm Linux kernel (checked 2026-06-19).** Per-process
  memory isolation has no prior implementation across every branch of
  `joelseverin/linux` and `joelseverin/linux-wasm` (including `wasm-7.0`, our pin
  `039e5f3e`, and `master`). All branches are NOMMU with one shared address space;
  "MMU support" is listed as *Future*, with the explicit note that "memory cannot
  be mapped and shared between processes." Upstream's active memory direction is
  **Memory64** (experimental, `NOMERGE`) — a bigger *single shared* 64-bit space,
  orthogonal to isolation. The nearest mechanism precedent is **WALI** (arXiv
  2312.03858), which grows wasm memory for `mmap` — but in the inverse
  wasm-on-host model. This approach is first-of-its-kind on joelseverin's kernel.
  See tracking issue codebutler/nix-wasm#12 for unrelated runtime/build sync.
- **WASIX `proc_fork` is the existence proof.** Wasmer's WASIX implements real
  fork in the browser via *asyncify-freeze the stack → copy linear memory → resume
  in a new Worker*. It is **not reusable directly** — it lives at the
  runtime-is-the-kernel / WASI-ABI layer, whereas our `fork()` must issue a real
  Linux `clone` syscall into the in-wasm Linux kernel (which owns PIDs,
  `copy_process`, `waitpid`). We **borrow the technique and use `wasix-libc` as a
  reference**, and reimplement at our kernel+runtime layer.
- **Two halves of `fork()`.** Per-process memory solves the *address-space* half
  (pointer validity). It does **not** solve the *double-return* half: the wasm
  call stack lives in the engine, not in linear memory, so the child still needs a
  mechanism to resume mid-`fork()`. That is what asyncify (or, later,
  stack-switching) provides. The two halves are independent.

## 3. Goals / non-goals / acceptance

### Goals
- One `WebAssembly.Memory` + function table per process (base-0, isolated);
  threads (`CLONE_VM`) share their process's.
- True `fork()`: parent and child both resume at the call site with private,
  verbatim-copied memory; correct `waitpid`/exit-status/signal semantics (handled
  by the real in-wasm kernel).
- Kernel↔user memory access reworked as a single host-mediated, page-aware bridge.
- A swappable double-return mechanism behind a libc/kernel seam
  (`capture_stack`/`resume_stack`): asyncify now, stack-switching later.

### Non-goals (explicit)
- **No per-page MMU features:** no demand paging, no copy-on-write, no
  `mmap`-of-files semantics beyond today's NOMMU behavior. `fork()` copies eagerly.
- **Fixed-stack / no-demand-paging persists.** Per-process isolation removes the
  *fork* and *PIC/load-address* NOMMU requirements, but the fixed-stack assumption
  remains because per-page paging is out of scope (`WebAssembly.Memory.grow`
  appends at the end of linear memory, so a downward stack can't fault-grow).
- **No new guest libc** — extend musl; `wasix-libc` is reference only.
- **No dependency on unshipped wasm proposals.** JSPI / core stack-switching are a
  future drop-in behind the seam, not a build dependency.

### Acceptance
An in-guest `fork()` correctness suite passes (Section 8): returns-twice, child has
private memory, `waitpid`/exit status, fork-without-exec, nested fork, fork in a
threaded process, plus the wasm-specific isolation probe and fast-path regression.

## 4. Architecture: three layers + two seams

The work divides across three layers, coupled only through two narrow interfaces —
the **host-bridge** and the **double-return seam**.

```
┌─ Toolchain / libc ─ guest-cc/guest-clang + musl ───────────────┐
│  musl fork() → capture_stack ▸ clone syscall ▸ resume_stack     │
│  asyncify pass (allow-listed) applied at link  ── THE SEAM ──┐  │
└──────────────────────────────────────────────────────────────┼─┘
┌─ Kernel arch/wasm (nix-wasm: patches/kernel/*) ───────────────┼─┐
│  per-process address-space model; copy_process/fork hookup;   │ │
│  copy_to_user/from_user/get_user_pages ▸ host-bridge calls ───┼─┤
└──────────────────────────────────────────────────────────────┼─┘
┌─ pc JS runtime (linux.js / kernel-worker.js / kernel-host.js) ┼─┐
│  per-process Memory+table alloc; instantiate user binary at   │ │
│  base 0; fork = copy bytes verbatim; host-bridge byte copies; │ │
│  asyncify orchestration (freeze → copy → resume in new Worker) │ │
└────────────────────────────────────────────────────────────────┘
```

- **The host-bridge** replaces "kernel directly addresses user memory." The kernel
  asks the runtime to copy N bytes between kernel memory and a *named* process
  memory. Used by `copy_to_user`, `copy_from_user`, `get_user_pages`,
  `strncpy_from_user`, and exec's image load. It is the **single page-aware choke
  point** for all kernel↔user access (see forward-compat, Section 7).
  - Note: Wasm 3.0 multi-memory does **not** help here — the memory index is a
    static immediate, so the kernel can't dynamically select "current process
    memory." Host-mediated copy is the realistic mechanism.
- **The double-return seam** is the `capture_stack()` / `resume_stack(buf)`
  primitive musl's `fork()` calls. Asyncify backs it in Phase 2; stack-switching
  can replace it later with no change above the seam.
- **Two-repo contract:** the host-bridge ABI is the contract between `nix-wasm`
  (kernel/musl) and `pc` (runtime). Version it (echoing the exec-ABI-skew lesson).

## 5. Phase 1 — the substrate (per-process address spaces, no return-twice yet)

Delivers real inter-process memory protection over the *existing* clone-with-fn
spawn — no asyncify, no slow path. Shippable on its own; de-risks Phase 2.

### Runtime (pc JS)
- `linux.js` stops creating one shared `WebAssembly.Memory`. **Process creation
  allocates a fresh `Memory` + function table**; the user binary is instantiated
  against them at `__memory_base = 0` / `__table_base = 0`. Existing PIC `-shared`
  binaries relocate to offset 0 unchanged — **no toolchain churn required**.
- Threads (`CLONE_VM`) instantiate a new Worker **sharing the parent's
  `Memory`+table**. Rule: *one memory per address space; shared across that address
  space's threads.*
- A `pid/mm → {memory, table, workers}` registry so the kernel can name a target
  address space, and so teardown can free them on exit/reap.

### Kernel arch/wasm
- Model each user process's address space as a distinct wasm memory, not a region
  of the single shared one. The kernel keeps its own memory.
- **Replace direct user-memory addressing with host-bridge calls** for
  `copy_to_user`, `copy_from_user`, `get_user_pages`, `strncpy_from_user`, and
  exec's image load — all routed through the one page-aware choke point.
- exec loads the binary image into a **fresh** memory for the execing process.

### Substrate requirement: per-`mm` base-0 user allocator + memory-lifecycle ABI

The Phase 1 substrate requires more than a pid-keyed resolver: because musl's
mallocng allocates heap via `mmap()` (not `brk`), **all** user allocation — not
just exec regions — must come from the process's private memory. A window-translation
shortcut (mapping user offsets onto a region of the shared memory) is therefore
insufficient. The approved design (see the refined spec
`docs/superpowers/specs/2026-06-19-task2-perprocess-memory-design.md`) is:

1. **Per-`mm` base-0 bump/free allocator** in `mm_context_t`
   (`arch/wasm/include/asm/mmu.h`): fields `user_as_size`, `user_as_brk`,
   `user_as_free`, `user_as_live`. Layout: guard page at 0 (NULL traps), data+bss
   at `USER_AS_BASE=0x10000`, then stack/brk arena, then `mmap` bump upward.
   Code stays in the shared kernel image (wasm code is not linear-addressable).

2. **Four `wasm_user_mem_*` runtime imports** (`WASM_HOSTBRIDGE_ABI` → 2),
   declared in `arch/wasm/include/asm/wasm.h`:
   - `wasm_user_mem_create(pid, init_pages)` — mint a fresh per-pid
     `WebAssembly.Memory` on the **main thread** and transfer to the worker
     (browsers may not create `Memory` from a worker); called at exec after
     `setup_new_exec`, before data `vm_mmap`.
   - `wasm_user_mem_grow(pid, delta_pages)` — `memory.grow` on the per-pid
     memory when the allocator exhausts `user_as_size`; returns new page count
     or `-1`.
   - `wasm_user_mem_free(pid)` — drop the registry entry on `exit_mmap`; runtime
     tears down the memory/table/worker.
   - `wasm_user_memzero(pid, uaddr, n)` — anon-zero / BSS clear via the private
     memory (replaces `memset` on the shared pool).

3. **Registry model R1 (approved):** each user task's private `Memory` is owned
   by the **worker running it** (Linux uaccess only ever targets `current` via
   `wasm_current_pid()`); the resolver gains a shared-memory fallback for
   kthreads/pre-exec. `access_process_vm` / `access_remote_vm` (ptrace/`/proc`)
   are out of scope.

4. **Budget (approved):** small initial pages (cover data+stack+slack); generous
   max (grow-only; only committed pages cost). No hard per-process cap for now.

For the full treatment (gate sites, exec/grow/teardown sequencing, the inversion
rationale, and file:line citations) see the refined design doc. Task 2 in the
implementation plan is re-decomposed into T2.0–T2.5 to match.

### Acceptance for Phase 1 — ✅ MET (2026-06-20)
- ✅ Existing userspace boots and runs over per-process memories. Busybox boots to
  a shell (`task2.3`); the full NixOS userspace boots interactively (8-getty →
  autologin) and the end-to-end nix-system acceptance — 9P read / write / `ls` and
  `nix-env -iA sl` substituting `sl-5.05` from the binary cache — all pass over
  per-process memory (`runtime/node/smoke.mjs`, Phase A + Phase B).
- ✅ **Isolation probe (B1):** process B cannot read process A's memory — verified
  by `runtime/node/task2.4-isolation.test.mjs` (A reports a runtime absolute
  address; B reads its OWN private bytes there → ISOLATION PASS; would LEAK under a
  single shared Memory). Teardown/no-leak: `task2.4-teardown.test.mjs`.
- ✅ clone-with-fn spawn (`posix_spawn`/`vfork`+exec) still works (B2 regression
  guard): `runtime/node/task2.5-fastpath.test.mjs`.

Substrate fixes landed for Phase 1: per-`mm` base-0 allocator + host-bridge uaccess
(patches 0014–0017, 0020); netfs inline read collection (0018); a per-process
Memory `maximum` of 512 MiB (V8 reserves the full max as VA — `kernel-worker.js`);
and **forced buffered v9fs I/O on wasm** (patch 0022) — unbuffered/direct I/O pins
user pages (`iov_iter_extract_pages`), impossible across distinct per-process
`WebAssembly.Memory` objects, so 9P writes are routed through the bridged
`copy_from_user` instead.

## 6. Phase 2 — true `fork()` via the double-return seam

### The seam
musl's `fork()` calls two primitives — `capture_stack()` and `resume_stack(buf)` —
backed by asyncify now, replaceable by stack-switching later.

### fork() flow
1. User calls `fork()` → musl `fork()` invokes `capture_stack()` → asyncify unwinds
   the wasm call stack into a buffer **in the process's linear memory**, then issues
   the real Linux `clone`/`fork` syscall into the in-wasm kernel.
2. Kernel `copy_process` runs (real PID alloc, task struct, …), then asks the
   runtime to **duplicate the address space**: allocate child memory+table,
   **verbatim byte-copy** parent→child (the asyncify buffer rides along, being in
   linear memory). *(This "duplicate the memory" step is kept discrete so it can
   later become COW — see Section 7.)*
3. Runtime starts the child Worker on the child memory; both parent and child
   `resume_stack(buf)` (asyncify rewind) → both return from `fork()`, parent with
   the child pid, child with 0.
4. `waitpid` / exit-status / signals are handled by the **real kernel** (unchanged
   kernel semantics).

### Fast path (preserved)
`posix_spawn` / `vfork`+exec keep using clone-with-fn (child starts fresh at the
exec'd program — no stack capture). **Only true `fork()`-without-exec pays
asyncify**, which is what bounds the asyncify cost.

### Toolchain
- `guest-cc` / `guest-clang` gain an asyncify link step (Binaryen),
  **allow-listed to the fork-reachable call graph** to bound the size/perf tax.
- musl gains the real `fork()` plus the two seam primitives (`wasix-libc` as
  reference for the asyncify mechanics; the **Linux clone ABI** is the target, not
  the WASIX ABI).

## 7. Forward compatibility — the paging upgrade path

This spec deliberately omits demand paging / COW / `mmap`-MMU (fixed stacks
persist). It is, however, the **necessary first step** toward them, and two
constraints keep that future open with **no rework**:

1. **All kernel↔user access flows through the single page-aware host-bridge choke
   point** — never assume flat, always-present user memory. Under Phase 1/2 every
   page is always present so the check is trivial; demand paging later adds fault-in
   logic *there*, in one place. **(Primary lock-in risk if violated.)**
2. **"Duplicate the memory" stays a discrete, replaceable step in the fork flow** —
   so eager-copy → COW is a single-site swap.

Upgrade path: per-process **linear** memory (this spec) → per-process **virtual**
memory (future, via the wasm virtual-memory `memory.map`/`memory.protect` proposal
or WAVEN-style software instrumentation) yields **dynamic stacks + COW fork + file
`mmap`**, reusing this spec's process boundary, host-bridge, and fork seam. The
fixed stack and the eager copy are *relaxations* under paging, never things torn
out. The double-return seam is orthogonal to paging and unaffected.

## 8. Testing — acceptance suite

Acceptance = **imported upstream conformance subset + bespoke wasm-specific cases**,
run in the pc harness (same style as `exec-nixsystem.mjs` Phase A/B), each case
compiled in-guest by `guest-cc` and CI-runnable as a flake attr + harness script.

**Task 2 re-decomposition (Phase 1 substrate):** the original single "Task 2" in
the implementation plan has been replaced with six tasks T2.0–T2.5 (see the
refined design `docs/superpowers/specs/2026-06-19-task2-perprocess-memory-design.md`
§7 and the updated plan `docs/superpowers/plans/2026-06-18-mmu-fork-phase1.md`).
The old Task 2 Step 5 ("point driver buffer reads at the process memory") has been
**removed** — drivers (9p, hvc, random) read from **kernel** buffers allocated in
the shared pool (`get_user_pages` → kernel bounce buffer); the host-bridge is the
sole path that touches user-memory bytes. Pointing driver reads directly at a
per-process memory was wrong and has been deleted from the plan.

### Imported (backbone)
- **Open POSIX Test Suite** `conformance/interfaces/{fork,waitpid,exec}/`
  (in LTP) — one-assertion-per-file, portable standalone C; maps ~1:1 to the matrix
  below. An `emscripten-core/posixtestsuite` fork already runs POSIX conformance
  under wasm — proven porting path.
- **musl libc-test** process subset — it is *our* libc's own suite and uniquely
  covers the subtle parts (fork×pthread interactions, `fork()` async-signal-safety,
  threaded-uid/fork races) that map to risks below.
- **LTP `kernel/syscalls/{fork,clone,wait}`** (optional depth) — gold-standard
  `fork01..14`/`clone`/`waitpid`. Self-contained per-test, but depends on the
  `libltp` `tst_` framework (which itself forks); cherry-pick if more depth is
  wanted.

### Bespoke (no upstream suite covers these)
| # | Case | Asserts | Gates |
|---|------|---------|-------|
| B1 | Cross-process isolation probe | process B cannot read/corrupt A's address space | Phase 1 |
| B2 | clone-with-fn fast path | `fork`→`execve` / `posix_spawn` still works | Phase 1 |
| B3 | asyncify unwind/rewind boundary | capture/resume lands exactly at the libc `fork()` frame, not mid-syscall | Phase 2 |

### Imported-case mapping (Phase 2 gate)
| Case | Asserts |
|------|---------|
| `fork()` returns twice | parent sees child pid > 0, child sees 0 |
| private memory | child mutates a var; parent's copy unchanged after `waitpid` |
| `waitpid` / status | `WEXITSTATUS` matches child's `exit(n)` |
| fork-without-exec | child runs parent code to completion (exercises asyncify resume) |
| nested fork | child forks grandchild; pids distinct; both reaps succeed |
| fork in threaded process | live-pthread process forks; child single-threaded with copied memory; no deadlock |

### Caveat
"Pull in" means a **cherry-picked subset that compiles under `guest-cc`/musl** —
tests needing `ptrace`, full `/proc`, unsupported signals, or fork-bomb stress will
not run. The framework dependency (`libltp` / POSIX helper macros) is the
integration cost.

## 9. Risks & open questions

- **Asyncify cost (known).** Size/perf tax on fork-capable binaries (WASIX moved
  setjmp/longjmp *off* asyncify to wasm-EH for speed; we already build with
  `-fwasm-exceptions`, but fork's *stack capture* still needs asyncify).
  *Mitigation:* clone-with-fn fast path + allow-listed asyncify. *Open:* measure the
  tax on a real fork-without-exec binary; set allow-list scope empirically.
- **Threaded fork semantics (hardest case).** POSIX `fork()` in a multithreaded
  process keeps only the calling thread; locks held by other threads are frozen in
  the child. *Open:* confirm `copy_process` + runtime correctly drop the other
  threads' Workers and that the child's copied memory is consistent.
- **Stack capture across the syscall boundary.** Asyncify must unwind *through*
  musl's syscall wrapper cleanly. *Open:* validate the boundary is exactly the
  `fork()` libc frame (test B3).
- **Worker/Memory lifecycle & teardown.** Per-process Memory+table+Worker must be
  freed on exit/reap without leaks; `pid → memory` registry consistency under rapid
  fork/exit. *Open:* define teardown ordering in the runtime.
- **Two-repo coordination.** Host-bridge ABI is the contract; version it to avoid
  the exec-ABI-skew failure mode seen previously.
- **`get_user_pages` callers.** Audit all callers (9p was the known one) and confirm
  each routes through the host-bridge under per-process memory.

**New open items from the refined per-process-memory design (Task 2):**

- **Cross-pid copies / R1 assumption.** R1 (worker-owned per-pid memory) assumes no
  in-scope synchronous cross-pid user copy. `access_process_vm`/`access_remote_vm`
  are ptrace/`/proc` — currently out of scope. If a future kernel path issues a
  cross-mm user copy, R1 must be revisited. Audit holds for current scope.
- **Worker-vs-main minting.** `wasm_user_mem_create` mints `Memory` on the main
  thread and transfers to the requesting worker (browsers may not create `Memory`
  from a worker). Confirm this capability on all target browser engines before T2.1.
- **File-backed data `mmap` audit.** Assumed absent (mallocng is anon; the only
  file-backed `vm_mmap` is the code image, which stays shared). Verify in T2.2 that
  no data-file path reaches `do_mmap_private` with a private target; add a kernel
  bounce buffer if found.
- **Guard-page-at-0.** Layout assumes `data_start=0x10000` (`USER_AS_BASE`) is
  tolerated by dylink relocation. It uses a large nonzero base today — verify
  `__memory_base` / data-segment offsets are consistent in T2.3.
- **`strnlen_user` prerequisite.** `strnlen_user` still reads the user pointer
  directly (deferred in patch 0014); this becomes a hard crash the instant memory
  splits. T2.0 must close this before any private-memory work proceeds.
- **Teardown ordering.** `exit_mmap` frees the registry entry; `release_task` kills
  the worker. The resolver's shared-memory fallback covers benign races, but
  use-after-free is possible if a bridge call races the worker kill. Validate in T2.4.

## 10. Out of scope / future specs

- Per-page virtual memory (demand paging, COW fork, `mmap`-of-files) — the Section 7
  upgrade.
- Switching user binaries from `-shared` PIC dylink to the standard base-0 wasm
  executable model (a real simplification enabled by per-process memory, but pure
  cleanup — deferred to avoid `guest-cc`/`guest-clang` churn in this spec).
- Swapping asyncify for JSPI / core stack-switching behind the seam, once a wasm
  engine can clone a stack into two instances.

## References

- WASIX `proc_fork` (technique/prior art): https://wasix.org/docs/api-reference/wasix/proc_fork ,
  https://wasmer.io/posts/announcing-wasix , https://wasmer.io/posts/introducing-the-wasmer-js-sdk
- Wasmer 6.0 (asyncify → wasm-EH cost signal): https://wasmer.io/posts/announcing-wasmer-6-closer-to-native-speeds
- Open POSIX Test Suite: https://github.com/linux-test-project/ltp/tree/master/testcases/open_posix_testsuite ,
  https://github.com/emscripten-core/posixtestsuite
- musl libc-test: https://wiki.musl-libc.org/libc-test
- Wasm virtual-memory proposal (future paging): https://github.com/WebAssembly/memory-control/blob/main/proposals/memory-control/virtual.md
- WAVEN software MMU (future paging reference): https://www.ndss-symposium.org/wp-content/uploads/2025-746-paper.pdf
- Repo memory: `fork-vfork-nommu-strategy`, `wasm-feature-set-mismatch`, `guest-compile-startup-sigill`
