# compiler-rt builtins for wasm32-unknown-unknown, from stock LLVM-21.
#
# The builtins archive (__multi3, __divdi3, soft-float, …) that musl links via
# `--rtlib=compiler-rt` and that every wasm executable needs. Built from the
# nixpkgs LLVM-21 monorepo source with the exact wasm flags the linux-wasm
# toolchain uses (see docs/superpowers/plans/2026-06-15-nix-wasm-toolchain.md
# Task 5; recipe from ~/lwbuild/ws/build/compiler-rt-wasm32/CMakeCache.txt).
#
# No musl dependency (COMPILER_RT_BAREMETAL_BUILD=ON) — this builds BEFORE musl.
{ pkgs }:
let
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
in
pkgs.stdenv.mkDerivation {
  pname = "compiler-rt-builtins-wasm32";
  version = llvm.release_version;
  src = llvm.libllvm.monorepoSrc;

  nativeBuildInputs = [ pkgs.cmake pkgs.ninja llvm.clang-unwrapped bt pkgs.python3 ];
  dontUseCmakeConfigure = true;

  buildPhase = ''
    runHook preBuild
    cmake -G Ninja -S compiler-rt/lib/builtins -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER=${llvm.clang-unwrapped}/bin/clang \
      -DCMAKE_AR=${bt}/bin/llvm-ar \
      -DCMAKE_NM=${bt}/bin/llvm-nm \
      -DCMAKE_RANLIB=${bt}/bin/llvm-ranlib \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_C_FLAGS="-matomics -mbulk-memory" \
      -DCOMPILER_RT_BAREMETAL_BUILD=ON \
      -DCOMPILER_RT_BUILD_CRT=OFF \
      -DCOMPILER_RT_HAS_FPIC_FLAG=OFF \
      -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
      -DCOMPILER_RT_BUILTINS_ENABLE_PIC=ON \
      -DCOMPILER_RT_BUILTINS_HIDE_SYMBOLS=ON \
      -DCOMPILER_RT_EXCLUDE_ATOMIC_BUILTIN=ON \
      -DCMAKE_INSTALL_PREFIX=$out
    cmake --build build -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/wasm32-unknown-unknown
    cp "$(find build -name 'libclang_rt.builtins*.a' | head -1)" \
       $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
    runHook postInstall
  '';

  dontStrip = true;
}
