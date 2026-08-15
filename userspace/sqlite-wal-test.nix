# sqlite-wal-test — #131 regression test for restored SQLite WAL + serialized
# threading. Statically linked into both initramfs variants and exercised by the
# shared selftests batch; smoke.mjs also uses it to inspect Nix's real store DB.
{ cross, sqlite }:
cross.stdenv.mkDerivation {
  pname = "sqlite-wal-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 -pthread \
      -I${cross.lib.getDev sqlite}/include \
      ${./sqlite-wal-test.c} \
      ${cross.lib.getLib sqlite}/lib/libsqlite3.a \
      -lm -o sqlite-wal-test
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 sqlite-wal-test $out/bin/sqlite-wal-test
    runHook postInstall
  '';
  meta.description = "SQLite WAL and serialized-threading regression test, wasm32";
}
