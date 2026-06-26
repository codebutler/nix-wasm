# kill-wake-test — diagnostic reproducer for issue #35's `timeout 2 sleep 10`
# hang, reduced to a standalone C program (cross-process kill() waking a
# syscall-blocked task) with no busybox and no networking. Statically linked so
# it runs from the initramfs. Run in guest: `kill-wake-test`. See
# userspace/kill-wake-test.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "kill-wake-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./kill-wake-test.c} -o kill-wake-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 kill-wake-test $out/bin/kill-wake-test
    runHook postInstall
  '';
  meta.description = "cross-process kill() async-signal wake regression test (#35), wasm32";
}
