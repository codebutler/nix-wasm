{ cross }:
cross.stdenv.mkDerivation {
  name = "nofork-linkcheck";
  dontUnpack = true;
  buildPhase = ''
    res() { echo "$1" >> $out; }
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
  '';
  installPhase = "true";
}
