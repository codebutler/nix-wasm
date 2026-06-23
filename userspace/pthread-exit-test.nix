# pthread-exit-test — regression test for detached-thread exit on wasm/NOMMU
# (the __unmapself / CRTJMP-abort crash fixed by patches/musl/0008). Statically
# linked so it runs from the initramfs. Run in guest: `pthread-exit-test`.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "pthread-exit-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 -pthread ${./pthread-exit-test.c} -o pthread-exit-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 pthread-exit-test $out/bin/pthread-exit-test
    runHook postInstall
  '';
  meta.description = "detached pthread exit (__unmapself) regression test, wasm32";
}
