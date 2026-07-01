# Phase-2 fork() host ABI — `WASM_HOSTBRIDGE_ABI = 3`

**Status:** authoritative contract. Fixed BEFORE any musl/kernel/runtime patch
(the ledger's "fix the host ABI first" gate). Derived from the Task-0 spike
(`spikes/asyncify-fork/`, findings A/B/C) + the grounding reads of the real
runtime/kernel/musl seams. Supersedes nothing; extends ABI v2 (per-process
`WebAssembly.Memory`) additively.

This document is the single source of truth the three layers implement against:
- **musl** (`patches/musl/0008`, Task 2) — calls `capture_stack`, owns the buffer.
- **kernel** (`patches/kernel/0024`, Task 3) — drives the clone, dups the mm.
- **runtime** (`runtime/{asyncify,hostbridge,kernel-worker,kernel-host}.js`,
  Task 4) — orchestrates the double-return at the host run-loop.

---

## 0. Decisions locked here

- **T2 = option A (separate `musl-fork` variant).** Canonical `.#musl` stays
  byte-identical; `asyncify-cc` links `musl-fork`. `nix.wasm` / busybox / in-guest
  nix keep the current clone path (their `_Fork` is unchanged). Rejected option B
  (runtime-detected optional import) — absent-import traps make it fragile.
- **Fork does NOT issue `SYS_clone` from the user** (finding B). The user's
  generic `__wasm_syscall_N` path stays asyncify-free (fast path sacred). The
  **host drives** the kernel clone after catching the unwind.
- **`capture_stack` is the sole asyncify unwind import.**
  `--pass-arg=asyncify-imports@env.capture_stack` bounds instrumentation to the
  fork call graph; nothing else in the user module can unwind.
- **Eager verbatim byte-copy** of the parent address space into the child
  (forward-compat rule 2: this is the single replaceable site for a future COW).

---

## 1. The asyncify buffer protocol (user linear memory)

The asyncified user module (musl + `wasm-opt --asyncify`) exports the asyncify
control surface and owns a scratch region in **its own linear memory**:

| Symbol | Kind | Meaning |
|--------|------|---------|
| `asyncify_start_unwind(ptr)` | export | begin unwinding into buffer at `ptr` |
| `asyncify_stop_unwind()` | export | finish unwind (state → NORMAL) |
| `asyncify_start_rewind(ptr)` | export | begin rewinding from buffer at `ptr` |
| `asyncify_stop_rewind()` | export | finish rewind (state → NORMAL) |
| `asyncify_get_state()` | export | 0=NORMAL, 1=UNWINDING, 2=REWINDING |

**Buffer layout** at `ptr` (musl owns + sizes it; a static reservation in libc):
```
struct __asyncify_ctl { uint32_t cur;  /* in:  stack-image write/read cursor */
                        uint32_t end; } /* in:  one-past-end of the stack region */
followed (separately) by a stack-image region [STACK_BASE, STACK_END).
```
musl sets `cur = STACK_BASE`, `end = STACK_END` immediately before the first
`capture_stack` call. The region must be large enough for the deepest fork()
call-graph frame set; **16 KiB** is the reserved size (spike's trivial probe used
<1 KiB through a nested frame + shadow stack; 16 KiB is generous headroom and one
buddy order). The region lives in BSS, so it rides along in the verbatim memory
copy to the child — the child rewinds the identical image.

The **same `ptr` value is valid in the child** because the child's memory is a
verbatim copy at identical addresses (base-0 per-process AS). The runtime learns
`ptr` from the `capture_stack(ptr)` call argument and reuses it for both rewinds.

---

## 2. `capture_stack` — user → host import (the unwind point)

Declared by musl-fork, provided by the runtime worker that hosts the user
instance. **Signature:** `int capture_stack(int ctl_ptr)`.

State machine (the host worker implements this; mirrors the spike's `do_fork`):

- **NORMAL** (the fork() call): stash `ctl_ptr` for this worker; call
  `user.asyncify_start_unwind(ctl_ptr)`; return 0 (value ignored — the unwind
  discards it). The user instance now unwinds out of `fork()` → `_start()`,
  returning control to `user_executable_run` with state == UNWINDING.
- **REWINDING** (re-entry during a rewind): call `user.asyncify_stop_rewind()`;
  **return the fork result** the orchestrator set for this side — child pid in the
  parent worker, `0` in the child worker. This is the second of the double return.

`capture_stack` is the ONLY function the asyncify pass treats as an unwinding
import, so only `fork()`'s callers get instrumented.

---

## 3. Kernel ↔ host imports/exports (ABI v3 additions)

`#define WASM_HOSTBRIDGE_ABI 3` in `arch/wasm/include/asm/wasm.h` **and**
`export const WASM_HOSTBRIDGE_ABI = 3` in `runtime/hostbridge.js` (must match).

### 3a. `wasm_user_mem_dup` — kernel → host import (ABI v3)
```c
extern long wasm_user_mem_dup(int parent_pid, int child_pid);
```
Mint a fresh private base-0 `WebAssembly.Memory` for `child_pid`, **same `initial`
page count as `parent_pid`'s memory** (so the child instance can instantiate and
the subsequent verbatim copy fits), register it under `child_pid`. Returns 0 / <0.
**Does NOT copy bytes** — the verbatim copy happens later, in the child worker,
AFTER the child instance is created (finding A: a fresh `Instance` re-applies
active data segments and would clobber a pre-copied `.bss`/`.data`). This import
exists so the child's registry entry + Memory object are minted in the same worker
that drives the clone (worker P), to be forwarded to the child worker.

### 3b. `wasm_fork_current` — host → kernel export (ABI v3)
```c
int wasm_fork_current(void);   /* runs in the FORKING task's worker */
```
The runtime calls this on the forking worker's vmlinux instance AFTER the parent
user instance has unwound (state stopped). It runs
`kernel_clone({.flags=SIGCHLD, ...})` for `current` (the forking task), allocating
the child `task_struct` / pid / `mm`. Returns the child pid (or `-errno`).
copy_thread (patch 0024) sets up the child `mm` as a real duplicate (§4) and
arranges the child's `wasm_create_and_run_task` to carry the fork indicator.

### 3c. `wasm_create_and_run_task` gains a fork indicator (ABI v3)
The existing call (patch 0018 added `mm_owner_pid`) gains a parameter
distinguishing a fork child from a fresh exec / CLONE_VM child:
```c
extern struct task_struct *wasm_create_and_run_task(
    struct task_struct *prev_task, struct task_struct *new_task,
    const char *name, unsigned long bin_start, unsigned long bin_end,
    unsigned long data_start, unsigned long table_start,
    int mm_owner_pid, int fork_parent_pid);   /* NEW: 0 = not a fork */
```
`fork_parent_pid != 0` ⇒ this child is a fork of `fork_parent_pid`: the runtime
must (a) instantiate the user module against the child's duped Memory, (b)
verbatim-copy `fork_parent_pid`'s memory over it, (c) `asyncify_start_rewind`
instead of `_start` (so `capture_stack` returns 0). The child's own
`mm_owner_pid` is the child pid (the dup made the child the owner of its Memory).

---

## 4. Kernel-side address-space duplication (NOMMU reality)

On NOMMU Linux, `dup_mmap` is a **no-op** (`#else` branch in `kernel/fork.c` —
there is no MMU to copy mappings), so a stock non-CLONE_VM clone yields a child
`mm` with no mappings. Patch 0024 makes the fork child a genuine duplicate:

1. Detect the fork branch: in the arch clone path, `!(clone_flags & CLONE_VM)` AND
   the parent is a user task with `wasm_user_as_active(current->mm)`. (kthreads /
   early-boot / exec untouched — same guard discipline as patch 0018.)
2. Duplicate the parent mm's per-process allocator state into the child mm:
   `user_as_size`, `user_as_brk`, `user_as_live = true`, the free-extent list,
   and the VMA/`nommu_region` set covering the parent's mappings (so the child's
   brk/mmap bookkeeping matches the bytes the runtime will copy). `user_as_owner_pid
   = task_pid_nr(child)`.
