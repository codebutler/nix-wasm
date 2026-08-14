# ninepd — guest-side READ-ONLY 9P2000.L file server for pc's /Linux mount
# (pc issue #472): the mirror image of the host→guest /mnt/yore mount. Connects
# OUT over AF_VSOCK to the host (VMADDR_CID_HOST = 2) on port 1025 — the /Ctl
# reverse-connection trick — and serves the guest rootfs; pc mounts it at
# /Linux (Filer browsing, the tray-menu app launcher's live .desktop reads).
# NOMMU-clean (no fork/threads), never serves /mnt/yore (the recursion guard).
# Statically linked so it runs from the initramfs (baked in via `extraBins`);
# started from inittab. See userspace/ninepd.c; interop-tested by
# runtime/ninep/ninepd-interop.test.js (the real binary vs the JS client).
{ cross }:
cross.stdenv.mkDerivation {
  pname = "ninepd";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./ninepd.c} -o ninepd
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 ninepd $out/bin/ninepd
    runHook postInstall
  '';
  meta.description = "read-only 9P2000.L rootfs server over AF_VSOCK for pc's /Linux mount, wasm32";
}
