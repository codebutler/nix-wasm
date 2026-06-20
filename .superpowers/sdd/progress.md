# SDD Ledger — Phase 2: True `fork()` via the double-return seam

**Worktree:** `/home/vbvntv/Code/nix-wasm-worktrees/phase2-fork` · branch `phase2-fork` (off `mmu-fork` @ `2848edc` = Phase 1 + current Wayland)
**Spec:** `docs/superpowers/specs/2026-06-18-mmu-fork-design.md` §6 (Phase 2)
**Plan:** `docs/superpowers/plans/2026-06-19-mmu-fork-phase2.md`

## Status

| Task | Title | Status |
|------|-------|--------|
| Plan | Grounded Phase-2 implementation plan (4-layer research → tasks) | ✅ written |
| T0 | Asyncify double-return SPIKE (de-risk B3) | ✅ **DONE — B3 resolved** |
| T1a | **Host-side** asyncify build path for fork binaries | ✅ **DONE** |
| ABI | Lock fork host ABI v3 (the "fix ABI first" gate) | ✅ **DONE 2026-06-20** |
| T4a | Runtime asyncify module + ABI v3 dup op (isolated) | ✅ **DONE** (`e09f592`) |
| T2 | musl real fork() over the seam | ✅ **musl-fork BUILDS + links** (`ff421de`) |
| T3 | Kernel fork-dup hook (non-CLONE_VM user clone) | ✅ **DONE** (mm-dup + pid + cpuflags) |
| T4b | Worker fork integration (verbatim dup + dual rewind) | ✅ **DONE** |
| T5 | Acceptance: fork() returns twice + private mem + waitpid | ✅ **PASS end-to-end** (`d3da184`) |
| T5b | Broaden acceptance: nested, loop, fork-in-thread | ✅ **all 4 cases PASS** |
| T1b | In-guest asyncify (cross-build binaryen→wasm32) — capstone | ✅ **DONE — cc-fork works in-guest** |
| mm  | File-backed mmap bounce + write-back for private AS (patch 0025) | ✅ **DONE — unblocks in-guest linking** |

## T1b (2026-06-20) — infra DONE, in-guest run blocked by a Phase-1 mmap limit

Built `toolchain/guest-binaryen.nix` (Binaryen 129 cross-compiled to wasm32-nommu →
`.#guest-binaryen`, a valid 10.5 MB dylink wasm-opt; static libbinaryen folded in,
DWARF kept for the Outlining suffix-tree headers) and `toolchain/guest-cc-fork.nix`
(`.#guest-cc-fork` → `/bin/cc-fork`: clang → wasm-ld+musl-fork seam → in-guest
wasm-opt --asyncify addlist). Both added to the served /nix closure; canonical
guest-cc untouched. `runtime/node/phase2-in-guest-fork.mjs` is the boot+compile+run
harness.

