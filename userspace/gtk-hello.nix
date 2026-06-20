# gtk-hello — M3b GTK3 proof. gtk_init + GtkWindow + GtkLabel. --selftest is the
# headless CI gate; default maps a wayland window (manual browser check). Built
# through the fpcast-emu seam (gobject casts). Links cross gtk3 + its deps.
{ cross, gtk3, glib, pango, cairo, gdk-pixbuf, atk, libepoxy, harfbuzz, fontconfig
, freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gtk-hello";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config fpcast.binaryen ];
  buildInputs = [ gtk3 glib pango cairo gdk-pixbuf atk libepoxy harfbuzz fontconfig
    freetype fribidi pixman wayland wayland-protocols libxkbcommon libffi zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    CFLAGS="$($PKG_CONFIG --cflags gtk+-3.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gtk+-3.0) -lffi -lm"
    $CC $CFLAGS ${./gtk-hello.c} $LDLIBS -o gtk-hello.pre
    fpcast_emu gtk-hello.pre gtk-hello
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 gtk-hello $out/bin/gtk-hello
    runHook postInstall
  '';
  meta.description = "GTK3 hello-window proof (M3b), wasm32";
}
