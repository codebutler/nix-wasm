# gtk2-hello — M-X4 GTK2 proof (XChat/X11 epic). gtk_init + GtkWindow +
# GtkLabel via GTK2's X11 backend. --selftest is the headless CI gate (kept
# display-free for parity with gtk-hello, see gtk2-hello.c); default maps a
# real X11 window — screenshotted headless via Xvfb+xwd in
# runtime/demo/node/gtk2-x11-smoke.mjs, something GTK3's wayland-only build
# never had (no compositor in the node harness). Built through the
# fpcast-emu seam (gobject casts). Links cross gtk2 + its deps.
{ cross, gtk2, glib, pango, cairo, gdk-pixbuf, atk, fontconfig
, freetype, fribidi, pixman, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gtk2-hello";
  dontFpcastEmu = true; # fpcasts its own binary in buildPhase below
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ gtk2 glib pango cairo gdk-pixbuf atk fontconfig
    freetype fribidi pixman libffi zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    CFLAGS="$($PKG_CONFIG --cflags gtk+-2.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gtk+-2.0) -lffi -lm"
    $CC $CFLAGS ${./gtk2-hello.c} $LDLIBS -o gtk2-hello.pre
    fpcast_emu gtk2-hello.pre gtk2-hello
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 gtk2-hello $out/bin/gtk2-hello
    runHook postInstall
  '';
  meta.description = "GTK2 hello-window proof (M-X4), wasm32";
}
