# glib-selftest — in-guest gobject proof (M3a). Links cross glib/gobject and
# exercises a generic-marshaller double signal (validates the M1 libffi f64 path).
{ cross, glib, libffi, pcre2, zlib }:
cross.stdenv.mkDerivation {
  pname = "glib-selftest";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ glib libffi pcre2 zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags gobject-2.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gobject-2.0) -lffi -lm"
    $CC $CFLAGS ${./glib-selftest.c} $LDLIBS -o glib-selftest
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 glib-selftest $out/bin/glib-selftest
    runHook postInstall
  '';
  meta.description = "gobject + libffi-marshaller selftest (M3a), wasm32";
}
