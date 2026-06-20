# pango-text — M3a pango-layout proof. PangoLayout → cairo image surface (the GTK
# text path). Links cross pango + cairo + glib + the M2 text stack. --selftest
# asserts non-white px. Like glib-selftest, pango/gobject relies on
# function-pointer casts that wasm's strict call_indirect rejects, so the linked
# binary goes through the SHARED --fpcast-emu post-link seam (userspace/fpcast-emu.nix).
{ cross, pango, cairo, glib, harfbuzz, fontconfig, freetype, fribidi, pcre2, zlib, libffi, pixman
, fpcast ? import ./fpcast-emu.nix { inherit cross; }
}:
cross.stdenv.mkDerivation {
  pname = "pango-text";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ pango cairo glib harfbuzz fontconfig freetype fribidi pcre2 zlib libffi pixman ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags pangocairo) -O2"
    LDLIBS="$($PKG_CONFIG --libs pangocairo) -lffi -lm"
    $CC $CFLAGS ${./pango-text.c} $LDLIBS -o pango-text.pre

    # pango/gobject has the same strict-call_indirect function-pointer casts as
    # glib-selftest (e.g. gobject class_init thunks); apply the shared seam.
    ${fpcast.shellFn}
    fpcast_emu pango-text.pre pango-text
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 pango-text $out/bin/pango-text
    runHook postInstall
  '';
  meta.description = "Pango-layout text render proof (M3a), wasm32";
}