3. Call `wasm_user_mem_dup(parent_pid, child_pid)` (§3a) to mint the child Memory.
4. Let the child reach `wasm_create_and_run_task(..., mm_owner_pid=child_pid,
   fork_parent_pid=parent_pid)`; the runtime finishes the copy + rewind.

`waitpid` / exit-status / signals then use **unchanged real-kernel semantics** —
the child is a normal scheduled task with its own pid.

---

## 5. Runtime orchestration (the host run-loop) — sequence

All within the existing per-task-worker + shared-kernel-memory model. The parent
task runs in worker **P**; the child gets a new worker **C** (as every task does).
`shared:true` Memories are cross-worker shareable, so P can forward the parent and
child Memory objects to C (reusing the CLONE_VM `clone_vm` channel).

```
parent user: fork()
  → musl sets ctl.{cur,end}; calls capture_stack(ctl_ptr)        [worker P]
  → P host: state NORMAL → start_unwind(ctl_ptr); return         [user unwinds]
  → user _start() returns into user_executable_run, state=UNWINDING
P detects pending-fork:
  → P: asyncify_stop_unwind()
  → P: child_pid = vmlinux.wasm_fork_current()                   [kernel clone]
        └ kernel copy_thread (0024): dup child mm; wasm_user_mem_dup(P_pid,C_pid)
        └ child scheduled → wasm_create_and_run_task(..., fork_parent_pid=P_pid)
              runs IN WORKER P → looks up userMems[P_pid].memory and
              userMems[C_pid].memory → postMessage create_and_run_task with
              fork:{ parent_pid, parent_memory, child_memory, ctl_ptr }
  → P: asyncify_start_rewind(ctl_ptr); re-enter _start()
        └ capture_stack re-entry (REWINDING) → stop_rewind(); return child_pid
        └ fork() returns child_pid in the parent. ✓
host main: make_task(... fork ...) → worker C
  → C: ret_from_fork; user_executable_setup instantiates user module
        against child_memory  (segments re-applied — fine, copy comes next)
  → C: new Uint8Array(child_memory.buffer).set(new Uint8Array(parent_memory.buffer))
        (FINDING A: copy AFTER instantiation; verbatim incl. the ctl + stack image)
  → C: asyncify_start_rewind(ctl_ptr); _start()
        └ capture_stack re-entry (REWINDING) → stop_rewind(); return 0
        └ fork() returns 0 in the child. ✓
```

