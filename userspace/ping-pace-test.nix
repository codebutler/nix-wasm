# ping-pace-test — faithful no-network reproducer for issue #75 (busybox FANCY
# `ping` sends one packet then hangs). Mirrors busybox ping's exact pacing
# structure — a one-shot setitimer(ITIMER_REAL) re-armed from inside its own
# SIGALRM handler, with an async "echo host" thread so the main loop's blocking
# recv() is woken by I/O, re-blocks, and the NEXT one-shot timer must fire — the
# sequence sigalrm-test case 3 does NOT cover. No networking, so it runs from the
# initramfs in the busybox-only boot-smoke. Run in guest: `ping-pace-test`.
# See userspace/ping-pace-test.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "ping-pace-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 -pthread ${./ping-pace-test.c} -o ping-pace-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 ping-pace-test $out/bin/ping-pace-test
    runHook postInstall
  '';
  meta.description = "busybox-ping pacing reproducer: one-shot itimer re-armed in handler across I/O-woken recv (#75), wasm32";
}
