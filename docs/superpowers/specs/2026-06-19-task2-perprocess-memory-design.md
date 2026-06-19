# Refined design: per-process base-0 `WebAssembly.Memory` (Task 2)

**Date:** 2026-06-19
**Refines:** `docs/superpowers/specs/2026-06-18-mmu-fork-design.md` §5 (Phase 1 substrate), after the
Task 2 BLOCKED finding (`.superpowers/sdd/task-2-report.md`).
**Decision:** Option (A) — a per-`mm` base-0 user-address-space allocator backing **every** user
mapping, plus a runtime memory-lifecycle ABI. The window-translation shortcut is dead (musl mallocng
allocates via `mmap()` not `brk`, so heap must live in the private space too).

Citations are against the read-only reference kernel (`/home/vbvntv/lwbuild/ws/src/kernel`, rev
`039e5f3e`) and the worktree runtime (`runtime/`).

## Prior art (checked 2026-06-19)

No wasm-compiled Linux kernel implements per-process memory isolation. Verified across every branch of
both upstream repos: `joelseverin/linux` (`wasm-7.0` tip = our pin `039e5f3e`) and `joelseverin/linux-wasm`
(`master`, `wasm-7.0`) — all NOMMU, single shared address space, "MMU support" listed as *Future*,
"memory cannot be mapped and shared between processes." Upstream's active memory direction is **Memory64**
(a bigger *single shared* 64-bit space, marked `NOMERGE`/experimental) — orthogonal to isolation; we build
wasm32 and don't use it. Nearest mechanism precedent is **WALI** (arXiv 2312.03858), which grows wasm
memory for `mmap` — but in the inverse (wasm-on-host) model. So this approach is first-of-its-kind here.
(See tracking issue codebutler/nix-wasm#12 for unrelated runtime/build sync.)

## 0. The inversion

Today user-virtual == kernel-physical because `do_mmap_private` returns `alloc_pages_exact(...)` from the
shared NOMMU pool (`mm/nommu.c:959,:967`). The new model decouples the user address space from the kernel
pool: each process gets a distinct base-0 `WebAssembly.Memory` (runtime-owned, pid-keyed); the kernel runs
a per-`mm` bump/free allocator handing out offsets in `[GUARD, size)`; those small offsets flow to the
runtime as `__memory_base`/`__stack_pointer` exactly as today but now index the *private* memory. Task 1's
host-bridge (pid-keyed resolver) remains the sole path that touches user bytes.

## 1. Per-`mm` base-0 allocator

**State** in `mm_context_t` (`arch/wasm/include/asm/mmu.h`, beside the existing `end_brk`):
```c
struct mm_context_t {
    unsigned long end_brk;          /* existing */
    unsigned long user_as_size;     /* private memory size, bytes (pages*64KiB) */
    unsigned long user_as_brk;      /* next free offset (bump) */
    struct list_head user_as_free;  /* freed [start,len) extents (munmap reuse) */
    bool user_as_live;              /* set at exec; the user-vs-kernel discriminator */
};
```

**Layout** within `[0, size)`: guard page at 0 (NULL traps), `USER_AS_BASE=0x10000`, then data+bss
(`data_start`), then stack+brk arena (`start_brk..end_brk..start_stack`, unchanged layout), then `mmap`
allocations bumping upward.

- **Code is NOT in the private memory** — the user binary's bytes are read by the runtime from the *shared*
  kernel image `[bin_start,bin_end)` to `WebAssembly.compile` (`kernel-worker.js:440`); wasm code is never
  linear-addressable. So exec's three `vm_mmap`s split: **code (`binfmt_wasm.c:247`) stays shared**;
  **data (`:346`) and stack (`:359`) go private**. `mm->start_code/end_code` keep pointing at the shared image.
- **brk never allocates new pages** (`mm/nommu.c:380` clamps to `context.end_brk`), so the hard cases are
  exec + runtime `mmap`, not brk.

**Algorithm** (page-granular, wasm page = 64 KiB): first-fit the free-list (munmap'd extents), else bump
from `user_as_brk`; if it overflows `user_as_size`, call `wasm_user_mem_grow` before returning; zero via the
bridge. `user_as_free` coalesces freed extents; **never shrink** the memory (grow-only engine).

**Zeroing / file maps:** anon-zero (`mm/nommu.c:1187` `memset` to page) and file-backed `kernel_read`
(`:981`) currently deref the pool address — under private memory they route through the bridge
(`wasm_user_memzero`; file maps via a kernel bounce buffer then `wasm_user_copy_to`). The only file-backed
user `vm_mmap` is the code image, which stays shared — so the bounce path may be unreachable; **audit during
T2.2** whether any data-file `mmap` reaches `do_mmap_private` with a private target.

## 2. User-vs-kernel gate

**Rule:** `current->mm && current->mm->context.user_as_live`. Justified by `__switch_to` already using
`next_task->mm` as the user/kthread discriminator (`arch/wasm/kernel/process.c:66`), and `copy_thread`
zeroing `mm->start_*` before a binary loads (`:195`). Kernel threads (`mm==NULL`), early boot, and pre-exec
allocations take the legacy shared path; `vmalloc`/`kmalloc` untouched; 9p/hvc/random buffers are kernel
allocations → shared.

Gate sites: `do_mmap_private` (`mm/nommu.c:914`), the anon-zero (`:1187`), `do_munmap` (`:1426`),
`exit_mmap` (`:1508`). **Edit site:** `create_wasm_tables`'s one raw `memcpy(sp, wasm_auxv, …)` to a user
pointer (`binfmt_wasm.c:101`) must become a bridge `wasm_user_copy_to`.

## 3. Runtime memory-lifecycle ABI (`WASM_HOSTBRIDGE_ABI` → 2)

Declared in `asm/wasm.h` beside the 0014 bridge block:
```c
extern long          wasm_user_mem_create(int pid, unsigned long init_pages); /* 0 ok, <0 fail */
extern unsigned long wasm_user_mem_grow  (int pid, unsigned long delta_pages);/* new pages, or -1 */
extern void          wasm_user_mem_free  (int pid);
extern unsigned long wasm_user_memzero   (int pid, unsigned long uaddr, unsigned long n); /* bytes not zeroed */
```
| Call | Kernel site | Semantics |
|------|-------------|-----------|
| `create` | `load_wasm_file`, after `setup_new_exec`, before data `vm_mmap` (`binfmt_wasm.c:240,:346`) | mint per-pid `{memory,table}`; re-exec frees prior; set `user_as_live` |
| `grow` | allocator overflow (§1) | `memory.grow(delta)` on the **per-pid** memory (not index 0) |
| `free` | `exit_mmap` (`mm/nommu.c:1508`) after VMA teardown | drop registry entry; runtime tears down memory/table/worker |
| `memzero` | anon-zero / BSS clear | zero-fill via resolved private memory |

**Registry model R1 (approved).** Each user task's private `Memory` is owned by the **worker running it**;
the pid-keyed resolver returns the worker-local memory. Justified because Linux uaccess only ever targets
`current` (`wasm_current_pid()` in the 0014 patch). `access_process_vm`/`access_remote_vm` (cross-mm,
`mm/nommu.c:1685`) are ptrace/`/proc` only — **out of scope** (no in-scope synchronous cross-pid user copy).
Resolver gains a shared-memory fallback when no private entry exists (early boot/kthreads/pre-exec),
preserving Task 1 behavior.

**Per-process memory is minted on the MAIN thread (approved)** and transferred to the requesting worker
(browsers may not create+transfer `Memory` from a worker), mirroring how `wasm_start_cpu` bounces to main
(`kernel-worker.js:346`). A `create_user_mem` handler in `kernel-host.js` mints
`new WebAssembly.Memory({initial, maximum, shared:false})`. **Budget (approved): small initial** (cover
data+stack+slack), **generous max** (grow-only; only committed pages cost) — no hard per-process cap for now.

## 4. Runtime instantiation change

`user_executable_imports.env.memory` (`kernel-worker.js:846`) = the **private** memory (not shared);
`__memory_base` stays `data_start` (`:849`), now a small private offset; the per-instance
`__indirect_function_table` (`:858`) moves into the registry entry (`userMems[pid].table`) so Task 4b
threads can share it. The kernel-side `memory` (`:640`) stays the **shared** memory for drivers/bridge-`kbuf`.
Pid-keyed resolver (`:333`):
```js
const userMems = new Map(); // pid -> { memory, table }
const _bridge = makeHostBridge(
  { get buffer() { return memory.buffer; } },
  (pid) => { const e = userMems.get(pid); const buf = e ? e.memory.buffer : memory.buffer;
             return { u8: () => new Uint8Array(buf) }; });
```

## 5. exec / grow / teardown

- **exec** (`load_wasm_file`): `setup_new_exec` (tears down old mm → `exit_mmap` → `wasm_user_mem_free` for
  the prior image) → `wasm_user_mem_create` + `user_as_live=1` → code `vm_mmap` shared → data/stack `vm_mmap`
  private → `create_wasm_tables` (argv/env via `put_user`/bridge; the raw memcpy fixed) → `start_thread`.
- **grow:** only via `wasm_user_mem_grow` on the per-pid memory. `arch/wasm/kernel/setup.c` `wasm_memory_grow`
  (grows index 0, the shared kernel memory) is **not** used for user growth — resolves report blocker #3.
- **teardown:** `exit_mmap` calls `wasm_user_mem_free(pid)` after the VMA loop; worker killed at
  `release_thread`→`wasm_release_task` (`process.c:233`). **Ordering:** free entry at `exit_mmap`, kill worker
  at `release_task`; the resolver's shared fallback covers any late benign race. (Validate in T2.4.)

## 6. Scope boundary

In scope: the allocator, the gate, the four imports + pid-resolver, private instantiation, exec/grow/teardown,
closing residual direct-deref uaccess (`__clear_user`, `strnlen_user`, the auxv memcpy). **Out:** Task 4b
(`CLONE_VM` threads share parent memory+table — the registry shape is designed so 4b just points a new
thread-worker at the parent pid's entry); fork/"duplicate the memory" + asyncify (Phase 2). Non-goals honored:
no COW, no demand paging, no `mmap`-of-files MMU, fixed stacks persist; allocator is grow-only + eager-zero.

## 7. Re-decomposition (replaces old single Task 2; old Step 5 deleted — drivers read KERNEL buffers)

- **T2.0** — close residual direct-deref uaccess holes (`__clear_user`, `strnlen_user`, `create_wasm_tables`
  memcpy) through the bridge. Prerequisite, no behavior change, verifiable on the shared resolver.
- **T2.1** — ABI v2 scaffolding: the four imports + `userMems` map + pid-keyed resolver; `create` mints a
  memory not yet wired into instantiation; bump `WASM_HOSTBRIDGE_ABI=2`. Boot unaffected.
- **T2.2** — kernel gate + per-`mm` allocator landed **dark** (feature-flagged: addresses recorded, not used);
  wire `create` at exec, `free` at `exit_mmap`. Test: `data_start`/`start_stack` now small (`>=0x10000`),
  create/free fire once per exec/exit; boot green.
- **T2.3** — the flip: instantiate against the private memory; allocator-overflow→`grow`, anon-zero→`memzero`;
  remove the flag. Test: full boot to shell over private memories + a malloc-heavy program. **First real isolation.**
- **T2.4** — isolation probe (acceptance B1) + teardown/leak test (registry returns to baseline; free-vs-kill ordering).
- **T2.5** — clone-with-fn regression (acceptance B2): `posix_spawn`/`vfork`+exec still work over per-process memory.

## 8. Risks / assumptions

- **Cross-pid copies:** R1 assumes no in-scope synchronous cross-pid user copy (`access_process_vm` = ptrace/proc, out of scope). Audit holds.
- **Worker-vs-main minting:** defaulted to main-thread mint+transfer; confirm on target browsers (capability, not source-derivable).
- **File-backed data `mmap`:** assumed absent/rare (mallocng is anon); audit in T2.2, add bounce-buffer if found.
- **Guard-page-at-0:** assumes dylink relocation tolerates `data_start=0x10000` (already uses a large nonzero base today). Verify in T2.3.
- **`strnlen_user`:** last generic uaccess reading the user pointer directly (0014 deferred it); a hard bug the instant memory splits → T2.0 is a prerequisite.
- **Teardown ordering:** `exit_mmap` free vs `release_task` kill; validate no use-after-free in T2.4.

## Critical files
- `mm/nommu.c` — `do_mmap_private(:914)`, anon-zero(`:1187`), `do_munmap(:1426)`, `exit_mmap(:1508)`, `sys_brk(:380)`.
- `fs/binfmt_wasm.c` — `vm_mmap` code/data/stack(`:247/:346/:359`), `create_wasm_tables` memcpy(`:101`), exec sequencing.
- `runtime/kernel-worker.js` — resolver(`:333`), lifecycle imports(`:341`), instantiation(`:844`, `memory:` `:846`, table `:858`), `wasm_load_executable(:438)`.
- `runtime/kernel-host.js` — shared `Memory(:211)`; new `create_user_mem` handler.
- `runtime/hostbridge.js` — `makeHostBridge` + the four `wasm_user_mem_*` ops (ABI v2).
- `arch/wasm/include/asm/{wasm.h,mmu.h}` — import decls + `mm_context_t` fields.
