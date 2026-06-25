# The in-guest compiler: LLVM-21 clang + lld cross-compiled to the wasm32 guest →
# $out/bin/{clang,wasm-ld} (+ $out/lib/clang resource dir). This is what
# lets the guest COMPILE in-browser, not just install pre-built packages.
#
# Faithful Nix port of pc's `build_guest_clang` (build.sh) — clang+lld for
# wasm32-unknown-unknown, from the stock LLVM-21 monorepo, against the nix-built
# musl sysroot + libc++. Mirrors toolchain/libcxx.nix (cmake-from-monorepoSrc with
# the native clang-unwrapped as the cross compiler), scaled up to clang+lld.
#
# Two deliberate deviations from the upstream recipe:
#   1. Native tablegen is REUSED from the cached host LLVM-21 (LLVM_TABLEGEN /
#      CLANG_TABLEGEN) instead of building a whole second native LLVM in-tree
#      (the recipe's -DCROSS_TOOLCHAIN_FLAGS_NATIVE). Faster + cleaner; the cached
#      tools are the same 21.1.8 as the source pin.
#   2. The driver binary is `clang-21` (the recipe copied `clang-18` for the fork).
# `useCcache` (default false): route every clang invocation through ccache via
# cmake's native COMPILER_LAUNCHER seam, so a rebuild after a patch/flag tweak
# reuses object files for the unchanged TUs (this is ~thousands of C++ TUs; a
# cold build is ~1–2 h on aarch64). ccache is daemonless → it fits the Nix
# sandbox; the cache dir is an impure extra-sandbox-path. OFF by default so the
# standard build stays fully hermetic/reproducible (PRIME DIRECTIVE) — enable it
# only for the dev iteration loop via `.#guest-clang-ccache`. Requires the host
# nix.conf to expose `/nix/var/cache/ccache` (see CLAUDE.md § ccache).
{ pkgs, musl, busyboxKernelHeaders, libcxx, compilerRt, useCcache ? false }:
let
  lib = pkgs.lib;
  llvm = pkgs.llvmPackages_21;

  # The shared no-undef contract (#52): clang/wasm-ld may leave undefined ONLY
  # the host-provided imports in this allow-list (the same file the crossSystem
  # cc-wrapper, guest-cxx and nix.wasm use). Any other unresolved symbol — e.g.
  # a stray `fork` — fails the link instead of becoming a dangling `env.*`
  # import that traps at instantiation (that was the #50 in-guest-cc crash).
  allowUndefined = import ./wasm-host-imports.nix { inherit pkgs; };

  # cmake's COMPILER_LAUNCHER prefixes ccache onto each compile command. The
  # trailing space + inline prepend means that when OFF this expands to "" and the
  # cmake invocation (and thus the derivation hash) is byte-for-byte the default —
  # the existing cached build is NOT invalidated.
  ccacheLauncher = lib.optionalString useCcache
    "-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache ";
  bt = llvm.bintools-unwrapped;
  cu = llvm.clang-unwrapped; # native clang that emits the wasm objects
  src = llvm.libllvm.monorepoSrc;

  # The native clang resolves compiler-rt builtins from its DEFAULT resource dir,
  # which has no wasm32 variant → the final clang-21/lld links fail opening
  # .../lib/clang/21/lib/wasm32-unknown-unknown/libclang_rt.builtins.a. Provide a
  # resource dir carrying clang's builtin headers + OUR wasm builtins and wire it
  # via -resource-dir (identical shape to nix-wasm.nix / wasm-cross.nix).
  builtins_a = "${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a";
  resourceDir = pkgs.runCommand "guest-clang-resource" { } ''
    mkdir -p $out/include $out/lib/wasm32-unknown-unknown
    cp -a ${lib.getLib cu}/lib/clang/*/include/. $out/include/
    cp ${builtins_a} $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
  '';

  # C/C++ ABI flags for the wasm target — same vocabulary as libcxx.nix /
  # nix-wasm.nix. busyboxKernelHeaders has linux/ at its top level, so -isystem it
  # directly (no /include).
  baseFlags =
    "-fPIC --sysroot=${musl} -resource-dir=${resourceDir} -isystem ${busyboxKernelHeaders} "
    + "-D__linux__ -D__unix__ -D__unix -matomics -mbulk-memory "
    + "-fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ "
    + "-fvisibility=hidden -fvisibility-inlines-hidden "
    + "-D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS "
    + "-D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS "
    # LLVM-21 added template-ABI export annotations. clang's Support/Compiler.h
    # gates CLANG_TEMPLATE_ABI on platform macros with NO fallback #else, and the
    # wasm branch keys off __WASM__ (uppercase) which clang never defines (it emits
    # __wasm__). With __ELF__ also undefined for wasm, CLANG_TEMPLATE_ABI ends up
    # entirely undefined → `extern template class CLANG_TEMPLATE_ABI Registry<…>`
    # is a parse error. CLANG_BUILD_STATIC is the intended escape (first branch →
    # all CLANG_*_ABI empty); it's only auto-defined on MSVC, so define it here for
    # our static (non-dylib) build. LLVM_BUILD_STATIC keeps the llvm side explicit.
    + "-DCLANG_BUILD_STATIC -DLLVM_BUILD_STATIC";
  cFlags = baseFlags;
  cxxFlags = baseFlags + " -nostdinc++ -isystem ${libcxx}/include/c++/v1";

  # The dylink-module link. NOT --export-all: on a ~100MB module the host bridge
  # only touches this fixed set, and dropping export-all lets --gc-sections strip
  # unreachable code; --strip-all drops the name section. libunwind.a exists in our
  # libcxx (the Unwind-wasm shim is ALSO folded into libc++abi.a) so -lunwind resolves.
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
    # No-undef contract (#52): allow ONLY the host-provided imports enumerated in
    # the shared allow-list — the libc imports clang/lld legitimately pull
    # (__dlsym_time64 via musl's time64 dlsym redirect, __cxa_thread_atexit_impl
    # from libc++abi, __cpp_exception, the __wasm_syscall_* bridge). Any OTHER
    # unresolved symbol (a stray `fork`/`exec`/`system`) fails the link loudly
    # rather than becoming a dangling `env.*` import — replacing the old blanket
    # --allow-undefined that let #36's removed `fork` slip through as the #50 crash.
    + "-Wl,--allow-undefined-file=${allowUndefined}";
in
pkgs.stdenv.mkDerivation ({
  pname = "guest-clang-wasm32";
  version = llvm.release_version;
  inherit src;

  # clean-NOMMU wasm (#36/#50): drop LLVM's fork()/exec fallback in
  # sys::ExecuteAndWait so `clang`/`wasm-ld` don't reference `fork` — which #36's
  # fork-less musl no longer provides, so under --allow-undefined it became a
  # dangling `env.fork` wasm import that traps at instantiation (the in-guest cc
  # crash). posix_spawn (forced on below) is the only spawn path; it serves every
  # spawn the drivers make. See patches/llvm/0001 + -DHAVE_POSIX_SPAWN=1.
  patches = [ ../patches/llvm/0001-program-inc-posix-spawn-only.patch ];

  nativeBuildInputs = [ pkgs.cmake pkgs.ninja pkgs.python3 cu bt ]
    ++ lib.optional useCcache pkgs.ccache;
  dontUseCmakeConfigure = true;
  dontStrip = true; # lld --strip-all already ran; wasm isn't ELF
  dontFixup = true; # nixpkgs' ELF fixup/relink chokes on .wasm
  enableParallelBuilding = true;

  buildPhase = ''
    runHook preBuild
    cmake -G Ninja -S llvm -B build \
      ${ccacheLauncher}-DCMAKE_BUILD_TYPE=MinSizeRel \
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
      `# HAVE_POSIX_SPAWN: LLVM's check_symbol_exists LINKS a probe, but the` \
      `# STATIC_LIBRARY try-compile above skips linking, so the probe silently` \
      `# fails and Program.inc falls back to fork() (→ the dangling env.fork` \
      `# import). musl provides posix_spawn (it's THE spawn path post-#36), so` \
      `# force it on; patch 0001 removes the now-dead fork() fallback entirely.` \
      -DHAVE_POSIX_SPAWN=1 \
      -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
      -DCMAKE_SKIP_INSTALL_RPATH=ON \
      -DLLVM_TABLEGEN=${llvm.libllvm}/bin/llvm-tblgen \
      -DCLANG_TABLEGEN=${cu.dev}/bin/clang-tblgen \
      -DLLVM_NATIVE_TOOL_DIR=${llvm.libllvm}/bin \
      -DLLVM_HOST_TRIPLE=wasm32-unknown-linux-musl \
      -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
      -DLLVM_TARGETS_TO_BUILD=WebAssembly \
      -DLLVM_ENABLE_PROJECTS="clang;lld" \
      -DLLVM_ENABLE_THREADS=OFF \
      -DLLVM_PARALLEL_LINK_JOBS=1 \
      -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
      -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
      -DLLVM_ENABLE_PLUGINS=OFF -DLLVM_ENABLE_BINDINGS=OFF \
      -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
      `# CMake's FindBacktrace finds the HOST execinfo.h (find_path ignores` \
      `# --sysroot), so HAVE_BACKTRACE gets set and Signals.cpp pulls execinfo.h` \
      `# which musl lacks → fatal error. Disable the probe entirely.` \
      -DCMAKE_DISABLE_FIND_PACKAGE_Backtrace=ON \
      -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_TESTS=OFF \
      -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
      -DCLANG_ENABLE_ARCMT=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
      -DCLANG_PLUGIN_SUPPORT=OFF
    cmake --build build --target clang lld
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib
    # Installed under the names the guest invokes on PATH (the wasm binfmt execs
    # by dylink.0 content, not extension). These land in the system profile
    # (bin/clang, bin/wasm-ld) — there is no longer a `.wasm` loose-vendored copy.
    cp build/bin/clang-21 $out/bin/clang
    cp build/bin/lld      $out/bin/wasm-ld
    cp -a build/lib/clang $out/lib/clang
    runHook postInstall
  '';
} // lib.optionalAttrs useCcache {
  # The persistent compile cache, exposed into the sandbox via the host's
  # `extra-sandbox-paths` (CLAUDE.md § ccache). time_macros: the LLVM sources use
  # __DATE__/__TIME__ in a couple of TUs — without this ccache refuses to cache
  # them. The store-path compiler has a stable mtime, so the default compilercheck
  # is sound.
  CCACHE_DIR = "/nix/var/cache/ccache";
  CCACHE_UMASK = "007";
  CCACHE_SLOPPINESS = "time_macros,locale";
})
