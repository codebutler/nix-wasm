# .#wlhandshake — the STOCK-libwayland registry-handshake client (Wayland Phase 1
# 1d, M2 — the Phase 1 deliverable). Links the cross-built libwayland-client (and
# libffi, the wl_closure_invoke→ffi_call backend) and runs the canonical client
# API (wl_display_connect → get_registry → roundtrip → enumerate globals →
# disconnect) THROUGH waylandproxyd, exercising the whole transport stack
# end-to-end. Single static wasm32-nommu binary; baked into the initramfs as
# /bin/wlhandshake. See userspace/wlhandshake.c.
#
# Built with the SAME `cross` stdenv as the wayland/libffi libraries (matching the
# 1c wayland-client link-check), not the busybox NOMMU cc-wrapper — the client
# never forks, so the plain cross cc is correct and links the static libs cleanly.
{ pkgs, cross }:
let
  wayland = cross.wayland;
  libffi = cross.libffi;
in
cross.stdenv.mkDerivation {
  pname = "wlhandshake-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  # wayland.dev carries wayland-client.h + the static libwayland-client.a;
  # libffi.dev carries the static libffi.a (raw wasm backend, per deps-overlay).
  buildInputs = [ wayland.dev libffi.dev ];

  buildPhase = ''
    runHook preBuild
    # $CC is the cross cc-wrapper; buildInputs put the wayland/ffi -I and -L on
    # the search path. Static libs, so the link is fully resolved in-binary.
    $CC ${./wlhandshake.c} -o wlhandshake -lwayland-client -lffi
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp wlhandshake $out/bin/wlhandshake
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
