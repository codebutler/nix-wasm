# ping-pace-probe — localizer for issue #75. argv[1] selects a case:
#   control — one-shot ITIMER_REAL must interrupt a single traffic-less recv
#             (= sigalrm-test case 3; baseline that must PASS).
#   xcpu    — a pending one-shot must fire after a cross-CPU reply wakes recv and
#             recv RE-BLOCKS (no handler re-arm) — isolates the bug from ping's
#             handler re-arm.
#   repro   — the full busybox-ping shape (one-shot re-armed in the handler).
# No networking; runs from the initramfs. See userspace/ping-pace-probe.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "ping-pace-probe";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 -pthread ${./ping-pace-probe.c} -o ping-pace-probe
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 ping-pace-probe $out/bin/ping-pace-probe
    runHook postInstall
  '';
  meta.description = "issue #75 localizer: control / cross-cpu one-shot / full repro, wasm32";
}
