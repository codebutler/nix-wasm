# LLVM-21 lld carrying the joelseverin/llvm wasm-ld GNU-linker-script patch,
# rebased to 21 (patches/llvm/wasm-ld-linker-script-21.patch). The wasm guest
# KERNEL links vmlinux with `wasm-ld --script=arch/wasm/kernel/vmlinux.lds`;
# stock wasm-ld has no linker-script support. This is a SEPARATE derivation
# (overrideAttrs, NOT a global overlay) consumed ONLY by the kernel build — the
# shared cross toolchain keeps using the cached stock lld (no rebuild cascade).
# Only the kernel needs this; userspace links fine with stock wasm-ld.
{ pkgs }:
pkgs.llvmPackages_21.lld.overrideAttrs (o: {
  patches = (o.patches or [ ]) ++ [ ../patches/llvm/wasm-ld-linker-script-21.patch ];
})
