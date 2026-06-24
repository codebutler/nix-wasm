{ cross }:
# Clean-NOMMU spawn-contract gate: compiles a fork() user and a posix_spawn() user
# through the cross cc-wrapper and ASSERTS the contract — fork must be ABSENT (the
# linker reports `undefined symbol: fork`) and posix_spawn must LINK. The outcome is
# recorded in $out/result for diagnostics AND the build FAILS if the contract is
# violated, so `nix build .#nofork-linkcheck` is a real regression gate, not a passive
# report.
cross.stdenv.mkDerivation {
  name = "nofork-linkcheck";
  dontUnpack = true;
  buildPhase = ''
    mkdir -p $out
    : > $out/result
    if $CC ${./uses-fork.c} -o fork.wasm 2>fork.err; then
      echo "fork=LINKED" >> $out/result
    else
      grep -q "undefined symbol: fork" fork.err \
        && echo "fork=ABSENT" >> $out/result \
        || { echo "fork=OTHER_ERROR" >> $out/result; cat fork.err >> $out/result; }
    fi
    if $CC ${./uses-spawn.c} -o spawn.wasm 2>spawn.err; then
      echo "spawn=LINKED" >> $out/result
    else
      echo "spawn=FAILED" >> $out/result; cat spawn.err >> $out/result
    fi

    echo "== nofork-linkcheck result =="; cat $out/result
    # Enforce the contract — fail the build on any violation.
    grep -qx "fork=ABSENT"  $out/result || { echo "CONTRACT VIOLATION: fork() must be absent (got: $(grep '^fork=' $out/result))" >&2; exit 1; }
    grep -qx "spawn=LINKED" $out/result || { echo "CONTRACT VIOLATION: posix_spawn() must link (got: $(grep '^spawn=' $out/result))" >&2; exit 1; }
  '';
  installPhase = "true";
}
