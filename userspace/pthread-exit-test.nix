# pthread-exit-test — regression test for the two wasm musl memory accommodations:
# ramfs posix_fallocate emulation plus detached-thread __unmapself without the
# native CRTJMP stack switch. Statically linked into both initramfs variants.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "pthread-exit-test";
  version = "0.2.0";
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
  meta.description = "ramfs fallocate and detached pthread exit regression test, wasm32";
}
