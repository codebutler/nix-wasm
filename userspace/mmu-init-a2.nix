# mmu-init-a2 — demand-paging PID-1 for the A2 software-MMU smoke (#128).
# Statically linked; the smoke instruments it with softmmu-pass CHECKED mode
# and boots it under the A2 kernel (.#kernel-mmu-a2, VM_LOCKED dropped).
{ cross }:
cross.stdenv.mkDerivation {
  pname = "mmu-init-a2";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./mmu-init-a2.c} -o mmu-init-a2
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 mmu-init-a2 $out/bin/mmu-init-a2
    runHook postInstall
  '';
  meta.description = "demand-paging PID-1 for the A2 software-MMU smoke (#128), wasm32";
}
