# The in-guest wasm-opt: Binaryen cross-compiled to the wasm32 guest →
# $out/bin/wasm-opt. This is what lets the guest run the asyncify pass IN-BROWSER,
# so a user can compile a fork() program interactively in the guest (Phase 2 T1b),
# not just substitute a host-built one.
#
# Mirrors toolchain/guest-clang.nix: cmake-from-source with the native
# clang-unwrapped as the cross compiler against the nix-built musl sysroot +
# libc++, scaled DOWN to just Binaryen (smaller than LLVM — minutes, not hours).
#
# Binaryen's optimizer ThreadPool uses std::thread; the guest supports pthreads
# (clone-with-fn), and wasm-opt runs single-threaded when hardware_concurrency()
# reports <= 1 (the guest is pinned to one CPU), so no NOMMU fork is involved.
{ pkgs, musl, busyboxKernelHeaders, libcxx, compilerRt }:
let
  lib = pkgs.lib;
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
  cu = llvm.clang-unwrapped; # native clang that emits the wasm objects
  src = pkgs.binaryen.src; # same Binaryen the host asyncify-cc uses

  builtins_a = "${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a";
  resourceDir = pkgs.runCommand "guest-binaryen-resource" { } ''
    mkdir -p $out/include $out/lib/wasm32-unknown-unknown
    cp -a ${lib.getLib cu}/lib/clang/*/include/. $out/include/
    cp ${builtins_a} $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
  '';

  # Identical wasm C/C++ ABI vocabulary to guest-clang.nix / nix-wasm.nix.
  baseFlags =
    "-fPIC --sysroot=${musl} -resource-dir=${resourceDir} -isystem ${busyboxKernelHeaders} "
    + "-D__linux__ -D__unix__ -D__unix -matomics -mbulk-memory "
    + "-fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ "
    + "-fvisibility=hidden -fvisibility-inlines-hidden "
    + "-D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS "
    + "-D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS";
  cFlags = baseFlags;
  cxxFlags = baseFlags + " -nostdinc++ -isystem ${libcxx}/include/c++/v1";

  # Same dylink-module link as guest-clang (the guest binfmt execs by dylink.0
  # content). wasm-opt's entry is _start; everything else is gc-stripped.
  exeLinkerFlags =
    "-nostdlib++ -L${libcxx}/lib -lc++ -lc++abi -lunwind "
    + "-Wl,-shared -Wl,-Bsymbolic -Wl,--no-entry -Wl,--export=_start "
    + "-Wl,--export-if-defined=__wasm_apply_data_relocs "
    + "-Wl,--export-if-defined=__wasm_call_ctors "
    + "-Wl,--export-if-defined=__set_tls_base "
    + "-Wl,--export-if-defined=__libc_clone_callback "
    + "-Wl,--export-if-defined=__libc_handle_signal "
    + "-Wl,--strip-all -Wl,--import-memory -Wl,--shared-memory "
    + "-Wl,--max-memory=4294967296 -Wl,--import-table "
    + "-Wl,--no-merge-data-segments "
    + "-Wl,--allow-undefined";
in
pkgs.stdenv.mkDerivation {
  pname = "guest-binaryen-wasm32";
  version = "129";
  inherit src;

  nativeBuildInputs = [ pkgs.cmake pkgs.ninja pkgs.python3 cu bt ];
  dontUseCmakeConfigure = true;
  dontStrip = true; # lld --strip-all already ran; wasm isn't ELF
  dontFixup = true; # nixpkgs' ELF fixup/relink chokes on .wasm
  enableParallelBuilding = true;

  buildPhase = ''
    runHook preBuild
    cmake -G Ninja -S . -B build \
      -DCMAKE_BUILD_TYPE=MinSizeRel \
      -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
      -DCMAKE_C_COMPILER=${cu}/bin/clang \
      -DCMAKE_CXX_COMPILER=${cu}/bin/clang++ \
      -DCMAKE_AR=${bt}/bin/llvm-ar \
      -DCMAKE_RANLIB=${bt}/bin/llvm-ranlib \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_C_FLAGS="${cFlags}" \
      -DCMAKE_CXX_FLAGS="${cxxFlags}" \
      -DCMAKE_EXE_LINKER_FLAGS="${exeLinkerFlags}" \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
      -DCMAKE_SKIP_INSTALL_RPATH=ON \
      -DBUILD_TESTS=OFF \
      `# Keep BUILD_LLVM_DWARF ON (the default): it adds the vendored` \
      `# third_party/llvm-project/include path that the Outlining pass's` \
      `# suffix_tree.h needs (llvm/Support/Allocator.h), DWARF aside.` \
      -DBUILD_LLVM_DWARF=ON \
      -DBYN_ENABLE_LTO=OFF \
      -DBYN_ENABLE_ASSERTIONS=OFF \
      -DINSTALL_LIBS=OFF \
      -DENABLE_WERROR=OFF \
      `# Build libbinaryen STATIC: the default shared-library link uses` \
      `# CMAKE_SHARED_LINKER_FLAGS (not our exe flags), so it lacks -lc++ and adds` \
      `# wasm-ld-rejected --no-undefined. Static folds libbinaryen.a into wasm-opt` \
      `# via the exe link, which carries our libc++ + dylink flags.` \
      -DBUILD_STATIC_LIB=ON
    cmake --build build --target wasm-opt
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    # Installed under the name the guest invokes on PATH (the wasm binfmt execs by
    # dylink.0 content, not extension).
    cp build/bin/wasm-opt $out/bin/wasm-opt
    runHook postInstall
  '';
}
