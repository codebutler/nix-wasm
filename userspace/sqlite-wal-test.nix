# sqlite-wal-test — #131 regression test for restored serialized threading in
# both profiles, plus WAL on MMU and rollback journaling on NOMMU.
{ cross, sqlite, expectWal ? true }:
cross.stdenv.mkDerivation {
  pname = if expectWal then "sqlite-wal-test" else "sqlite-rollback-test";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 -pthread -DSQLITE_EXPECT_WAL=${if expectWal then "1" else "0"} \
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
  meta.description = "SQLite journal-mode and serialized-threading regression test, wasm32";
}
