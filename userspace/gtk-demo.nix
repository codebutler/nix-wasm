# gtk3-demo — GTK's own demo browser, the first REAL (non-showcase) GTK3 app on
# the wasm guest. Where gtk3-widget-factory (#33) proves GtkBuilder signal
# autoconnect via gtk_builder_add_callback_symbol, gtk3-demo proves the OTHER
# path: a full GtkApplication whose main window (a GtkTreeView demo list + a
# source viewer + a run pane) wires every signal in C with g_signal_connect and
# never calls gtk_builder_connect_signals — so it has NO GModule dependency at
# all. That is exactly why galculator does NOT work here (its .ui defers 115
# handlers to g_module_open(NULL)/dlsym, which the static guest cannot provide)
# and gtk3-demo does: same GTK, different signal-wiring style.
#
# Built standalone against the cross gtk3 (gtk3 itself stays cached — its library
# build has demos=false), reproducing demos/gtk-demo/meson.build by hand the same
# way widget-factory.nix does:
#   1. geninclude.py → demos.h     (the do_<demo> dispatch table; native python3)
#   2. glib-compile-resources       (embeds every .ui/.css/.png + the demo .c
#      → gtkdemo_resources.c          sources shown in the in-app source viewer)
#   3. $CC over every demo .c + gtkfishbowl.c + main.c + the two generated .c
#   4. the shared --fpcast-emu post-link pass (gtk is gobject-heavy → C function-
#      pointer casts; userspace/fpcast-emu.nix, same seam as gtk-hello/galculator/
#      widget-factory).
# The resources are EMBEDDED in the binary, so gtk3-demo is self-contained (only
# gtk's own runtime data — themes/icons via gtk-assets, fonts via fontconfig — is
# needed, already in the system); it ships as an initramfs extraBin, no share dir.
#
# --selftest is the display-free headless gate (the node harness has no
# compositor): it walks the generated gtk_demos[] table asserting every do_<demo>
# function pointer is a real address-taken fpcast thunk, runs a few browser-chrome
# widget class_init functions through the fpcast seam (g_type_class_ref, no
# display), and checks gtk_get_major_version()==3. The full browser window is a
# MANUAL browser check. See patches/gtk-demo/0001-add-selftest.patch.
{ cross, gtk3, glib, pango, cairo, gdk-pixbuf, atk, libepoxy, harfbuzz, fontconfig
, freetype, fribidi, pixman, wayland, wayland-protocols, libxkbcommon, libffi, zlib
, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gtk3-demo";
  version = "3.24.52";

  # Reuse the cross gtk3's own source tarball — gtk-demo ships in its demos/.
  src = gtk3.src;
  # The patch targets demos/gtk-demo/main.c from the gtk root (adds --selftest).
  patches = [ ../patches/gtk-demo/0001-add-selftest.patch ];

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    cross.buildPackages.python3   # geninclude.py (demos.h generator)
    cross.buildPackages.glib      # glib-compile-resources (native)
    cross.buildPackages.libxml2   # xmllint, for the gresource xml-stripblanks step
    fpcast.binaryen
  ];
  buildInputs = [ gtk3 glib pango cairo gdk-pixbuf atk libepoxy harfbuzz fontconfig
    freetype fribidi pixman wayland wayland-protocols libxkbcommon libffi zlib ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    ${fpcast.shellFn}
    cd demos/gtk-demo

    # main.c (and some demos via gi18n) #include "config.h": it only needs
    # PACKAGE_VERSION (the About dialog) + GETTEXT_PACKAGE (gi18n). Supply a
    # minimal one for the standalone build.
    cat > config.h <<EOF
    #define PACKAGE_VERSION "${"3.24.52"}"
    #define GETTEXT_PACKAGE "gtk30"
    EOF

    # The demo sources are every .c here EXCEPT the gtk3-demo-application program
    # (application.c — its own main()), the GtkFishbowl helper (gtkfishbowl.c — no
    # do_ entry point), main.c, and pagesetup.c. Each demo file defines do_<name>
    # and starts with a /* Title */ first line, which geninclude.py turns into the
    # gtk_demos[] dispatch table (sorted by title, so input order is irrelevant).
    # pagesetup.c is dropped: it #includes <gtk/gtkunixprint.h> (the Unix print
    # dialog), which our wayland-only / no-cups cross gtk3 doesn't install, and its
    # GtkPageSetupUnixDialog isn't compiled into libgtk — a printer is meaningless
    # on the guest anyway. Excluding it from DEMO_SRCS also drops do_pagesetup from
    # the geninclude table, so main.c never references it.
    DEMO_SRCS=$(ls *.c | grep -vE '^(application|gtkfishbowl|main|pagesetup)\.c$')

    # 1. demos.h — the generated dispatch table main.c #includes.
    python3 geninclude.py demos.h $DEMO_SRCS

    # 2. Embed the UI/CSS/image GResource (+ the demo .c sources for the in-app
    #    source viewer) as C, compiled with the NATIVE glib (the guest can't run
    #    host tools); xml-stripblanks shells out to the native xmllint above.
    glib-compile-resources --target=gtkdemo_resources.c --generate-source \
      --sourcedir=. demo.gresource.xml

    # -I../.. is the gtk source root (meson's confinc): gtkfishbowl.c does
    # #include "gtk/fallback-c89.c", an in-tree source file resolved from there. It
    # goes AFTER the pkg-config includes so the installed <gtk/*.h> still win (the
    # source-tree headers are unconfigured *.h.in templates).
    CFLAGS="$($PKG_CONFIG --cflags gtk+-3.0 harfbuzz) -I. -I../.. -O2 -Wno-deprecated-declarations"
    LDLIBS="$($PKG_CONFIG --libs gtk+-3.0 harfbuzz) -lffi -lm"
    $CC $CFLAGS $DEMO_SRCS gtkfishbowl.c main.c gtkdemo_resources.c $LDLIBS -o gtk3-demo.pre
    fpcast_emu gtk3-demo.pre gtk3-demo
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 gtk3-demo $out/bin/gtk3-demo
    runHook postInstall
  '';

  meta.description = "GTK3 demo browser on wasm32 — a full GtkApplication with no GModule signal autoconnect (C g_signal_connect)";
}
