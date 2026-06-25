# wl-pool-churn — virtwl shm alloc/free stress test (Task 10 / issue #7).
# Creates and destroys N wl_shm_pools through Sommelier, asserting guest MemFree
# stays bounded (i.e. no kernel-side shm leak per pool). Baked into the initramfs
# as /bin/wl-pool-churn. Modeled on userspace/wlhandshake.nix.
{ pkgs, cross }:
let
  wayland = cross.wayland;
  libffi  = cross.libffi;
in
cross.stdenv.mkDerivation {
  pname = "wl-pool-churn";
  version = "0.1.0";

  dontUnpack = true;

  buildInputs = [ wayland.dev libffi.dev ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    $CC ${./wl-pool-churn.c} -o wl-pool-churn -lwayland-client -lffi
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 wl-pool-churn $out/bin/wl-pool-churn
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;

  meta.description = "virtwl wl_shm pool alloc/free churn test (Sommelier leak regression), wasm32";
}
