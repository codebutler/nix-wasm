# glib-selftest — in-guest gobject proof (M3a). Links cross glib/gobject and
# exercises a generic-marshaller double signal (validates the M1 libffi f64 path).
{ cross, glib, libffi, pcre2, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; }
}:
cross.stdenv.mkDerivation {
  pname = "glib-selftest";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ glib libffi pcre2 zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags gobject-2.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gobject-2.0) -lffi -lm"
    $CC $CFLAGS ${./glib-selftest.c} $LDLIBS -o glib-selftest.pre

    # M3a (gobject blocker): glib relies on function-pointer casts that wasm's
    # strict call_indirect rejects (see userspace/fpcast-emu.nix for the full
    # root-cause narrative). The SHARED --fpcast-emu post-link seam rewrites the
    # mismatched indirect calls so they dispatch correctly.
    ${fpcast.shellFn}
    fpcast_emu glib-selftest.pre glib-selftest
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 glib-selftest $out/bin/glib-selftest
    runHook postInstall
  '';
  meta.description = "gobject + libffi-marshaller selftest (M3a), wasm32";
}
