# .#wlclient — a minimal AF_UNIX test client for waylandproxyd (Wayland Phase 1
# 1c M3). Connects to $XDG_RUNTIME_DIR/wayland-0 and writes the first bytes a
# real libwayland client sends (wl_display.get_registry), proving the proxy
# accepts a connection and forwards the initial bytes to the host. NOT a real
# Wayland client (that is 1d). Single static wasm32-nommu binary; baked into the
# initramfs as /bin/wlclient. See userspace/wlclient.c.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
in
cross.stdenv.mkDerivation {
  pname = "wlclient-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} \
      ${./wlclient.c} -o wlclient
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp wlclient $out/bin/wlclient
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
