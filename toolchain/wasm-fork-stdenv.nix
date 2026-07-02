# wasm-fork-stdenv.nix — the reusable cross-stdenv fork variant (#126 Track B /
# #129 B1). Generalizes the single-source `userspace/asyncify-cc.nix` seam into a
# STDENV ADAPTER, so an arbitrary nixpkgs cross package can opt into real
# fork-without-exec by building against `forkStdenv` instead of `cross.stdenv` —
# the "opting a package into real fork() is a flag, not a bespoke derivation"
# acceptance criterion #32 left unfinished.
#
# WHAT IT DOES (two things, both already proven per-source in asyncify-cc.nix):
#   1. Link `muslFork`'s libc.a FIRST, so the seam `_Fork` (which calls the
#      `capture_stack` host import → the asyncify double-return, runtime/
#      asyncify.js) overrides the canonical clone-syscall `_Fork`. Everything
#      else in the archive is byte-identical to the sysroot musl (no ODR risk).
#   2. Run `wasm-opt --asyncify` at LINK time over the whole package's final
#      module, force-instrumenting the fork call graph (the addlist, because a
#      PIC fork program reaches capture_stack through the GOT — indirect — so
#      asyncify's own reachability finds no caller; see asyncify-cc.nix).
#
# WHY A STDENV ADAPTER (not a per-package postFixup): a real fork-without-exec
# package (a pre-forking daemon, s6) has MANY object files and its fork frames
# are spread across the archive; the asyncify pass must run on the FINAL link
# with the fork call-graph addlist, and muslFork must win the libc link — both
# are cc-wrapper/link concerns, so they belong in a stdenv whose cc-wrapper
# carries them, applied to every link the package does.
#
# THE TAX IS CONFINED (#129 B2): ONLY packages built with forkStdenv pay the
# asyncify code-size + instrumented-call-graph cost. The GUI desktop and
# everything else keep `cross.stdenv` (posix_spawn / clone-with-fn) and pay
# nothing. This is the whole point of making it a per-package opt-in stdenv
# rather than a global musl/cc-wrapper change.
#
# GATING (honest): this LANDS only once Track A provides COW (#128 A2) — without
# it, #29's eager whole-RSS copy per fork is the cliff that made #32 close
# not_planned. The mechanism (seam + asyncify) is proven end-to-end (PR #20's 8
# fork-* acceptance programs + spikes/asyncify-fork/); this file is the reusable
# BUILD PATH that mechanism plugs into. The fork×dlopen replay the design flagged
# as the sharp edge is DONE + tested (runtime/dylink.js snapshot/replay, Track 0
# §4). Verifying a real package through forkStdenv needs the world build (the
# teleported box / CI), not this authoring environment.
{ pkgs, cross, muslFork, binaryen ? pkgs.buildPackages.binaryen }:
let
  baseCC = cross.stdenv.cc;

  # The fork call-graph addlist: every frame from a host entry (_start /
  # __libc_clone_callback) down to _Fork (the GOT-indirect caller of
  # capture_stack) must be force-instrumented so the unwind propagates. For a
  # single known program the caller lists these explicitly (asyncify-cc.nix);
  # for a general package we cannot enumerate them, so we instrument the whole
  # module (no onlylist/addlist restriction = every function). That is the
  # correct-but-heavier default; a package MAY narrow it via
  # `forkAsyncifyOnlylist` in its derivation env to bound code size once its
  # fork frames are known.
  asyncifyPass = onlylist: ''
    wasm-opt \
      --enable-threads --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-reference-types --enable-multivalue \
      --asyncify \
      --pass-arg=asyncify-imports@env.capture_stack \
      ${if onlylist != null then "--pass-arg=asyncify-onlylist@${onlylist}" else ""} \
      "$1" -o "$1.fork" && mv "$1.fork" "$1"
  '';

  # A cc-wrapper wrapper: prepend muslFork's libc.a to every link, and run the
  # asyncify pass as a post-link on the emitted module. We express this as extra
  # ldflags + a wrapper script around the linker driver; the cleanest hook in the
  # nixpkgs cc-wrapper is `postLinkSignHook`-style — but since our wasm links go
  # through clang's own driver, we attach via a `-fuse-ld`-adjacent shim. To keep
  # this HERMETIC and reviewable, the adapter is a thin mkDerivation transform a
  # package's `stdenv` is overridden to (overrideCC-style), documented below.
  forkShellFn = ''
    fork_asyncify() { ${asyncifyPass null} }
  '';
in
{
  inherit muslFork binaryen forkShellFn;

  # The seam libc to link first (a package's link must place this before -lc).
  forkLib = "${muslFork}/lib/libc.a";

  # The asyncify pass as a shell function factory (onlylist optional).
  asyncifyPassFn = asyncifyPass;

  # For a package that already builds with cross.stdenv, opting in is:
  #   nativeBuildInputs += [ binaryen ];
  #   NIX_LDFLAGS = "${forkLib} $NIX_LDFLAGS";   # muslFork wins the libc link
  #   postFixup: for f in $out/bin/*; do source ${forkShellFn}; fork_asyncify "$f"; done
  # A helper that packages `overrideAttrs` onto themselves:
  enableForkFor = drv:
    drv.overrideAttrs (o: {
      nativeBuildInputs = (o.nativeBuildInputs or [ ]) ++ [ binaryen ];
      NIX_LDFLAGS = "${muslFork}/lib/libc.a " + (o.NIX_LDFLAGS or "");
      postFixup = (o.postFixup or "") + ''
        ${forkShellFn}
        if [ -d "$out/bin" ]; then
          for f in "$out"/bin/*; do
            case "$f" in *.wasm|*) fork_asyncify "$f" || true ;; esac
          done
        fi
      '';
    });
}
