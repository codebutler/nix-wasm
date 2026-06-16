# Kernel cc/ld toolchain — the Nix equivalent of pc's fake-llvm shim
# (vendor/linux-wasm/.build/linux-wasm/tools/fake-llvm/llvm-wrapper.py).
#
# The kernel `make` is driven with `LLVM=${kernelCC}/bin/`, so kbuild resolves
# CC=clang, LD=ld.lld, AR=llvm-ar, … from this directory. We wrap the three
# tools that need argv rewrites (clang/clang++, ld.lld/wasm-ld, llvm-objcopy)
# and symlink the rest straight to the stock LLVM-21 binutils. The linker
# wrapper execs the *patched* wasm-ld (GNU linker-script support) so that
# scripts/link-vmlinux.sh's `--script=arch/wasm/kernel/vmlinux.lds` link works;
# stock wasm-ld can't parse the script.
#
# The argv-rewrite logic lives in fake-llvm-wrapper.py, transcribed VERBATIM
# from upstream (rewrite_triple / rewrite_clang / rewrite_lld /
# rewrite_objcopy). The wrapper keys on basename(argv[0]); we invoke it through
# per-tool symlinks so it sees the tool name, and substitute REAL_LLVM (a dir
# holding the patched wasm-ld + stock clang/clang++/llvm-objcopy) at build
# time so the linker reaches the patched lld while the rest stay stock.
{ pkgs, patchedLld }:
let
  llvm = pkgs.llvmPackages_21;
in
pkgs.runCommand "kernel-llvm-wrappers" { } ''
  mkdir -p $out/bin $out/libexec $out/real

  # REAL_LLVM dir the wrapper execs into: patched wasm-ld for the linker,
  # stock clang/clang++/llvm-objcopy for the rest.
  ln -s ${patchedLld}/bin/wasm-ld                   $out/real/wasm-ld
  ln -s ${llvm.clang-unwrapped}/bin/clang           $out/real/clang
  ln -s ${llvm.clang-unwrapped}/bin/clang++         $out/real/clang++
  ln -s ${llvm.bintools-unwrapped}/bin/llvm-objcopy $out/real/llvm-objcopy

  # The verbatim fake-llvm wrapper, with REAL_LLVM baked to $out/real.
  substitute ${./fake-llvm-wrapper.py} $out/libexec/llvm-wrapper.py \
    --replace '@REAL_LLVM@' "$out/real"
  # Give it a python3 shebang so the per-tool symlinks run it directly (the
  # wrapper reads basename(argv[0]) — i.e. the symlink name — as the tool).
  sed -i "1s|.*|#!${pkgs.python3}/bin/python3|" $out/libexec/llvm-wrapper.py
  chmod +x $out/libexec/llvm-wrapper.py

  # Wrapped tools: symlink each name to the wrapper so argv[0] = tool name.
  for t in clang clang++ ld.lld wasm-ld llvm-objcopy; do
    ln -s $out/libexec/llvm-wrapper.py $out/bin/$t
  done

  # Unwrapped tools straight from stock LLVM-21 binutils.
  for t in llvm-ar llvm-nm llvm-strip llvm-objdump llvm-readobj llvm-ranlib llvm-readelf; do
    ln -s ${llvm.bintools-unwrapped}/bin/$t $out/bin/$t
  done
''
