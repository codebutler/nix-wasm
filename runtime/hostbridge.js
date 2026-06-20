// hostbridge.js — synchronous in-worker copy between kernel memory and a
// process's memory, serving the kernel's wasm_user_copy_to/_from/_strncpy host
// imports (Phase 1 uaccess indirection) PLUS the Task 2 memory-lifecycle ABI
// (wasm_user_mem_create/grow/free).
//
// Task 1: every process resolves to the SHARED kernel buffer — a pure
// indirection over the current behavior, with ZERO semantic change. The memory
// split (per-process address spaces keyed on `pid`) lands in Task 2; the ABI
// and the resolver seam are introduced here so that split is a runtime-only
// change.
//
// Task 2.1 (ABI v2 scaffolding): the four memory-lifecycle imports + a pid-keyed
// `userMems` registry land here, but `create` only MINTS a per-pid memory — it
// is NOT yet wired into user-module instantiation (that flip is T2.3). The
// resolver is now pid-keyed WITH A SHARED FALLBACK; since `userMems` stays empty
// until the kernel calls `create` (T2.2 adds the kernel decls + call sites),
// this is behaviorally a no-op at boot.
//
// Phase-2 fork (ABI v3): adds `wasm_user_mem_dup(parent_pid, child_pid)` — mint
// the fork child's private Memory (same size as the parent's), registered under
// the child pid. It MINTS ONLY; the verbatim byte-copy is deferred to the child
// worker AFTER its instance exists (finding A — see runtime/asyncify.js
// dupAddressSpace). Pairs with the kernel `wasm_fork_current` export + the
// `fork_parent_pid` channel on wasm_create_and_run_task. Must match the kernel
// `#define WASM_HOSTBRIDGE_ABI` (arch/wasm/include/asm/wasm.h). Contract:
// docs/superpowers/specs/2026-06-20-fork-host-abi-v3.md.
export const WASM_HOSTBRIDGE_ABI = 3;

