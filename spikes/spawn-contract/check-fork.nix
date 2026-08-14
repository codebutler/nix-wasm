{ cross, muslFork }:
# muslFork link-contract gate (P2-2, review of commit 99e7a73's __post_Fork TU
# split): asserts the asymmetry the split exists to preserve, against the
# FORK-CAPABLE libc (muslFork). The default libc is now the same fork-capable
# shape; this focused check remains as a direct regression gate for the seam.
#
# Reuses the same two probe .c files verbatim (uses-fork.c / uses-spawn.c).
# The cross cc-wrapper's default `-lc` still resolves to the DEFAULT musl
# (fork removed) — sysroot/wasm-cross.nix isn't swapped here, matching how
# every other muslFork consumer (forkStdenv, asyncify-cc.nix) opts in: prepend
# muslFork's libc.a to the link so it wins archive resolution for `fork`/
# `_Fork`/`vfork`, ahead of the default sysroot libc reached via clang's
# implicit trailing `-lc`.
#
# Expected outcome, and why:
#   spawn=LINKED   — posix_spawn.c pulls __clone from clone.o (musl's `main`
#                    TU split, patch 0000/commit 99e7a73's post_Fork.c): with
#                    __post_Fork living in its own TU, clone.o's two
#                    references to it no longer drag _Fork.lo (and hence its
#                    capture_stack import) along. If this regresses to
#                    FAILED, the split re-coupled and a plain spawn/thread
#                    link now pays the fork-capable tax it shouldn't.
#   fork=CAPTURE_STACK_UNDEFINED — uses-fork.c calls fork(), which muslFork
#                    DOES define (unlike the default musl); fork() calls
#                    _Fork(), which calls the capture_stack() host import.
#                    capture_stack is deliberately NOT in the shared
#                    --allow-undefined-file list (toolchain/wasm-host-imports.nix)
#                    and this probe is NOT asyncify-instrumented (no
#                    --import-undefined, no wasm-opt --asyncify pass — the
#                    two idioms that WOULD legitimately resolve it), so the
#                    link must fail specifically on "undefined symbol:
#                    capture_stack". A plain "fork() fails to link" (as if
#                    fork were absent, like the default variant) would be
#                    the WRONG failure — it would mean muslFork's fork() body
#                    never made it into the archive at all.
cross.stdenv.mkDerivation {
  name = "musl-fork-linkcheck";
  dontUnpack = true;
  # Prepend muslFork's libc.a so the linker resolves fork()/_Fork()/vfork()
  # from it explicitly ahead of the now-identical default sysroot libc — the
  # exact mechanism toolchain/wasm-fork-stdenv.nix's forkLib/enableForkFor use.
  NIX_LDFLAGS = "${muslFork}/lib/libc.a";
  buildPhase = ''
    mkdir -p $out
    : > $out/result
    if $CC ${./uses-fork.c} -o fork.wasm 2>fork.err; then
      echo "fork=LINKED" >> $out/result
    else
      grep -q "undefined symbol: capture_stack" fork.err \
        && echo "fork=CAPTURE_STACK_UNDEFINED" >> $out/result \
        || { echo "fork=OTHER_ERROR" >> $out/result; cat fork.err >> $out/result; }
    fi
    if $CC ${./uses-spawn.c} -o spawn.wasm 2>spawn.err; then
      echo "spawn=LINKED" >> $out/result
    else
      echo "spawn=FAILED" >> $out/result; cat spawn.err >> $out/result
    fi

    echo "== musl-fork-linkcheck result =="; cat $out/result
    # Enforce the contract — fail the build on any violation.
    grep -qx "fork=CAPTURE_STACK_UNDEFINED" $out/result || { echo "CONTRACT VIOLATION: a non-asyncified fork() must fail to link specifically on capture_stack (got: $(grep '^fork=' $out/result))" >&2; exit 1; }
    grep -qx "spawn=LINKED" $out/result || { echo "CONTRACT VIOLATION: posix_spawn() must link against muslFork too (got: $(grep '^spawn=' $out/result))" >&2; exit 1; }
  '';
  installPhase = "true";
}
