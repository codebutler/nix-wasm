# mmu-init — minimal instrumented PID-1 for the software-MMU smoke (#128).
# Statically linked; the smoke instruments it with runtime/softmmu-pass.js and
# packs it as the sole /init of a custom initramfs booted under the
# CONFIG_MMU=y kernel. See userspace/mmu-init.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "mmu-init";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./mmu-init.c} -o mmu-init
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 mmu-init $out/bin/mmu-init
    runHook postInstall
  '';
  meta.description = "minimal PID-1 for the software-MMU smoke (#128), wasm32";
}
