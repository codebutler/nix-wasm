# yorectl — guest-side agent for pc's /Ctl desktop-control bridge over AF_VSOCK
# (issue #60 Phase 2 / nix-wasm#10 option 3). A tiny CLI that connects to the
# host (VMADDR_CID_HOST = 2) on the well-known /Ctl vsock port and speaks the
# length-prefixed open/notify/clipget/clipset protocol — the standard-socket
# replacement for the bespoke 9P `/Ctl` mount. Statically linked so it runs from
# the initramfs (baked in via `extraBins`). Run in guest: `yorectl open calc`.
# See userspace/yorectl.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "yorectl";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./yorectl.c} -o yorectl
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 yorectl $out/bin/yorectl
    runHook postInstall
  '';
  meta.description = "guest agent for pc's /Ctl desktop-control bridge over AF_VSOCK, wasm32";
}
