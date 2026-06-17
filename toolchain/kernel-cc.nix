# Kernel toolchain: the patched-LLVM-21 tools, merged under one prefix so kbuild's
# `LLVM=<dir>/` finds clang / ld.lld / wasm-ld / llvm-* by name. NO wrapper, NO
# argv rewriting — the old fake-llvm-wrapper.py is gone. Every wasm-specific
# cc/ld/objcopy flag now lives in the kernel source (patches/kernel/0008-0011 +
# the CLANG_TARGET_FLAGS_wasm make override in kernel.nix).
#
# This is just `symlinkJoin` — the idiomatic Nix package-merge — over the three
# packages that hold the tools, instead of a hand-listed symlink farm:
#   - clang-unwrapped → clang, clang++  (patched libllvm: EXPORT_SYMBOL inline-asm)
#   - lld            → ld.lld (ELF, HOSTLD) + wasm-ld (the wasm target linker;
#                      patched: GNU linker-script support for vmlinux.lds)
#   - bintools-unwrapped → llvm-ar/nm/objcopy/objdump/strip/readelf/…
# clang follows its bin symlink back to its own resource dir, so the merge is
# transparent. `llvm` is the kernel-only patched LLVM-21 scope (kernel-llvm.nix).
{ pkgs, llvm }:
pkgs.symlinkJoin {
  name = "kernel-llvm-tools";
  paths = [ llvm.clang-unwrapped llvm.lld llvm.bintools-unwrapped ];
}
