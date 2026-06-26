# Nix 2.34.7 cross-compiled to the wasm32-linux-musl guest → $out/bin/nix.
#
# Faithful port of the proven hand-written nix.wasm build recipe, but built with
# Nix: clang-21 against the nix-built libc++ (libcxx) + sysroot, deps from the
# nix-built cross.* store paths. NO stub libs — real cross.libgit2 + cross.xz.
#
# Nix's C++ is compiled by meson; the final binary is hand-linked from the
# per-TU .o files because meson's `-r` relocatable prelink can't emit wasm TLS
# relocations (a real wasm limitation, not a shortcut). The meson config probes
# are fixed in postPatch (the versioned replacement for the old shell build's sed).
{ pkgs, cross, sysroot, kernelHeaders, libcxx, compilerRt, nixSrc }:
let
  lib = pkgs.lib;
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
  clang = "${llvm.clang-unwrapped}/bin/clang";
  clangxx = "${llvm.clang-unwrapped}/bin/clang++";
  wasmld = "${bt}/bin/wasm-ld";
  builtins_a = "${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a";

  # Shared no-undef allow-list (#52): the host-provided imports the nix.wasm link
  # may leave undefined (incl. the __cpp_exception EH tag and the __wasm_syscall_*
  # bridge). Passed to wasm-ld via --allow-undefined-file instead of a blanket
  # --allow-undefined, so an accidental fork/exec reference fails the link.
  allowUndefined = import ./toolchain/wasm-host-imports.nix { inherit pkgs; };

  # clang-unwrapped (used raw here, not via the cc-wrapper) resolves compiler-rt
  # builtins from its DEFAULT resource dir, which has no wasm builtins → the final
  # link fails opening .../clang/21/lib/wasm32-unknown-unknown/libclang_rt.builtins.a.
  # Provide a resource dir with clang's builtin headers + OUR builtins (same shape
  # as wasm-cross.nix), wired via -resource-dir.
  resourceDir = pkgs.runCommand "nix-wasm-clang-resource" { } ''
    mkdir -p $out/include $out/lib/wasm32-unknown-unknown
    cp -a ${lib.getLib llvm.clang-unwrapped}/lib/clang/*/include/. $out/include/
    cp ${builtins_a} $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
  '';

  # Nix's C dependency closure (nix-built, wasm32).
  deps = with cross; [
    sqlite
    libsodium
    bzip2
    xz
    zlib
    brotli
    libarchive
    openssl
    libblake3
    editline
    boost
    curl
    libgit2
    nlohmann_json
    # transitive: our nixpkgs libgit2 uses llhttp (HTTP) + pcre2 (pathspec),
    # libarchive uses zstd — link them so those symbols aren't left undefined
    # (→ env imports the guest can't satisfy → instantiate LinkError).
    pcre2
    llhttp
    zstd
  ];
  depDev = lib.concatMapStringsSep " " (d: "-I${lib.getDev d}/include") deps;
  depLib = lib.concatMapStringsSep " " (d: "-L${lib.getLib d}/lib") deps;
  # Both dirs: most deps put their .pc in lib/pkgconfig, but header-only ones
  # (nlohmann_json) ship it in share/pkgconfig.
  pkgPath = lib.concatMapStringsSep ":"
    (d: "${lib.getDev d}/lib/pkgconfig:${lib.getDev d}/share/pkgconfig") deps;

  # Shared C++ guest-ABI flags (wasm EH, atomics/bulk-memory, libc++ from the
  # nix-built libcxx, sysroot + kernel headers).
  cxxCommon = "--ld-path=${wasmld} --target=wasm32-unknown-unknown -fPIC -resource-dir=${resourceDir}"
    + " --sysroot=${sysroot} -isystem ${kernelHeaders}/include -D__linux__ -D_GNU_SOURCE"
    + " -matomics -mbulk-memory -fwasm-exceptions -D__USING_WASM_EXCEPTIONS__"
    # Nix's crash-handler uses boost::stacktrace, whose default backend calls
    # _Unwind_Backtrace — wasm has no stack-walking unwinder, so it can't be
    # implemented. Select boost::stacktrace's NOOP backend (empty traces, the
    # honest behavior on wasm) so nothing references _Unwind_Backtrace. (The
    # the old shell build fake-stubbed the symbol instead; disabling the backend is the
    # correct fix — no fake symbol, the feature is properly off.)
    + " -DBOOST_STACKTRACE_USE_NOOP"
    + " -fvisibility=hidden -fvisibility-inlines-hidden"
    + " -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS"
    + " -nostdinc++ -isystem ${libcxx}/include/c++/v1 ${depDev}";
  cxxWarn = "-Wno-error -Wno-error=suggest-override -Wno-error=switch -Wno-error=switch-enum"
    + " -Wno-error=undef -Wno-error=unused-result -Wno-error=sign-compare -Wno-error=return-type"
    + " -Wno-error=non-virtual-dtor -Wno-error=c99-designator";
in
pkgs.stdenv.mkDerivation {
  pname = "nix-wasm";
  version = "2.34.7";
  src = nixSrc;

  patches = [
    ./patches/nix-2.34.7-wasm32-port.patch
    # nix-wasm#1: let `nix profile install` substitute a drvPath-less catalog
    # entry (the substitute-only guest binary cache) instead of throwing
    # "'<name>' is not a derivation". See the patch header for the full rationale.
    ./patches/nix-2.34.7-profile-substitute-install.patch
  ];

  # Versioned replacement for the old shell build's sed/perl meson hacks (#141):
  #  - AT_SYMLINK_NOFOLLOW probes false in the cross (has_header_symbol fails), so
  #    nix's working utimensat(AT_SYMLINK_NOFOLLOW) symlink-mtime path is #if'd
  #    out and nix THROWS on every symlink (nix-env profiles). Force it on.
  #  - close_range probes true (link test) but musl-wasm doesn't declare it; drop
  #    it so the wasm port's syscall(SYS_close_range) path is used.
  postPatch = ''
    UM=src/libutil/unix/meson.build
    substituteInPlace "$UM" \
      --replace-fail "cxx.has_header_symbol('fcntl.h', 'AT_SYMLINK_NOFOLLOW').to_int()" "1"
    ${pkgs.perl}/bin/perl -0777 -i -pe "s/\s*\[\s*'close_range',\s*'[^']*',\s*\],//s" "$UM"
  '';

  nativeBuildInputs = [
    pkgs.meson
    pkgs.ninja
    pkgs.pkg-config
    pkgs.python3
    llvm.clang-unwrapped
    bt
    pkgs.perl
    pkgs.bison # libexpr parser generator (native build tool)
    pkgs.flex # libexpr lexer generator (native build tool)
  ];

  # The meson setup-hook's configurePhase would run a NATIVE `meson setup build`
  # (aarch64/g++) before our cross buildPhase, failing on the wasm-only deps
  # (libblake3 not in the native pkgconfig path). Our buildPhase does the real
  # cross `meson setup build-wasm --cross-file …` itself, so disable the hook.
  dontUseMesonConfigure = true;

  buildPhase = ''
    runHook preBuild
    export WRAP="$PWD/.wrap"; mkdir -p "$WRAP/bin"

    # C++ wrapper: meson's link_whole uses `-r` (relocatable prelink) which must
    # NOT carry the dylink/shared-memory flags; drop them for `-r`. The non-`-r`
    # branch carries the full dylink link (used by our hand-link below).
    cat > "$WRAP/bin/wcxx" <<EOF
    #!${pkgs.runtimeShell}
    reloc=
    for a in "\$@"; do [ "\$a" = "-r" ] && reloc=1; done
    if [ -n "\$reloc" ]; then
      exec ${clangxx} ${cxxCommon} "\$@" -nostdlib++ -L${libcxx}/lib -lunwind -lc++abi ${cxxWarn}
    else
      exec ${clangxx} ${cxxCommon} "\$@" \
        -nostdlib++ -L${libcxx}/lib -lc++ -lc++abi -lunwind ${depLib} \
        -Wl,-shared -Wl,-Bsymbolic \
        -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296 \
        -Wl,--import-table -Wl,--allow-undefined-file=${allowUndefined} -Wl,--export=_start \
        -Wl,--export-if-defined=__wasm_apply_data_relocs -Wl,--export-if-defined=__wasm_call_ctors \
        -Wl,--export-if-defined=__set_tls_base -Wl,--export-if-defined=__libc_clone_callback \
        -Wl,--export-if-defined=__libc_handle_signal ${cxxWarn}
    fi
    EOF

    cat > "$WRAP/bin/wcc" <<EOF
    #!${pkgs.runtimeShell}
    exec ${clang} --target=wasm32-unknown-unknown -fPIC -resource-dir=${resourceDir} --sysroot=${sysroot} -isystem ${kernelHeaders}/include \
      -D__linux__ -D_GNU_SOURCE -matomics -mbulk-memory ${depDev} "\$@" \
      -Wl,-shared -Wl,-Bsymbolic -Wl,--no-entry -Wl,--export-all \
      -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296 \
      -Wl,--import-undefined -Wl,--import-table -Wl,--no-merge-data-segments \
      -Wl,--export-if-defined=__set_tls_base -Wl,--export-if-defined=__libc_handle_signal \
      ${depLib}
    EOF
    chmod +x "$WRAP/bin/wcxx" "$WRAP/bin/wcc"

    cat > "$WRAP/wasm32-cross.ini" <<EOF
    [binaries]
    c = '$WRAP/bin/wcc'
    cpp = '$WRAP/bin/wcxx'
    ar = '${bt}/bin/llvm-ar'
    strip = '${bt}/bin/llvm-strip'
    ranlib = '${bt}/bin/llvm-ranlib'
    pkg-config = '${pkgs.pkg-config}/bin/pkg-config'
    [host_machine]
    system = 'linux'
    cpu_family = 'wasm32'
    cpu = 'wasm32'
    endian = 'little'
    [properties]
    needs_exe_wrapper = true
    [built-in options]
    cpp_std = 'c++23'
    EOF

    export PKG_CONFIG_PATH="${pkgPath}"
    export PKG_CONFIG_LIBDIR="${pkgPath}"

    meson setup build-wasm --cross-file "$WRAP/wasm32-cross.ini" \
      -Dunit-tests=false -Ddoc-gen=false -Dbindings=false -Dbenchmarks=false \
      -Djson-schema-checks=false -Dlibexpr:gc=disabled \
      -Dlibstore:seccomp-sandboxing=disabled -Doptimization=2 -Ddebug=false

    # Compile every TU. The meson `-r` prelink steps fail (wasm TLS) — -k0 keeps
    # going past them; only the per-TU .o we collect below matter.
    ( cd build-wasm && ninja -k0 ) || true

    # Collect Nix's objects (libnix*.so.*.p + nix.p), excluding the C-API
    # bindings and meson prelink products.
    ( cd build-wasm && find src \
        \( -path '*/libnix*.so.*.p/*.o' -o -path '*/libnix*.a.p/*.o' -o -path 'src/nix/nix.p/*.o' \) \
        ! -path '*libnix*c.so.*' ! -name '*nix_api_*' ! -name '*prelink*' | sort ) > objs.txt
    nobj=$(wc -l < objs.txt)
    echo "linking $nobj objects → nix.wasm"
    [ "$nobj" -gt 250 ] || { echo "too few objects ($nobj) — compile failed"; exit 1; }

    ( cd build-wasm && "$WRAP/bin/wcxx" @../objs.txt ${depLib} \
        -lsqlite3 -lsodium -lbz2 -llzma -lz \
        -lbrotlienc -lbrotlidec -lbrotlicommon -larchive \
        -lcrypto -lssl -lblake3 -leditline -lboost_url \
        -lcurl -lgit2 -lpcre2-8 -lllhttp -lzstd ${builtins_a} \
        -o "$PWD/../nix.unstripped.wasm" )
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    ${bt}/bin/llvm-strip nix.unstripped.wasm -o $out/bin/nix
    # nix is a MULTI-CALL binary (it dispatches on argv[0]); the bootstrap used to
    # create these symlinks on /usr/bin → /opt/bin/nix. With the toolchain folded
    # into the system profile they ship in the package, so the profile bin/ carries
    # nix-env (the `nix-env -iA` acceptance path), nix-build, nix-store, etc.
    for t in nix-env nix-build nix-store nix-shell nix-instantiate nix-channel nix-collect-garbage; do
      ln -s nix "$out/bin/$t"
    done
    runHook postInstall
  '';

  dontFixup = true;
}
