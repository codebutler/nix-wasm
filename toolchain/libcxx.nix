# libc++ / libc++abi / libunwind for wasm32-linux-musl, from stock LLVM-21.
#
# Built from the LLVM-21 monorepo `runtimes` tree against the nix-built musl
# sysroot + kernel headers, with wasm exception handling (-fwasm-exceptions).
# NO fork, NO patch: the wasm-EH __cxa_init_primary_exception signature is
# upstream since LLVM 19 (gated on #ifdef __wasm__) — verified against
# release/21.x. libunwind builds ONLY the Unwind-wasm.c shim (the rest doesn't
# apply to wasm), like Emscripten. Recipe from build.sh:459-504 +
# ~/lwbuild/ws/build/cxx-wasm32_nommu/CMakeCache.txt.
{ pkgs, musl, kernelHeaders, compilerRt }:
let
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
  src = llvm.libllvm.monorepoSrc;
  flags = "-fPIC --sysroot=${musl} -isystem ${kernelHeaders}/include "
    + "-D__linux__ -D__unix__ -D__unix -matomics -mbulk-memory "
    + "-fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ "
    + "-fvisibility=hidden -fvisibility-inlines-hidden -O2 -I${src}/libunwind/include";
in
pkgs.stdenv.mkDerivation {
  pname = "libcxx-wasm32-nommu";
  version = llvm.release_version;
  inherit src;

  nativeBuildInputs = [ pkgs.cmake pkgs.ninja pkgs.python3 llvm.clang-unwrapped bt ];
  dontUseCmakeConfigure = true;

  buildPhase = ''
    runHook preBuild
    cmake -G Ninja -S runtimes -B build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
      -DCMAKE_C_COMPILER=${llvm.clang-unwrapped}/bin/clang \
      -DCMAKE_CXX_COMPILER=${llvm.clang-unwrapped}/bin/clang++ \
      -DCMAKE_AR=${bt}/bin/llvm-ar -DCMAKE_RANLIB=${bt}/bin/llvm-ranlib \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_C_FLAGS="${flags}" -DCMAKE_CXX_FLAGS="${flags}" \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DLLVM_ENABLE_RUNTIMES="libcxxabi;libcxx" \
      -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON \
      -DLIBCXXABI_HERMETIC_STATIC_LIBRARY=ON -DLIBCXX_HERMETIC_STATIC_LIBRARY=ON \
      -DLIBCXXABI_USE_COMPILER_RT=ON -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
      -DLIBCXXABI_ENABLE_THREADS=ON \
      -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON \
      -DLIBCXX_USE_COMPILER_RT=ON -DLIBCXX_CXX_ABI=libcxxabi \
      -DLIBCXX_HAS_MUSL_LIBC=ON -DLIBCXX_ENABLE_THREADS=ON \
      -DLIBCXX_INCLUDE_BENCHMARKS=OFF -DLIBCXX_INCLUDE_TESTS=OFF
    cmake --build build -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cmake --install build
    # libunwind: wasm-EH shim only (Unwind-wasm.c → __builtin_wasm_throw).
    ${llvm.clang-unwrapped}/bin/clang ${flags} --target=wasm32-unknown-unknown \
      -D_LIBUNWIND_HIDE_SYMBOLS -I ${src}/libunwind/src \
      -c ${src}/libunwind/src/Unwind-wasm.c -o Unwind-wasm.o
    ${bt}/bin/llvm-ar rcs $out/lib/libunwind.a Unwind-wasm.o
    runHook postInstall
  '';

  dontStrip = true;
}
