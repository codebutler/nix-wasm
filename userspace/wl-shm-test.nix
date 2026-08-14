# .#wl-shm-test — issue #11 items-2/3 wl_shm-on-MMU exercise (item 5,
# waylandproxyd's mmap+copy resync, needs a real compositor boot and is NOT
# covered here — see the smoke's own header)
# (runtime/demo/node/wl-shm-mmu-smoke.mjs). Same recipe as wltest.nix — a
# plain cross.stdenv build, no fork/asyncify seam (this program never forks;
# it runs as an ordinary child under busybox-fork's shell). See
# wl-shm-test.c for the design.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
in
cross.stdenv.mkDerivation {
  pname = "wl-shm-test-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} \
      ${./wl-shm-test.c} -o wl-shm-test
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp wl-shm-test $out/bin/wl-shm-test
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;

  meta.description = "Exercises the virtio_wl NEW_ALLOC/anon-inode/SEND-fds wl_shm path (issue #11 items 2/3), wasm32";
}