**BLOCKED — not by anything fork-specific.** In-guest `wasm-ld` (lld) writes its
output via a MAP_SHARED FILE-BACKED mmap; the Phase-1 per-process-AS allocator
rejects file-backed mmap (patch 0017: `WARN_ON_ONCE(vma->vm_file) → -ENOSYS`,
"bounce path is dead code in scope, unbuilt"). Result: every in-guest link yields a
file of the right SIZE (ftruncate) but ZEROED content (the mmap'd writes never sync
back) — wasm-opt then reads it as non-binary ("unrecognized module field"). Proven
GENERAL: the canonical `cc /tmp/h.c -o /tmp/h` ALSO yields a zeroed `/tmp/h` (first4
= 00 00 00 00, won't run). So in-guest LINKING is broken under per-process memory
for any tool, fork or not.

**RESOLVED (2026-06-20) — patch 0025 + cc-fork pass in-guest.** `kernel/0025`
routes every file-backed mmap from a private-AS process through `do_mmap_wasm_file`:
allocate a private offset, BOUNCE the file content in (wasm_file_bounce_in:
kmalloc page buffer + kernel_read + wasm_user_copy_to), and for a writable
MAP_SHARED mapping flush it back on teardown (wasm_file_bounce_out from
delete_vma, capped at i_size so the page-padding tail doesn't corrupt the output).
The global-tree share scan is skipped for private-AS processes. cc-fork adds
chmod +x on the wasm-opt output. `runtime/node/phase2-in-guest-fork.mjs` PASSES:
`cc-fork /tmp/fork.c -o /tmp/fork && /tmp/fork` compiles a fork() program ENTIRELY
in-guest (clang → wasm-ld+musl-fork → in-guest wasm-opt --asyncify) and it returns
twice (child 0x20c / parent 0x2a0, child exit 9). The 4-case host fork acceptance
still passes with the 0025 kernel (no boot/anon-mmap regression). Three iterations:
zeroed output → write-back works but tail-padding corruption (cap at i_size) →
output not +x (chmod). General win: in-guest LINKING now works for any tool.

## T5b DONE (2026-06-20) — full fork() acceptance matrix passes

`runtime/node/phase2-acceptance.mjs` boots once and runs FOUR programs, all PASS:
returns-twice + private-mem + waitpid (fork-returns-twice), **nested fork**
(fork-nested: a child forks a grandchild — fork re-entrancy from a child worker),
**multi-fork-in-loop** (fork-loop: 3 forks before any reap), and **fork-in-thread**
(fork-in-thread: a live pthread present at fork → child is single-threaded with the
pthread's copied memory). Two cross-worker bugs fixed to get nested/loop green:
- lazy fork-child snapshots routed via the HOST MAIN thread (a child can schedule
  the NEXT child from a different worker than the one that forked);
- `wasm_user_mem_dup` takes the SIZE not the parent pid (the mint runs in
  __switch_to, possibly in a worker without the parent's Memory entry).
Commit `149a1ac` (nested/loop) + the fork-in-thread case.

## 🎉 PHASE 2 CORE DONE (2026-06-20) — real fork() works end-to-end

`node runtime/node/phase2-acceptance.mjs` PASSES: `/bin/fork-returns-twice` forks
in the booted guest, BOTH sides return at the call site (child 0 / parent child-pid
43), private verbatim-copied address spaces (witness 0x10c vs 0x1b0), waitpid reaps
the child (WEXITSTATUS 7), program exits 0. The asyncify double-return seam + kernel
mm-dup + host orchestration all work together. Commit `d3da184`.

**Three bugs found + fixed during end-to-end bring-up (all in `d3da184`):**
1. **asyncify ADDLIST not onlylist.** The PIC `-shared` dylink call to the
   capture_stack import isn't found by asyncify reachability ⇒ `onlylist` (reachable
   ∩ list) instruments nothing ⇒ no unwind. `addlist` (reachable ∪ list)
   force-instruments `_start,_start_c,__libc_start_main,__main_void,main,fork,_Fork`.
   Also +x the wasm-opt output (guest binfmt needs the exec bit).
2. **child pid timing.** `task_pid_nr(p)` in `copy_thread` returns the PARENT pid
   (the child's pid isn't allocated until after copy_thread) ⇒ the owner pid +
   Memory mint move to the child's first `__switch_to` (`wasm_user_as_fork_finish`).
3. **stale kernel-mode cpuflags.** `wasm_fork_current` is host-driven (bypasses
   syscall entry), so the fork child inherits non-user cpuflags ⇒ "Syscall called
   when in kernel mode" panic on its first syscall. Force `CPUFLAGS_USER_TASK_DEFAULT`
   on the fork child in copy_thread.
Plus: stage the fork-time snapshot BEFORE driving the clone (the child's
create_and_run_task can fire synchronously inside wasm_fork_current).

**Remaining Phase-2 work:** broaden T5 (nested fork, fork-in-thread, the POSIX
subset — currently one returns-twice/private-mem/waitpid case proven), and **T1b**
(in-guest binaryen — interactive in-guest fork compilation, the capstone).

## ABI v3 LOCKED (2026-06-20) — `docs/superpowers/specs/2026-06-20-fork-host-abi-v3.md`

The authoritative host↔kernel↔musl contract is fixed before any layer patch:
- **T2 = option A** (separate `musl-fork` variant; canonical `.#musl` unchanged).
- Fork does **not** issue `SYS_clone` from the user; `capture_stack(ctl_ptr)` is the
  sole asyncify unwind import; the **host drives** the kernel clone post-unwind.
- New ABI v3 surface: `wasm_user_mem_dup(parent,child)` (kernel→host, mint child
  Memory only — copy deferred to the child worker per finding A), `wasm_fork_current()`
  (host→kernel, runs `kernel_clone(SIGCHLD)`), and a `fork_parent_pid` param on
  `wasm_create_and_run_task`. `WASM_HOSTBRIDGE_ABI` 2→3 in BOTH wasm.h and hostbridge.js.
- NOMMU reality: `dup_mmap` is a no-op (no MMU) ⇒ patch 0024 genuinely duplicates the
  child mm (allocator state + VMA/regions) — the real novel kernel work.
- Full run-loop sequence + ordering invariants in §5 of the doc.

## T0 spike result (2026-06-20) — B3 RESOLVED POSITIVELY

`spikes/asyncify-fork/` — two harnesses pass via `./build.sh`: WAT probe (`run.mjs`)
and clang `-O2` probe (`run-cc.mjs`, nested frame + shadow stack + live locals).
Proven: single `do_fork()` returns twice (parent token / child 0); resume lands at
the call site (pre-fork marker fires once, two frames deep); isolated memories
(543 vs 501); live C local + shadow stack survive unwind→copy→rewind.

**Three findings folded into the plan:**
- **A (locks T4 ordering):** copy parent→child memory AFTER child-instance creation
  — a fresh `Instance` re-applies active data segments, clobbering copied `.bss`.
- **B (resolves T2 seam):** unwind via a **dedicated `capture_stack()` import**, not
  the generic `__wasm_syscall_N` — syscall fast path stays asyncify-free; B3's
  "unwind through the syscall wrapper" worry sidestepped. `fork()` doesn't issue
  `SYS_clone`; it commits state, calls `capture_stack()`, host drives clone+dup+rewind.
- **C (test-design):** materialize pre-fork state in memory before capture (`-O2`
  folds a pre-fork store past the fork point).

Asyncify control surface confirmed: `asyncify_{start,stop}_{unwind,rewind}` +
`asyncify_get_state`; data struct `{i32 cur, i32 end}` scratch in linear memory.
Size tax +625 B is fixed scaffolding on a trivial probe (real measure → T1/T2).

## T1 scope correction (2026-06-20)

`guest-cc` is the **in-guest** driver (runs inside the guest over wasm-built
clang/wasm-ld) — there is **no in-guest `wasm-opt`**, so the asyncify pass can't
live there. Asyncify must instrument the user's own fork-reachable frames. Per the
caching design goal (host builds, guest substitutes), T1 builds fork-capable
programs **host-side** (`cross.stdenv.cc` + host `pkgs.binaryen`) via a new
`userspace/asyncify-cc.nix` helper; the acceptance suite (T5) consumes it.
**Deferred follow-up:** in-guest asyncify (cross-build binaryen→wasm32 for
interactive in-guest fork compilation) — does NOT block fork() for host-built
programs. Canonical `.#guest-cc`/`.#musl` hashes stay unchanged.

## T1a result (2026-06-20) — DONE

`userspace/asyncify-cc.nix` (reusable builder: `cross.stdenv.cc` +
`-Wl,--import-undefined` + host `wasm-opt --asyncify
--pass-arg=asyncify-imports@env.capture_stack [--pass-arg=asyncify-onlylist@…]`),
`userspace/fork-smoke.c`, flake `.#asyncify-cc-smoke`, test
`runtime/node/asyncify-link.test.mjs` (PASS). Output is a real musl `-shared`
dylink module: imports `env.capture_stack` (sole unwind point), exports the
asyncify control surface, and the `__wasm_syscall_N` imports are NOT async points
(finding B confirmed end-to-end). `.#guest-cc` hash unchanged (`5p51rj6k…`).
Size with `onlylist=main`: 5921 B. Reused by T2/T5 to build fork binaries.

## T2 design boundary (2026-06-20) — needs a decision before patch 0008

Read musl `_Fork.c` (1.2.5) + patch 0007. Current `_Fork`:
`ret = __syscall(SYS_clone, SIGCHLD, 0,0,0,0); __post_Fork(ret)`. With Task-0
finding B, the Phase-2 seam replaces that `SYS_clone` with a **dedicated
`__wasm_fork(asyncify_buf)` host import** (the host uses it to unwind the user
instance, drive the kernel clone, dup memory, and rewind both → returns pid/0).
musl provides the asyncify scratch buffer (in linear memory, copied to child);
asyncify orchestration is host-side (as in the spike), so musl stays thin.

**System-wide implication:** `_Fork` is reached by **`nix.wasm`'s in-guest
builder** (patch 0007 comment). Changing `_Fork` *unconditionally* means every
fork-calling binary (incl. `nix.wasm`, busybox if it ever forks) must be
asyncified or its fork breaks — and forces a large rebuild. Options:
- **(A) separate `musl-fork` variant** — asyncify-cc links musl-fork; canonical
  `.#musl` unchanged so `nix.wasm`/busybox/in-guest-nix keep the current clone
  path. Clean isolation; two musl builds. **(recommended)**
- **(B) runtime-detected fallback** — one `_Fork` that uses the seam when the host
  provides `__wasm_fork`, else the clone path. One musl, but optional-import
  detection in wasm is fragile (absent import traps).
The host ABI (`__wasm_fork` signature + asyncify-buffer protocol) is shared across
T2/T3/T4 — fix it first (like Phase-1's WASM_HOSTBRIDGE_ABI), then implement the
three layers against it. **Next: settle A-vs-B, write the T2–T4 ABI, then patch 0008.**

## T4a DONE (2026-06-20) — runtime asyncify module + ABI v3 dup op

`runtime/asyncify.js` (ASYNCIFY_STATE, makeCaptureStack, isPendingUnwind,
stopUnwind, startRewind, dupAddressSpace) extracted from the spike; the spike's
`run-cc.mjs` now CONSUMES it (re-proves the helpers against real clang -O2).
`hostbridge.js` ABI 2→3 + `wasm_user_mem_dup(parent,child)` (mint-only). Tests:
`node/asyncify.test.mjs` + a dup case in `hostbridge.test.mjs` (both green); T2.1
`===2` pin relaxed to `>=2`. All four runtime gates pass on the changed files (the
boot.js/virtio RED gates are pre-existing Wayland WIP). Commit `e09f592`.

## DEEP DESIGN for T3 / T2 / T4b (2026-06-20) — grounded in the real source

Read end-to-end: `runtime/{kernel-worker,kernel-host,hostbridge}.js`, kernel
`arch/wasm/kernel/process.c`, `kernel/fork.c` (dup_mm/copy_mm), `mm/nommu.c`
dup_mmap, and patches 0017 (per-mm allocator) + 0018 (CLONE_VM owner pid).

**Runtime model (confirmed):** each task = its OWN worker with its OWN vmlinux
instance over the SHARED kernel Memory (SMP-style). User memory is per-pid private
(`userMems` worker-local). `user_executable_run` (kernel-worker.js:1133) calls
`_start()` / `__libc_clone_callback()` which "never return" — an asyncify unwind
makes `_start()` RETURN, so the pending-fork check slots in right there. The
CLONE_VM path forwards the parent Memory to the child worker via the `clone_vm:
{owner_pid, memory}` option (make_task / make_vmlinux_runner) — **fork reuses this
exact cross-worker Memory-forwarding channel**.

**Kernel NOMMU reality (confirmed):** `dup_mm` does `memcpy(mm, oldmm)` then a
no-op NOMMU `dup_mmap` (copies NO VMAs). So a fork child inherits the parent's
`mm.context` allocator scalars (user_as_size/brk/live) BUT with two real bugs:
(1) `user_as_free` list_head memcpy-ALIASES the parent's extents — draining it at
the child's exit_mmap would kfree the parent's nodes (corruption/double-free);
(2) `user_as_owner_pid` = PARENT pid — the child's uaccess would target the
PARENT's Memory. **VMA/region duplication is NOT required for correctness**: the
bytes are copied verbatim by the runtime, the allocator scalars carry over so NEW
mappings don't collide, and musl mallocng doesn't munmap inherited arenas before
exec/exit (exit_mmap tolerates an empty VMA list). Treat full VMA-dup as a
forward-compat refinement (like COW), documented, not a stub.

### T3 — patch 0024 (author against the CUMULATIVE tree 0001-0023; 0021/0022
revise nommu region handling, so context MUST come from a scratch `git apply`
of 0001-0023, not the pristine source):
- `arch/wasm/include/asm/wasm.h`: `#define WASM_HOSTBRIDGE_ABI 3`; declare
  `extern long wasm_user_mem_dup(int parent_pid, int child_pid);`; add an
  `int fork_parent_pid` trailing param to the `wasm_create_and_run_task` decl.
- `arch/wasm/include/asm/mmu.h`: add `int user_as_fork_parent;` to mm_context_t
  (set in copy_thread for a fork child, read in __switch_to to pass fork_parent_pid).
- `arch/wasm/mm/user_as.c`: new `wasm_user_as_fork_dup(child_mm, parent_mm,
  child_pid)` — INIT_LIST_HEAD the child free-list then deep-copy parent extents
  (kmalloc each), set `child.user_as_owner_pid = child_pid`, keep size/brk/live,
  call `wasm_user_mem_dup(parent.user_as_owner_pid, child_pid)`. Declared in user_as.h.
- `arch/wasm/kernel/process.c` `copy_thread`: after the user-thread setup, if
  `!(args->flags & CLONE_VM)` && `wasm_user_as_active(current->mm)` && `p->mm !=
  current->mm`, call wasm_user_as_fork_dup + set `p->mm->context.user_as_fork_parent
  = task_pid_nr(current)`. `__switch_to`: in the _TIF_NEVER_RUN block, read
  `next_task->mm->context.user_as_fork_parent` and pass as fork_parent_pid (0 else).
- NEW global C fn `int wasm_fork_current(void)` (auto-exported by --export-all;
  no entry.S trampoline needed) calling `kernel_clone(&(struct kernel_clone_args){
  .exit_signal = SIGCHLD })`, returns child pid. **OPEN RISK (validate in T4b/T5):**
  the cooperative wasm scheduler — does kernel_clone drive the child's first
  __switch_to (→ wasm_create_and_run_task → child worker spawn) without an explicit
  syscall-exit schedule()? wasm_fork_current is NOT a syscall, so it may need an
  explicit `schedule()` / to mirror the wasm_syscall_N trampoline's exit path.
  This is THE thing to nail with runtime iteration; the patch primitive is right,
  the scheduling drive is the unknown.
  **RESOLVED (2026-06-20) — explicit fork-time snapshot decouples timing:** the
  child's worker spawns LAZILY via the normal wasm_create_and_run_task path (keeps
  the kernel↔worker binding correct — eager host-spawn would break it). The
  snapshot-vs-rewind race (parent must not mutate before the child copies) is
  solved by taking a TRANSFERABLE byte snapshot of the parent's memory on worker P
  right after stopUnwind (fork-time image), shipping it to host main
  (`pendingForks: Map<child_pid,{snapshot,ctlPtr}>`), and applying it in the child
  worker AFTER instantiation (finding A). The parent then rewinds IMMEDIATELY — no
  blocking, no synchronous-child-spawn requirement, so `wasm_fork_current` just
  does kernel_clone + returns child_pid (no special schedule() drive needed). The
  child runs lazily; waitpid blocks the parent → schedule → child runs → reaps.
  Child memory (minted by wasm_user_mem_dup in worker P's userMems) is forwarded by
  the child's wasm_create_and_run_task via the existing clone_vm channel (relies on
  the child's first __switch_to firing in worker P — holds in the single-CPU
  cooperative model). Snapshot keyed by mm_owner_pid (= child_pid for the fork child).
- `kernel.nix`: add 0024 to the list.
- **DONE 2026-06-20:** patch 0024 authored against the cumulative 0001-0023 scratch
  tree; `nix build .#kernel` SUCCEEDS (`a1i7cn4v…`). Verified the built vmlinux.wasm
  EXPORTS `wasm_fork_current` and IMPORTS `wasm_user_mem_dup` (ABI surface wired,
  --export-all picks up the new export), `ret_from_fork` still exported. Commit
  `31b2e57`. Behavioral test (dup fires once per fork, no regression) → T5.

### T2 — patch 0008 (musl-fork variant, option A):
`src/process/_Fork.c`: replace `__syscall(SYS_clone, SIGCHLD,0,0,0,0)` with
`capture_stack((int)(uintptr_t)&__asyncify_ctl)` after initialising a static
`{u32 cur,end}` ctl + a 16 KiB static stack region (cur=base,end=base+16K). Keep
`__post_Fork(ret)`, sig-block/restore. `capture_stack` declared extern (host
import). posix_spawn/vfork clone-with-fn UNTOUCHED. `toolchain/musl.nix`: a
`musl-fork` variant adding 0008; canonical `.#musl` unchanged; `asyncify-cc.nix`
links musl-fork. Build `.#musl-fork`.

### T4b — runtime worker fork loop (kernel-worker.js / kernel-host.js):
`user_executable_run` becomes a LOOP: call entry (`_start`/`clone_callback`);
if `isPendingUnwind(instance)` → stopUnwind, `child_pid =
vmlinux.exports.wasm_fork_current()`, then post a fork `create_and_run_task`
carrying `fork: {parent_pid, parent_memory, child_memory, ctl_ptr}` (look up
both Memories in the parent worker's `userMems`), set forkResult=child_pid,
startRewind(instance, ctlPtr), re-enter entry → fork returns child_pid; loop
(nested/looping forks). `make_task`/`make_vmlinux_runner`: thread the `fork`
option to the child worker; child instantiates user module against child_memory,
THEN `dupAddressSpace(parent_memory, child_memory)` (finding A), then
startRewind(ctl_ptr)+entry → fork returns 0. capture_stack wired into
`user_executable_imports.env` via makeCaptureStack. The fast path
(should_call_clone_callback, no asyncify exports) is untouched (B2 guard stays green).

## Stability pass (2026-06-20) — hardening + broadened testing

After the capstone, a stability review flagged gaps; addressed:
- **Addlist limitation RESOLVED.** The hardcoded asyncify addlist was a false
  constraint — reachability from the directly-called capture_stack import already
  instruments the whole transitive graph. `fork-helper.c` (fork 3 frames deep)
  passes with NO list. Dropped the addlist from every fork program + cc-fork;
  fork() now works at any call depth (`708daf2`).
- **Stress + teardown/leak PASS.** `fork-stress.c` (50 fork/exit/reap) + a
  worker-count probe: peak +2 (not +50 → no per-fork worker leak), resting back to
  baseline, no scheduler wedge, all exit codes correct (`c235130`).
- **fork+exec + fork-pipe PASS.** exec-after-fork (child loads a fresh image) and
  fd-inheritance/pipe IPC across the two workers (`7024074`).
- **Regression: NO drift.** Against the fork-patched kernel (0024+0025): flag-OFF
  (old shared NOMMU model) still boots; B2 clone-with-fn fast path green; B1
  isolation + dark-mode + teardown all pass.
- Host acceptance is now 7 cases (returns-twice, private-mem, waitpid, nested,
  loop, in-thread, helper-depth, exec, pipe) + the stress + the in-guest cc-fork.
- **No-fork hacks audit:** the clone-with-fn spawn patches are the deliberately
  preserved fast path (not removable); the musl clone-arity patches are still
  needed for canonical musl; the only genuine candidate is migrating the forkshell
  ash onto the asyncify seam — a future project, not a cleanup. Real fork() is
  additive/opt-in (asyncify seam); the core userspace stays on clone-with-fn.
- CI wiring of the harnesses → deferred to issue #22 (per user).

## Grounding research (pre-plan, 2026-06-19)

Four read-only research passes captured the real tree before decomposition:
- **musl:** 1.2.5, patches `patches/musl/0000-0007`; `fork()`→`_Fork()`→`__syscall(SYS_clone,SIGCHLD,0,0,0,0)` (5-arg arity, patch 0007); syscalls are typed `__wasm_syscall_N` **host imports**; no asyncify anywhere yet.
- **toolchain:** `guest-cc`/`guest-cxx` link via `wasm-ld` then could post-link `wasm-opt --asyncify`; `pkgs.binaryen` available at pin `9ae611a`; asyncify must be opt-in (canonical hashes unchanged).
- **runtime:** user & kernel are **separate wasm instances**; user syscalls bounce through the JS run-loop into the kernel instance ⇒ the double-return is orchestrated at the host run-loop. `userMems` (pid→{memory,table}), `mintUserMem`, CLONE_VM share-path (init `clone_vm`), `wasm_create_and_run_task`/`ret_from_fork`.
- **kernel:** 23 patches (`0001-0023`); Phase-1 per-mm allocator (0017), CLONE_VM owner-pid (0018); generic `kernel_clone→copy_process`; arch/wasm `copy_thread`/`__switch_to`→`wasm_create_and_run_task`; non-CLONE_VM fork currently has no dedicated dup path — the Task-3 hook adds it.

**Key design consequence:** B3 (asyncify unwind through the syscall wrapper) is the highest-uncertainty item ⇒ **Task 0 is a standalone spike** proving return-twice + memory-dup at the host run-loop before any musl/kernel commitment. Tasks 2–4 are explicitly provisional pending the spike.

## Decisions

- No "fork without double-return" shortcut (would fail fork-without-exec acceptance; violates PRIME DIRECTIVE). The runtime-research agent's "Phase 2a no-asyncify" suggestion was **rejected** on those grounds.
- Asyncify opt-in / off by default; `WASM_HOSTBRIDGE_ABI` 2→3 on the fork ABI; clone-with-fn fast path preserved (no asyncify), Phase-1 B2 guard kept green throughout.
