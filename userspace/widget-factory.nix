# gtk3-widget-factory — the headline GTK3 app (#33 → #130). GTK's own widget
# showcase, built standalone against the cross gtk3 (no gtk3 rebuild; demos stay
# off in the library build).
#
# WAS the proof that GtkBuilder autoconnect works WITHOUT a working GModule (via
# gtk_builder_add_callback_symbol registering every handler in the callback
# scope). Track C (#130) makes GModule REAL — g_module_open(NULL)/g_module_symbol
# → musl dlopen(NULL)/dlsym (patch 0009 + the runtime side-module loader) — so the
# add_callback_symbol workaround is GONE: the --selftest now resolves its .ui
# <signal> handler purely through gtk_builder_connect_signals(builder, NULL) →
# GModule, the real path, and asserts the handler fires. This is #131 slice 2's
# widget-factory box.
#
# Two build requirements for the by-name GModule resolution:
#   • --export-dynamic (via --export-all in the cross cc-wrapper, already on) so
#     the handler is in the module's exports for the loader to find.
#   • dynsym-inject (userspace/dynsym.nix) BEFORE fpcast, so every exported
#     function gets a canonical-thunk elem slot — dlsym returns the fpcast-correct
#     &handler (the #33 revert's core fix, now productized in Track C).
#
# gtk is gobject → C function-pointer casts; the binary goes through the SHARED
# --fpcast-emu seam (userspace/fpcast-emu.nix), same as gtk-hello/galculator,
# with dynsym-inject run first (the #130 build order).
{ cross, gtk3, glib, pango, cairo, gdk-pixbuf, atk, libepoxy, harfbuzz, fontconfig
, freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; }
, dynsym ? import ./dynsym.nix { inherit cross; } }:
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
    dynsym.python3 # dynsym-inject (below)
  ];
  buildInputs = [ gtk3 glib pango cairo gdk-pixbuf atk libepoxy harfbuzz fontconfig
    freetype fribidi pixman wayland wayland-protocols libxkbcommon libffi zlib ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    ${dynsym.shellFn}
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
    # #130: dynsym-inject BEFORE fpcast so the .ui handlers are dlsym-able by
    # name (canonical-thunk elem slots + cb.dynsym map); then the fpcast seam.
    dynsym_inject gtk3-widget-factory.pre gtk3-widget-factory.dyn
    fpcast_emu gtk3-widget-factory.dyn gtk3-widget-factory
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 gtk3-widget-factory $out/bin/gtk3-widget-factory
    runHook postInstall
  '';

  meta.description = "GTK3 widget-factory showcase on wasm32 (GtkBuilder autoconnect via add_callback_symbol, #33)";
}
