# Bound the first-boot seed install's page-cache footprint without touching the
# global /proc/sys/vm/drop_caches control. After each top-level store path is
# copied and syncfs() has made its destination data clean, this helper applies
# POSIX_FADV_DONTNEED only to the source and destination files just processed.
{ cross }:
cross.stdenv.mkDerivation {
  pname = "seed-cache-release";
  version = "0.1.0";
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    $CC -O2 ${./seed-cache-release.c} -o seed-cache-release
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 seed-cache-release $out/bin/seed-cache-release
    runHook postInstall
  '';
  meta.description = "Scoped page-cache release helper for the first-boot seed installer";
}
