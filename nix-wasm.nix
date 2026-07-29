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
# realFork (#175): OFF by default → the shipped NOMMU guest's nix.wasm (clone-
# vfork spawn, sysroot musl, no asyncify — byte-identical to before, so cross.*
# and the default squashfs stay cached). ON → the software-MMU fork variant
# (.#nix-wasm-fork): upstream startProcess `fork()` (WASM_REAL_FORK defines out
# the CLONE_VM|CLONE_VFORK hack that SIGSEGV'd under the software MMU), linked
# against muslFork's asyncify _Fork seam + a whole-module wasm-opt --asyncify.
{ pkgs, cross, sysroot, kernelHeaders, libcxx, compilerRt, nixSrc
, muslFork, binaryen ? pkgs.buildPackages.binaryen, realFork ? false }:
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
  #
  # The fork variant (realFork, #175) takes upstream startProcess's `fork()` path,
  # provided by muslFork's asyncify seam (_Fork → capture_stack), so `capture_stack`
  # must be an allowed undefined import — the ONE host symbol the seam adds. We
  # extend the SHARED list LOCALLY rather than editing the shared file (which is
  # baked into the cross cc-wrapper's store path → adding it there would force a
  # full cross.* world rebuild for a symbol nix.wasm alone needs, per that file's
  # header note). The DEFAULT build uses the shared list verbatim (byte-identical
  # to before → stays cached). Every other undefined stays a loud link error.
  allowUndefinedBase = import ./toolchain/wasm-host-imports.nix { inherit pkgs; };
  allowUndefined =
    if realFork then
      pkgs.runCommand "nix-wasm-allow-undefined.txt" { } ''
        cp ${allowUndefinedBase} $out
        chmod +w $out
        echo capture_stack >> $out
      ''
    else allowUndefinedBase;

  # #175: the BOUNDED asyncify addlist — the fork call graph, NOT the whole module.
  # Whole-module asyncify (the busybox-fork recipe) 2.9x'd nix.wasm (20.7→59.5MB) and
  # the engine's per-exec softmmu instrumentation of that module needed ~2.4x the
  # memory (1.36GB spike + an 402MB output + an 816MB V8 compile), OOM-killing the
  # boot (exit 137) even on a large runner. Bounding the instrumented set to the fork
  # call graph keeps nix.wasm ~its default size (lab-measured: a ~100-fn set is
  # byte-equivalent to the un-asyncified baseline through the softmmu pass).
  #
  # Mechanics (binaryen v129, verified against Asyncify.cpp):
  # - `asyncify-imports@env.capture_stack` alone bounds NOTHING: without
  #   ignore-indirect, any function containing a call_indirect is conservatively
  #   state-changing -> whole module (nix's C++ virtuals are everywhere).
  # - `asyncify-ignore-indirect` + this ADDLIST: instrumented = the listed functions
  #   plus (via asyncify-propagate-addlist) their transitive DIRECT callers.
  # - THE RULE for what must be listed EXPLICITLY: propagation never crosses an
  #   indirect edge, and only EXPLICITLY-listed functions get unwind support at
  #   their INDIRECT call sites (addedFromList). So every frame whose call toward
  #   capture_stack is indirect — virtual dispatch, std::function, fn pointers,
  #   coroutine resume, and _Fork itself (its call to the capture_stack IMPORT is
  #   GOT-indirect in this PIC dylink model) — must appear below. Purely-direct
  #   segments (fork→_Fork, startProcess→doFork→fork, Worker::run→Goal::work,
  #   Store::buildPaths→Worker::run) ride propagation.
  # - The live fork-time stacks (nix 2.34.7): [build] main → handleExceptions
  #   →(std::function) mainWrapped →(fun<>) main_nix_build →(lambda→virtual)
  #   Store::buildPaths → Worker::run → Goal::work →(coroutine resume) the
  #   DerivationBuildingGoal coroutine clones → DerivationBuilderImpl::startBuild
  #   →(virtual) startChild → startProcess → fork; [nix-env -iA] ... main_nix_env
  #   →(fn-ptr Operation) opInstall → createUserEnv →(virtual) buildPaths → same;
  #   [hook] ...tryHookLoop → tryBuildHook → HookInstance ctor → startProcess.
  #   The goal layer is C++20 coroutines whose CoroSplit clones carry compiler-
  #   generated names -> matched by CLASS-PREFIX WILDCARDS, not exact names.
  # - Entries are wasm name-section names. wasm-ld usually emits DEMANGLED names
  #   (--demangle default); the list carries BOTH demangled and mangled forms
  #   (unmatched entries are a non-fatal binaryen warning; the build gates on the
  #   instrumented-set size below, so a silent total mismatch fails loudly).
  # - The std::function machinery IS listed (nix::fun<> + libc++'s function/
  #   __function templates, instantiated into nix's own TUs): the first bring-up
  #   boot proved -O2 does NOT inline the __func<...>::operator() layer — the
  #   asyncify-asserts trap fired with only 9 live frames, i.e. the unwind
  #   traversed the WHOLE deep build stack (coroutine clones, startBuild,
  #   startProcess — all correctly instrumented) and died 8 frames from the top;
  #   the round-2 SYMBOLIZED trace named the frame exactly:
  #   std::__1::__function::__func<int (*)(int, char**), void (int, char**)>::
  #   operator() — mainWrapped's legacy dispatch, as the frame arithmetic
  #   predicted. NOTE the ABI namespace: this toolchain's nix-built libc++ is
  #   std::__1 (the LLVM default), NOT emscripten's std::__2 — round 2 listed
  #   __2 forms and matched nothing (the same trap persisted; caught by the
  #   symbolized trace). The propagation sweep from these entries (every direct
  #   std::function caller) is bounded by the size gate below.
  #   coroutine_handle::resume glue stays unlisted — the bring-up boots proved
  #   it inlines (the goal layer unwound fine).
  forkAddlist = pkgs.writeText "nix-fork-asyncify-addlist.txt" ''
    _Fork
    fork
    vfork
    *doFork*
    _start
    _start_c
    __libc_start_main
    libc_start_main_stage2
    main
    __main_argc_argv
    __main_void
    nix::startProcess*
    _ZN3nix12startProcess*
    nix::runProgram*
    _ZN3nix10runProgram*
    _ZN3nix11runProgram2*
    nix::killUser*
    _ZN3nix8killUser*
    nix::RunPager::*
    _ZN3nix8RunPagerC*
    nix::handleExceptions*
    _ZN3nix16handleExceptions*
    nix::mainWrapped*
    _ZN3nix11mainWrapped*
    *main_nix_build*
    *main_nix_env*
    nix::createUserEnv*
    _ZN3nix13createUserEnv*
    nix::Installable::build2*
    _ZN3nix11Installable6build2*
    nix::Store::buildPaths*
    _ZN3nix5Store10buildPaths*
    nix::Worker::*
    _ZN3nix6Worker*
    nix::Goal::*
    _ZN3nix4Goal*
    _ZZN3nix4Goal*
    *DerivationBuildingGoal*
    *DerivationBuilderImpl*
    *ChrootLinuxDerivationBuilder*
    *ExternalDerivationBuilder*
    nix::HookInstance::*
    _ZN3nix12HookInstance*
    nix::fun<*
    _ZN3nix3funI*
    _ZNK3nix3funI*
    std::__1::function<*
    std::__1::__function::*
  '';

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
    + " -nostdinc++ -isystem ${libcxx}/include/c++/v1 ${depDev}"
    # toml11 is HEADER-ONLY and architecture-independent, so the native
    # `pkgs.toml11` headers work for the wasm target — no cross-build needed. The
    # wasm port patch replaces libexpr's `dependency('toml11', method:'cmake')`
    # (which needs a `cmake` + the toml11 CMake package we don't have in the cross
    # sandbox) with an empty `declare_dependency(version:'4.4.0')`, so `<toml.hpp>`
    # must come from here instead. WITHOUT this, `fromTOML.cc` fails to compile,
    # `ninja -k0` silently drops the TU, and `builtins.fromTOML` is MISSING from
    # nix.wasm — which makes nixpkgs' own `lib` (lib/trivial.nix references the
    # `fromTOML` global) unevaluable, i.e. NO nixpkgs package can be evaluated
    # in-guest. The version pinned in the patch matches `pkgs.toml11` (4.4.0) so
    # libexpr's `HAVE_TOML11_4` selects the v4 toml11 API path in fromTOML.cc.
    + " -isystem ${pkgs.toml11}/include"
    # #175: in the fork variant, define out the wasm32-port patch's
    # CLONE_VM|CLONE_VFORK spawn hack so startProcess uses upstream `fork()`.
    + lib.optionalString realFork " -DWASM_REAL_FORK";
  cxxWarn = "-Wno-error -Wno-error=suggest-override -Wno-error=switch -Wno-error=switch-enum"
    + " -Wno-error=undef -Wno-error=unused-result -Wno-error=sign-compare -Wno-error=return-type"
    + " -Wno-error=non-virtual-dtor -Wno-error=c99-designator";
