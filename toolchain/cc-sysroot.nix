# cc-sysroot — the sysroot the in-guest `cc` wrapper (toolchain/guest-cc.nix)
# drives clang/wasm-ld against. Emitted as a plain STORE DIRECTORY ($out/sys/
# {musl,clang}) served read-only over 9P as part of the /nix closure — `cc`
# references it by store path (`--sysroot=$out/sys/musl -resource-dir=$out/sys/
# clang`), so there is NO cpio, NO /tmp copy, and NO ramfs unpack (the old cpio
# form scattered the NOMMU heap). Built purely from the nix toolchain so it stays
# in lockstep with guest-clang.nix (same LLVM-21 builtin headers + the same
# nix-built musl + compiler-rt the guest clang itself was built on).
#
# Layout (SR = $out/sys):
#   sys/musl/{include,lib}                              — musl headers + crt*.o + libc.a …
#   sys/clang/include                                   — clang builtin headers (stddef.h …)
#   sys/clang/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
#   sys/cxx/include/c++/v1                              — libc++ headers (for the `c++` driver)
#   sys/cxx/lib/{libc++.a,libc++abi.a,libunwind.a}      — libc++ + libc++abi (unwind shim folded in)
{ pkgs, musl, compilerRt, libcxx }:
let
  lib = pkgs.lib;
  cu = pkgs.llvmPackages_21.clang-unwrapped; # same clang whose headers guest-clang.nix ships
  builtins_a = "${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a";
in
pkgs.runCommand "cc-sysroot" { }
  ''
    mkdir -p "$out/sys/musl" "$out/sys/clang/include" \
             "$out/sys/clang/lib/wasm32-unknown-unknown"

    # musl sysroot (headers + crt objects + static libs) — the nix-built musl,
    # identical to what guest clang links against.
    cp -a ${musl}/include "$out/sys/musl/include"
    cp -a ${musl}/lib     "$out/sys/musl/lib"

    # clang builtin headers (resource-dir/include) — ONLY the generic freestanding
    # C set (__stdarg_*/__stddef_*, float/limits/stdint/stdatomic/tgmath/…). The
    # full LLVM-21 resource dir is ~15MB (273 files: arm_neon.h, arm_sve.h, x86
    # avx*, altivec, opencl-c, … none usable on wasm32); the 29 generic headers
    # (~100KB) are what simple C needs. Resolve the versioned include dir first
    # (clang/21/include) so only the filename globs below expand — a single
    # trailing glob is reliable, whereas a `*` in both dir and filename was not.
    incdir=$(echo ${lib.getLib cu}/lib/clang/*/include)
    cp "$incdir"/__stdarg_*.h "$incdir"/__stddef_*.h "$out/sys/clang/include/"
    for h in float.h inttypes.h iso646.h limits.h stdalign.h stdarg.h \
             stdatomic.h stdbool.h stddef.h stdint.h stdnoreturn.h tgmath.h; do
      cp "$incdir/$h" "$out/sys/clang/include/"
    done

    # OUR wasm compiler-rt builtins (resource-dir/lib/<triple>).
    cp ${builtins_a} "$out/sys/clang/lib/wasm32-unknown-unknown/libclang_rt.builtins.a"

    # libc++ for the in-guest `c++` driver (toolchain/guest-cxx.nix): the same
    # nix-built libcxx that nix.wasm itself links. Headers go under
    # sys/cxx/include/c++/v1 (driven via -nostdinc++ -isystem …); the static libs
    # (libc++.a + libc++abi.a with the Unwind-wasm shim already folded in, plus
    # libunwind.a) go under sys/cxx/lib.
    mkdir -p "$out/sys/cxx/include" "$out/sys/cxx/lib"
    cp -a ${libcxx}/include/c++ "$out/sys/cxx/include/c++"
    cp ${libcxx}/lib/libc++.a ${libcxx}/lib/libc++abi.a ${libcxx}/lib/libunwind.a \
       "$out/sys/cxx/lib/"
  ''
