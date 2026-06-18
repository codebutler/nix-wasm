# Phase 0 kernel-primitive probes — small standalone C programs cross-built to
# the wasm32 guest. Each prints one `RESULT <name> PASS|FAIL …` line. The
# Makefile globs *.c, so adding a probe is just dropping a .c here.
{ cross, src }:
cross.stdenv.mkDerivation {
  pname = "phase0-tests";
  version = "0.1.0";
  inherit src;
  buildPhase = ''
    runHook preBuild
    make CFLAGS="-O2 -Wall -Wextra -Wno-unused-parameter"
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    for c in *.c; do
      b="''${c%.c}"
      install -Dm755 "$b" "$out/bin/$b"
    done
    runHook postInstall
  '';
  meta.description = "Phase 0 kernel-primitive probes (wasm guest)";
}
