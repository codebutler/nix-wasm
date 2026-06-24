# gtk3-widget-factory — the headline GTK3 app (#33). GTK's own widget showcase,
# built standalone against the cross gtk3 (no gtk3 rebuild; demos stay off in the
# library build). It is the proof that GtkBuilder signal autoconnect works on the
# statically-linked wasm guest, where there is no working GModule (no dlopen(NULL)/
# dlsym): widget-factory registers its .ui handlers with gtk_builder_add_callback_
# symbol() so gtk_builder_connect_signals() resolves them from the callback scope
# and never touches GModule. Upstream already registers 17 of its 18 handlers; our
# patch adds the one it leaves to GModule (gtk_widget_hide_on_delete) so the real
# app autoconnects fully, AND adds a display-free --selftest (GtkTextBuffer signal)
# that is the headless #33 gate. See patches/widget-factory/0001-*.
#
# Why this and not galculator: galculator's .ui references 115 handlers (115
# registrations); widget-factory needs ONE — GTK's sanctioned static-linking API
# applied to GTK's own showcase. The dead-end host/musl dlsym approach (and why it
# cannot work under the --fpcast-emu seam) is recorded in issue #33.
#
# gtk is gobject → C function-pointer casts; the binary goes through the SHARED
# --fpcast-emu seam (userspace/fpcast-emu.nix), same as gtk-hello/galculator.
{ cross, gtk3, glib, pango, cairo, gdk-pixbuf, atk, libepoxy, harfbuzz, fontconfig
, freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gtk3-widget-factory";
  version = "3.24.52";

  # Reuse the cross gtk3's own source tarball — widget-factory ships in its demos/.
  src = gtk3.src;
  # The patch targets demos/widget-factory/widget-factory.c from the gtk root.
  patches = [ ../patches/widget-factory/0001-static-handler-and-selftest.patch ];

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    cross.buildPackages.glib    # glib-compile-resources (native)
    cross.buildPackages.libxml2 # xmllint, for the gresource xml-stripblanks step
    fpcast.binaryen
  ];
  buildInputs = [ gtk3 glib pango cairo gdk-pixbuf atk libepoxy harfbuzz fontconfig
    freetype fribidi pixman wayland wayland-protocols libxkbcommon libffi zlib ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    cd demos/widget-factory

    # widget-factory.c #include "config.h" — it only reads PACKAGE_VERSION (about
    # dialog) + GETTEXT_PACKAGE (gi18n). Supply a minimal one for the standalone build.
    cat > config.h <<EOF
    #define PACKAGE_VERSION "${"3.24.52"}"
    #define GETTEXT_PACKAGE "gtk30"
    EOF

    # Embed the UI/CSS GResource (widget-factory.ui/.css + help-overlay.ui) as C,
    # compiled with the NATIVE glib (the guest can't run host tools); xml-stripblanks
    # shells out to the native xmllint provided above.
    glib-compile-resources --target=widgetfactory_resources.c --generate-source \
      --sourcedir=. widget-factory.gresource.xml

    CFLAGS="$($PKG_CONFIG --cflags gtk+-3.0) -I. -O2 -Wno-deprecated-declarations"
    LDLIBS="$($PKG_CONFIG --libs gtk+-3.0) -lffi -lm"
    $CC $CFLAGS widget-factory.c widgetfactory_resources.c $LDLIBS -o gtk3-widget-factory.pre
    fpcast_emu gtk3-widget-factory.pre gtk3-widget-factory
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 gtk3-widget-factory $out/bin/gtk3-widget-factory
    runHook postInstall
  '';

  meta.description = "GTK3 widget-factory showcase on wasm32 (GtkBuilder autoconnect via add_callback_symbol, #33)";
}
