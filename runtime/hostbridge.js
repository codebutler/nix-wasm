// hostbridge.js — synchronous in-worker copy between kernel memory and a
// process's memory, serving the kernel's wasm_user_copy_to/_from/_strncpy host
// imports (Phase 1 uaccess indirection).
//
// Task 1: every process resolves to the SHARED kernel buffer — a pure
// indirection over the current behavior, with ZERO semantic change. The memory
// split (per-process address spaces keyed on `pid`) lands in Task 2; the ABI
// and the resolver seam are introduced here so that split is a runtime-only
// change.
export const WASM_HOSTBRIDGE_ABI = 1;

// makeHostBridge(kernelMemory, resolveMem) -> { wasm_user_copy_to, ... }
//   kernelMemory: the WebAssembly.Memory backing the kernel.
//   resolveMem(pid) -> { u8: () => Uint8Array } for the target address space.
//                      (Task 1 always returns a view onto kernelMemory.)
export function makeHostBridge(kernelMemory, resolveMem) {
  const kbuf = () => new Uint8Array(kernelMemory.buffer);
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
  };
}
