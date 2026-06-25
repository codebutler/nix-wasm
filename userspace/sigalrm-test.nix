# sigalrm-test — regression test for async SIGALRM / setitimer(ITIMER_REAL)
# delivery on the wasm/NOMMU guest (issue #35). Statically linked so it runs
# from the initramfs. Run in guest: `sigalrm-test`. See userspace/sigalrm-test.c.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "sigalrm-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./sigalrm-test.c} -o sigalrm-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 sigalrm-test $out/bin/sigalrm-test
    runHook postInstall
  '';
  meta.description = "async SIGALRM / setitimer(ITIMER_REAL) delivery regression test, wasm32";
}