in
pkgs.stdenv.mkDerivation {
  pname = "nix-wasm" + lib.optionalString realFork "-fork";
  version = "2.34.7";
  src = nixSrc;

  patches = [ ./patches/nix-2.34.7-wasm32-port.patch ];

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
  ] ++ lib.optional realFork binaryen; # wasm-opt --asyncify for the real-fork seam (#175)

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
        -Wl,--export-if-defined=__wasm_early_tp_init \
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

    # Fork variant only (#175): muslFork's libc.a FIRST (before the sysroot's
    # implicit -lc), so its asyncify-seam _Fork() — which unwinds through the
    # capture_stack host import to return twice (runtime/asyncify.js) — overrides
    # the sysroot musl's clone-syscall _Fork. Every other archive member is
    # byte-identical to the sysroot's, so no ODR risk (same rule as
    # userspace/busybox-fork.nix). This is what makes nix's upstream startProcess
    # `else pid = fork();` path work on the software-MMU guest. The DEFAULT build
    # links the sysroot musl only (no fork symbol) — a stray fork would fail the
    # link, preserving the NOMMU no-fork contract.
    ( cd build-wasm && "$WRAP/bin/wcxx" @../objs.txt ${lib.optionalString realFork "${muslFork}/lib/libc.a "}${depLib} \
        -lsqlite3 -lsodium -lbz2 -llzma -lz \
        -lbrotlienc -lbrotlidec -lbrotlicommon -larchive \
        -lcrypto -lssl -lblake3 -leditline -lboost_url \
        -lcurl -lgit2 -lpcre2-8 -lllhttp -lzstd ${builtins_a} \
        -o "$PWD/../nix.unstripped.wasm" )
    ${lib.optionalString realFork ''
      # BOUNDED asyncify for the fork seam (#175 — see the forkAddlist comment for
      # the full design). env.capture_stack is the unwind import; the instrumented
      # set = the fork call graph (addlist + direct-caller propagation) under
      # asyncify-ignore-indirect, NOT the whole module (which 2.9x'd the binary and
      # OOM'd the engine's per-exec softmmu instrumentation). The full wasm feature
      # set must be enabled so the pass preserves the dylink module's threads/
      # bulk-memory/reference-types shape. --optimize-level/--shrink-level gate
      # asyncify's INTERNAL, instrumented-functions-only optimization (no module-
      # wide passes are scheduled) — without them the flattened instrumented code
      # is left uncoalesced. -g keeps the name section (llvm-strip in installPhase
      # still strips the shipped binary). asyncify-asserts was BRING-UP ONLY (it
      # turned an unwind crossing an uninstrumented frame — a missing addlist entry
      # — into a deterministic trap instead of silent rewind corruption); it is
      # DROPPED now that the fork gates are stably green (smoke.mjs / selftests /
      # build-from-source BUILD1+BUILD2 all pass — the addlist has converged over
      # the real deep-fork stacks). The size + decision-count gates below stay as
      # the standing guard that the addlist keeps matching. (The -lg CI runner is
      # KEPT: the softmmu-instrumented + asyncified fork nix.wasm is the heaviest
      # boot artifact — genuinely larger than the NOMMU nix.wasm the -default jobs
      # load — not a bring-up crutch.) Runs BEFORE the strip in installPhase (list
      # matching needs the names).
      echo "[nix-wasm] bounded asyncify $(wc -c < nix.unstripped.wasm) bytes ..."
      wasm-opt \
        --enable-threads --enable-bulk-memory --enable-mutable-globals \
        --enable-nontrapping-float-to-int --enable-sign-ext \
        --enable-reference-types --enable-multivalue \
        --optimize-level=2 --shrink-level=1 -g \
        --asyncify \
        --pass-arg=asyncify-imports@env.capture_stack \
        --pass-arg=asyncify-ignore-indirect \
        --pass-arg=asyncify-addlist@@${forkAddlist} \
        --pass-arg=asyncify-propagate-addlist \
        --pass-arg=asyncify-verbose \
        nix.unstripped.wasm -o nix.unstripped.wasm.fork > asyncify-verbose.log
      # Gate on the instrumented-set size: too few decisions means the addlist
      # didn't match the name section (e.g. names absent/differently mangled) and
      # the fork seam would corrupt at runtime — fail the BUILD instead. Too many
      # means the bound didn't hold (approaching whole-module again).
      n=$(grep -c '^\[asyncify\]' asyncify-verbose.log || true)
      echo "[nix-wasm] asyncify decisions: $n (log tail:)"
      tail -20 asyncify-verbose.log
      [ "$n" -ge 100 ] || { echo "ERROR: bounded asyncify matched too little ($n) — addlist/name-section mismatch"; exit 1; }
      [ "$n" -le 60000 ] || { echo "ERROR: bounded asyncify swept too much ($n) — bound failed"; exit 1; }
      grep -q '_Fork' asyncify-verbose.log || { echo "ERROR: seed _Fork not in the instrumented set"; exit 1; }
      # The size gate is the REAL bound (softmmu instrument memory tracks module
      # size): whole-module asyncify was 59.5MB; the bounded set must stay well
      # under (default is 20.7MB; asserts add module-wide call checks).
      sz=$(wc -c < nix.unstripped.wasm.fork)
      [ "$sz" -le 36700160 ] || { echo "ERROR: asyncified module $sz bytes > 35MB — the bound failed (approaching whole-module)"; exit 1; }
      mv nix.unstripped.wasm.fork nix.unstripped.wasm
      # wasm-opt's `-o` output is 0644 — restore +x (mirrors busybox-fork.nix) so
      # llvm-strip (which preserves the input mode) ships an EXECUTABLE $out/bin/nix.
      # Without this the guest's `nix-env` exec fails EACCES ("Permission denied").
      chmod +x nix.unstripped.wasm
      echo "[nix-wasm] asyncified -> $(wc -c < nix.unstripped.wasm) bytes"
    ''}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    ${
      if realFork then ''
        # Fork variant (#175): ship UNSTRIPPED — the name section survives the
        # engine's softmmu instrumentation (custom sections pass through, no
        # imports are added, so function indices are stable), which makes every
        # V8 wasm stack trace in the MMU boot smokes SYMBOLIZED. During the
        # asyncify-asserts bring-up that turns "unreachable at wasm-function[N]"
        # into the exact frame name to add to the addlist. A few MB of names in
        # a CI-only artifact; the shipped NOMMU guest keeps the stripped build.
        cp nix.unstripped.wasm $out/bin/nix
        # The instrumented-set log, for offline addlist iteration (which
        # patterns matched, why each function was swept in).
        cp asyncify-verbose.log $out/asyncify-verbose.log
      '' else ''
        ${bt}/bin/llvm-strip nix.unstripped.wasm -o $out/bin/nix
      ''
    }
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
