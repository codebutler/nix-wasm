# Fork-capable executable tools in the host-crossed native wasm bootstrap.
#
# These packages run inside the software-MMU guest while building an uncached
# nixpkgs package. Their dependency edges must therefore resolve to the same
# fork/Asyncify variants as the explicit Bash and Make roots: for example,
# gettext propagates bash.dev and Perl depends on coreutils. Keeping the
# overrides in an overlay makes those transitive references coherent instead of
# publishing an adapted top-level output beside an unadapted dependency.
{ forkStdenv }:
final: prev:
let
  fork = forkStdenv.enableForkFor;

  # musl-wasm's setjmp is a no-op and its longjmp deliberately aborts. Bash
  # uses sigsetjmp/siglongjmp for ordinary parser/error control flow, so a
  # builder can start successfully and then die with SIGABRT as soon as that
  # path is exercised. Compile Bash with LLVM's wasm SjLj lowering and link the
  # same module-local WebAssembly EH runtime already proven by the guest ash.
  fixBashSjlj = p: p.overrideAttrs (o: {
    env = (o.env or { }) // {
      NIX_CFLAGS_COMPILE = (o.env.NIX_CFLAGS_COMPILE or "")
        + " -mllvm -wasm-enable-sjlj";
    };
    configureFlags = (o.configureFlags or [ ]) ++ [
      # LLVM's wasm SjLj pass lowers setjmp/longjmp. Do not let Bash's
      # cross-configure default select the sigsetjmp/siglongjmp wrappers,
      # which would bypass that lowering and reach musl's abort stub.
      "bash_cv_func_sigsetjmp=missing"
    ];
    postPatch = (o.postPatch or "") + ''
      cp ${../userspace/ash-wasm-sjlj.c} wasm_sjlj.c
      substituteInPlace Makefile.in \
        --replace-fail 'CSOURCES = shell.c' 'CSOURCES = wasm_sjlj.c shell.c' \
        --replace-fail $'OBJECTS\t = shell.o' $'OBJECTS\t = wasm_sjlj.o shell.o'
    '';
  });

  # clang's wasm entry ABI only synthesizes __main_argc_argv for the portable
  # two-argument main. GNU Make already has that form for Amiga and z/OS; reuse
  # it and source envp from environ for wasm rather than leaving musl's startup
  # bridge unresolved under the blanket fork-link exception.
  fixMakeMain = p: p.overrideAttrs (o: {
    postPatch = (o.postPatch or "") + ''
      substituteInPlace src/main.c \
        --replace-fail '#ifdef MK_OS_ZOS
extern char **environ;
#endif' \
                       '#if defined(MK_OS_ZOS) || defined(__wasm__)
extern char **environ;
#endif' \
        --replace-fail '#if defined(_AMIGA) || defined(MK_OS_ZOS)' \
                       '#if defined(_AMIGA) || defined(MK_OS_ZOS) || defined(__wasm__)' \
        --replace-fail '#ifdef MK_OS_ZOS
  char **envp = environ;
#endif' \
                       '#if defined(MK_OS_ZOS) || defined(__wasm__)
  char **envp = environ;
#endif'
    '';
  });

  # Perl needs narrow adaptations for perl-cross's ELF-only probes, the static
  # regex extension's private symbol namespace, and clang's wasm main ABI.
  fixPerlSeed = p: p.overrideAttrs (o: {
    patches = (o.patches or [ ]) ++ [
      ../patches/perl-cross-wasm-readelf.patch
      ../patches/perl-static-re-symbols.patch
      ../patches/perl-wasm-main-abi.patch
    ];
    # perl-cross's byte-order probe dumps ELF .data/.sdata sections. WebAssembly
    # has neither; wasm32 is unconditionally little-endian.
    configureFlags = (o.configureFlags or [ ]) ++ [
      "-Dbyteorder=1234"
      # The fork seam intentionally stays unavailable to configure link probes;
      # blanket --import-undefined would make every missing function look valid.
      # The final Perl link receives the seam libc and capture_stack import.
      "-Dd_fork=define"
    ];
    # perl-cross's nested configure driver is outside the generic configure
    # phase's shebang scan; keep the cross build hermetic instead of relying on
    # the build host to provide /bin/sh.
    postPatch = (o.postPatch or "") + ''
      patchShebangs cnf/configure
    '';
  });
in
if !(prev.stdenv.hostPlatform.isWasm or false) then
  { }
else
  {
    bash = fork (fixBashSjlj prev.bash);
    bashNonInteractive = fork (fixBashSjlj prev.bashNonInteractive);
    coreutils = fork prev.coreutils;
    findutils = fork prev.findutils;
    gnumake = fork (fixMakeMain prev.gnumake);
    gnutar = fork prev.gnutar;
    # libuuid is a selected output of util-linux; adapting it rebuilds and audits
    # every output of that multi-output derivation via wasm-fork-stdenv.
    libuuid = fork prev.libuuid;
    perl = fork (fixPerlSeed prev.perl);
  }
