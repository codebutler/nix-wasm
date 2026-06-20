# .#isolation-probe — the Task 2.4 cross-process isolation probe (acceptance B1).
# Two tiny static wasm32-nommu binaries, cross-compiled with the SAME cc-wrapper
# as busybox and baked into the initramfs as /bin/isoa and /bin/isob:
#   isoa — writes a sentinel at an mmap'd page, prints its ABSOLUTE linear address
#          (runtime-chosen), then pauses (stays alive).
#   isob — given that exact address, maps it in ITS OWN address space and reads
#          it back: PASS (its own zero page, per-process memory) vs LEAK (shared).
# See userspace/isoa.c + isob.c and runtime/node/task2.4-isolation.test.mjs for
# the discrimination argument.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
in
cross.stdenv.mkDerivation {
  pname = "isolation-probe-wasm32-nommu";
  version = "0.1";

  dontUnpack = true;

  buildPhase = ''
    runHook preBuild
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} ${./isoa.c} -o isoa
    ${p}cc -O2 -isystem ${busyboxKernelHeaders} ${./isob.c} -o isob
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp isoa isob $out/bin/
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
