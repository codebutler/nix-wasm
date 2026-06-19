# .#wltest — the /dev/wl0 userspace round-trip self-test (Wayland Phase 1 1b M3).
# A tiny static guest binary that open()s /dev/wl0 and issues VIRTWL_IOCTL_NEW,
# proving the userspace -> virtio_wl -> virtio_wasm transport -> JS wl device
# round-trip. Cross-compiled with the SAME wasm32-nommu cc-wrapper as busybox;
# linked as a dylink executable the kernel's exec ABI can run. Added to the
# initramfs as /bin/wltest.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
in
cross.stdenv.mkDerivation {
  pname = "wltest-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} \
      ${./wltest.c} -o wltest
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp wltest $out/bin/wltest
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
