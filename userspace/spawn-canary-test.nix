# spawn-canary-test — reduced reproducer for the posix_spawn() parent
# static-memory corruption found while debugging Xvfb's xkbcomp spawn
# (worker #6, xchat-irc-setup epic). A LARGE patterned static (.bss) array
# (SPAWN_CANARY_MB, default 8) + a same-size heap buffer are filled, a
# trivial self-exec'd child is posix_spawn()ed, and both buffers are
# rescanned for corruption after waitpid — see userspace/spawn-canary-test.c.
{ cross, canaryMb ? 16 }:
cross.stdenv.mkDerivation {
  pname = "spawn-canary-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 -DSPAWN_CANARY_MB=${toString canaryMb} ${./spawn-canary-test.c} -o spawn-canary-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 spawn-canary-test $out/bin/spawn-canary-test
    runHook postInstall
  '';
  meta.description = "posix_spawn() parent-static-memory-corruption regression test, wasm32";
}