// makeHostBridge(kernelMemory, resolveMem, lifecycle?) -> { wasm_user_copy_to, ... }
//   kernelMemory: the WebAssembly.Memory backing the kernel.
//   resolveMem(pid) -> { u8: () => Uint8Array } for the target address space.
//                      Task 2.1 resolver: `userMems.get(pid)?.memory ?? shared`.
//   lifecycle (optional, Task 2.1): { userMems, mintUserMem } wiring the
//     memory-lifecycle ops. `userMems` is the pid -> { memory, table } registry
//     the resolver consults; `mintUserMem(pid, init_pages) -> WebAssembly.Memory`
//     mints the per-pid private memory (the worker wires this to a main-thread
//     bounce — browsers may not create+transfer Memory from a worker; see the
//     refined design §3 + the `create_user_mem` handler in kernel-host.js). When
//     `lifecycle` is omitted (e.g. the Task 1 unit tests), the lifecycle ops are
//     still present but inert (`create` fails closed with -1).
export function makeHostBridge(kernelMemory, resolveMem, lifecycle = {}) {
  const kbuf = () => new Uint8Array(kernelMemory.buffer);
  const userMems = lifecycle.userMems || null;
  const mintUserMem = lifecycle.mintUserMem || null;
  return {
    // Copy n bytes kernel(src_kaddr) -> user(dst_uaddr) in process `pid`.
    // Returns the number of bytes NOT copied (0 on success), matching the
    // kernel's raw_copy_to_user contract.
    wasm_user_copy_to(pid, dst_uaddr, src_kaddr, n) {
      const dst = resolveMem(pid).u8();
      dst.set(kbuf().subarray(src_kaddr, src_kaddr + n), dst_uaddr);
      return 0;
    },
    // Reverse direction: user(src_uaddr) -> kernel(dst_kaddr). Returns bytes
    // not copied (0 on success).
    wasm_user_copy_from(pid, dst_kaddr, src_uaddr, n) {
      const src = resolveMem(pid).u8();
      kbuf().set(src.subarray(src_uaddr, src_uaddr + n), dst_kaddr);
      return 0;
    },
    // Zero n bytes at user(uaddr) in process `pid` (services __clear_user / the
    // anon-zero / BSS clear, which used to memset() the user pointer directly).
    // Returns the number of bytes NOT zeroed (0 on success), matching the
    // kernel's clear_user contract. ABI is still 1 — this op is forward-declared
    // here so Task 2.0 can route the residual holes through the bridge on the
    // shared resolver; the per-pid memory split lands in Task 2.1+.
    wasm_user_memzero(pid, uaddr, n) {
      const dst = resolveMem(pid).u8();
      dst.fill(0, uaddr, uaddr + n);
      return 0;
    },
    // Bounded NUL-terminated copy user(src_uaddr) -> kernel(dst_kaddr), at most
    // `count` bytes. Returns the length copied (excluding the NUL), or `count`
    // if no NUL was found within the limit.
    wasm_user_strncpy(pid, dst_kaddr, src_uaddr, count) {
      const src = resolveMem(pid).u8();
      const dst = kbuf();
      let i = 0;
      for (; i < count; i++) {
        const b = src[src_uaddr + i];
        dst[dst_kaddr + i] = b;
        if (b === 0) return i;
      }
      return i;
    },

    // ---- Task 2.1: memory-lifecycle ABI (WASM_HOSTBRIDGE_ABI = 2) ----
    //
    // Mint a private base-0 WebAssembly.Memory for process `pid` and register it
    // in `userMems` (pid -> { memory, table }). Returns 0 on success, <0 on
    // failure — matching the kernel's `long wasm_user_mem_create(int, ulong)`
    // contract. The Memory is minted via `mintUserMem` (in the real worker, a
    // synchronous bounce to the MAIN thread, which is the only place a non-shared
    // Memory can be created+transferred; see kernel-host.js create_user_mem). A
    // re-exec for a pid that already has an entry replaces it (drop-then-mint),
    // mirroring exec tearing down the prior mm. NOT yet consulted during user
    // instantiation — the registry exists but the flip to private memory is T2.3.
    wasm_user_mem_create(pid, init_pages) {
      if (!userMems || !mintUserMem) return -1; // no lifecycle wiring → fail closed
      const memory = mintUserMem(pid, init_pages);
      if (!memory) return -1;
      userMems.set(pid, { memory, table: null });
      return 0;
    },
    // Grow process `pid`'s private memory by `delta_pages` (wasm 64 KiB pages).
    // Returns the NEW page count, or -1 if the pid has no registry entry or the
    // grow is rejected (matching `unsigned long wasm_user_mem_grow` → -1 = fail).
    wasm_user_mem_grow(pid, delta_pages) {
      const e = userMems && userMems.get(pid);
      if (!e) return -1;
      try {
        e.memory.grow(delta_pages); // returns the OLD page count
        return e.memory.buffer.byteLength / 65536; // → the new page count
      } catch {
        return -1; // grow past maximum / OOM
      }
    },
    // Drop process `pid`'s registry entry (called at exit_mmap teardown). The
    // runtime tears down the Memory by releasing the last reference; the worker
    // is killed separately at release_task (refined design §5 ordering).
    wasm_user_mem_free(pid) {
      if (userMems) userMems.delete(pid);
    },

    // ---- Phase-2 fork: child address-space mint (WASM_HOSTBRIDGE_ABI = 3) ----
    //
    // Mint the fork child `child_pid`'s private base-0 Memory with `init_pages`
    // wasm pages (the kernel passes the child mm's user_as size — equal to the
    // parent's, which the verbatim snapshot will fill), and register it under
    // child_pid. Returns 0 / <0 (matching `long wasm_user_mem_dup`). MINTS ONLY —
    // the byte copy is done by the child worker AFTER it instantiates (finding A).
    // Unlike wasm_user_mem_create this does NOT touch current_user_pid (it runs
    // in __switch_to in whatever worker schedules the child, which is NOT the
    // child's own worker). The kernel passes the SIZE (not the parent pid) so the
    // mint needs no parent registry lookup — a lazily-spawned child's __switch_to
    // can run in a worker that doesn't hold the parent's Memory entry.
    wasm_user_mem_dup(child_pid, init_pages) {
      if (!userMems || !mintUserMem) return -1; // no lifecycle wiring → fail closed
      const memory = mintUserMem(child_pid, init_pages);
      if (!memory) return -1;
      userMems.set(child_pid, { memory, table: null });
      return 0;
    },
  };
}
