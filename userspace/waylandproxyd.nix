# .#waylandproxyd — the thin guest-side Wayland↔virtwl bridge (Wayland Phase 1
# 1c, the Sommelier pivot). Opens /dev/wl0, establishes a virtwl ctx, listens on
# $XDG_RUNTIME_DIR/wayland-0 for local guest Wayland clients, and splices the
# wire protocol (bytes + SCM_RIGHTS fds) between the client socket and the virtwl
# ctx — converting client shm fds into virtwl vfds the host can access.
#
# Raw AF_UNIX + poll(); does NOT link libwayland (it would impose its event-loop
# / object model for no benefit — the proxy only moves bytes + fds verbatim).
# Single static binary, no fork/exec (NOMMU). Cross-compiled with the SAME
# wasm32-nommu cc-wrapper as busybox/wltest; added to the initramfs as
# /bin/waylandproxyd. See userspace/waylandproxyd.c for the full design.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
in
cross.stdenv.mkDerivation {
  pname = "waylandproxyd-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} \
      ${./waylandproxyd.c} -o waylandproxyd
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp waylandproxyd $out/bin/waylandproxyd
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
