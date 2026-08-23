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
in
{
  bash = fork prev.bash;
  bashNonInteractive = fork prev.bashNonInteractive;
  coreutils = fork prev.coreutils;
  gnumake = fork (fixMakeMain prev.gnumake);
  # libuuid is a selected output of util-linux; adapting it rebuilds and audits
  # every output of that multi-output derivation via wasm-fork-stdenv.
  libuuid = fork prev.libuuid;
  perl = fork prev.perl;
}
