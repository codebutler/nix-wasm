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

  # perl-cross assumes GNU readelf's one-line ELF symbol table when deriving
  # target type sizes. LLVM's wasm readelf prints a structured symbol block,
  # so teach the cross configure probe to read its Size field.
  fixPerlReadelf = p: p.overrideAttrs (o: {
    patches = (o.patches or [ ]) ++ [ ../patches/perl-cross-wasm-readelf.patch ];
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
    bash = fork prev.bash;
    bashNonInteractive = fork prev.bashNonInteractive;
    coreutils = fork prev.coreutils;
    gnumake = fork (fixMakeMain prev.gnumake);
    # libuuid is a selected output of util-linux; adapting it rebuilds and audits
    # every output of that multi-output derivation via wasm-fork-stdenv.
    libuuid = fork prev.libuuid;
    perl = fork (fixPerlReadelf prev.perl);
  }
