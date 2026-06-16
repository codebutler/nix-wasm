# Kernel-only patched LLVM-21 scope. The wasm guest KERNEL needs two stock-LLVM
# fixes that the shared cross toolchain does NOT:
#
#   1. wasm-ld GNU linker-script support (lld) — link vmlinux via
#      `wasm-ld --script=arch/wasm/kernel/vmlinux.lds`; stock wasm-ld can't
#      parse the script (patches/llvm/wasm-ld-linker-script-21.patch).
#   2. MC-layer assembler support for the kernel's EXPORT_SYMBOL inline-asm
#      (`.section ".export_symbol","a"` / `.previous` / `.pushsection` and the
#      ELF section-flag chars `a w x M e o`) — stock LLVM-21's WasmAsmParser
#      rejects them (patches/llvm/wasm-mc-21.patch on libllvm).
#
# Both patches live in a LOCAL `overrideScope` so the patched lld links the
# patched libllvm (the override seam guarantees `lld` is built against this
# scope's `libllvm`, not the global one). Nothing here touches the global
# `llvmPackages_21` used by cross.*/wasm-cross.nix/deps-overlay.nix — no rebuild
# cascade on the shared cached toolchain; only the kernel consumes this scope.
{ pkgs }:
pkgs.llvmPackages_21.overrideScope (final: prev: {
  libllvm = prev.libllvm.overrideAttrs (o: {
    patches = (o.patches or [ ]) ++ [ ../patches/llvm/wasm-mc-21.patch ];
  });
  lld = prev.lld.overrideAttrs (o: {
    patches = (o.patches or [ ]) ++ [ ../patches/llvm/wasm-ld-linker-script-21.patch ];
  });

  # clang here is NOT our patch surface (the patches are in libllvm + lld above;
  # this clang just links the patched libllvm via the scope fixpoint). So build
  # it LEAN to fit the box — the kernel needs only the C compiler + assembler:
  #   - drop clang-tools-extra (clangd/clang-tidy/…): the dominant build-disk +
  #     link-RAM cost, never used by the kernel. nixpkgs pulls it in via a
  #     postPatch `tools/extra` symlink; remove it (+ the postInstall that copies
  #     a clang-tidy helper, which then won't exist).
  #   - no debug info (separateDebugInfo): -ggdb bloats objects + link memory.
  #     We keep debug on the PATCHED libllvm/lld (already built) where a crash
  #     could happen; clang is stock, so its symbols aren't worth the GBs.
  clang-unwrapped = prev.clang-unwrapped.overrideAttrs (o: {
    separateDebugInfo = false;
    postPatch = (o.postPatch or "") + ''
      rm -rf tools/extra
    '';
    postInstall = builtins.replaceStrings
      [ "cp bin/clang-tidy-confusable-chars-gen $dev/bin" ] [ "" ]
      (o.postInstall or "");
  });
})