**Ordering invariants:**
- Copy parent→child happens **after** `stop_unwind` (image settled in P's memory)
  and **after** the child instance exists (finding A). The parent is parked
  mid-fork the whole time, so the snapshot is consistent.
- Parent and child rewind independently once memories are separated; neither can
  corrupt the other (distinct Memory objects).

**Teardown** is unchanged: the child is a normal task; `release_task` /
`wasm_user_mem_free(child_pid)` reclaim it on exit (reuse the Phase-1 teardown
instrumentation; assert registry returns to baseline under rapid fork/exit).

---

## 6. What stays asyncify-free (the sacred fast path)

`posix_spawn` / `vfork`+exec keep using **clone-with-fn** (`__libc_clone_callback`,
the existing `should_call_clone_callback` path) with **zero** asyncify cost — they
never call `capture_stack`. Only `fork()`-without-exec pays the asyncify tax, and
only the fork call graph is instrumented (`asyncify-onlylist`). The Phase-1 B2
fast-path guard (`runtime/node/task2.5-fastpath.test.mjs`) must stay green.

## 7. Versioning

Single repo now, but the kernel↔runtime contract is still versioned to catch
exec-ABI skew (the hard-won lesson): bump BOTH `#define WASM_HOSTBRIDGE_ABI` (C)
and `export const WASM_HOSTBRIDGE_ABI` (JS) to `3` in the same change that adds
`wasm_user_mem_dup` / `wasm_fork_current` / the `fork_parent_pid` parameter.
