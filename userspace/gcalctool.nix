# gcalctool 6.6.2 — the classic GNOME calculator, and the first app that
# NEEDS the Track C dlopen/GModule capability (#130) rather than dodging it:
# math-buttons.c loads its button panels from .ui files and wires their
# handlers with gtk_builder_connect_signals() (hence gmodule-export-2.0 in
# configure.ac) — the exact GtkBuilder → GModule → dlopen(NULL)/dlsym path
# galculator's click-to-42 proved. Before Track C this package was
# impossible without an add_callback_symbol fork; now it builds stock.
#
# 6.6.2 (2013) is the last release under the gcalctool name — still pure C
# (the Vala rewrite shipped as the gnome-calculator rename) and GTK3, so it
# rides the proven cross stack. Modern gnome-calculator is GTK4 + mpfr/mpc +
# libsoup (currency rates) — a different, much heavier porting story.
# nixpkgs dropped gcalctool long ago, so this is a from-scratch derivation
# over the GNOME release tarball (which ships a pre-generated ./configure —
# no autoreconf; updateAutotoolsGnuConfigScriptsHook refreshes config.sub so
# the 2012 script accepts the wasm32 triple).
#
# Two binaries install:
#   /bin/gcalctool — the GTK3 GUI (dynsym-inject + fpcast post-link, like
#                    galculator: dlsym must resolve the .ui handler names to
#                    canonical-thunk table slots). Loads its .ui panels from
#                    UI_DIR = $out/share/gcalctool (store path baked in, rides
#                    the served closure — the galculator pattern).
#   /bin/gcalccmd  — a stdin/stdout console calculator sharing the same
#                    equation engine (glib+libxml only, no GTK). This is the
#                    HEADLESS CI GATE: `echo "7*6" | gcalccmd` → 42 needs no
#                    display and no source patch (runtime/demo/node/
#                    gcalctool-smoke.mjs). fpcast'd too (gobject casts).
#
# GSettings: org.gnome.gcalctool.gschema.xml installs under share/; the
# COMPILED schema the guest reads is produced centrally in gtk-assets.nix
# (one gschemas.compiled for the whole profile — per-package compiled files
# would collide in the profile symlink merge). Any gschemas.compiled this
# package's `make install` emits is deleted in postInstall for that reason.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gcalctool";
  version = "6.6.2";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/gcalctool/6.6/gcalctool-6.6.2.tar.xz";
    hash = "sha256-5wihbMdYw6n8sH6cPkWYn32dZOKZP0QOmXB/zqPht2w=";
  };

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    cross.buildPackages.intltool # .desktop/.gschema.xml.in merges (IT_PROG_INTLTOOL)
    cross.buildPackages.itstool # help/ page translations (YELP_HELP_INIT probes it)
    cross.buildPackages.libxml2 # xmllint (itstool's validator)
    cross.buildPackages.gettext # msgfmt for po/
    cross.buildPackages.glib # native glib-compile-schemas + glib-mkenums (below)
    cross.buildPackages.python3 # wasm-dynsym-inject.py
    fpcast.binaryen
  ];
  buildInputs = [ cross.gtk3 cross.glib cross.libxml2 ];

  # The intltool/AM_GLIB macro layer predates strictDeps; keep the loose PATH
  # (same posture as the galculator override).
  strictDeps = false;

  # The strictDeps=false PATH leak puts the CROSS xz (a wasm binary, from the
  # gtk3 dep closure) ahead of any native xz, and unpackPhase's `.tar.xz`
  # decompress dies with "cannot execute binary file: Exec format error" —
  # the same trap galculator's preAutoreconf shim documents, hit one phase
  # earlier. Prepend a native-xz shim before unpack; the PATH export persists
  # for the whole builder run, covering any later bare `xz` call too.
  preUnpack = ''
    mkdir -p "$TMPDIR/native-xz-bin"
    ln -sf ${cross.buildPackages.xz}/bin/xz "$TMPDIR/native-xz-bin/xz"
    export PATH="$TMPDIR/native-xz-bin:$PATH"
  '';

  # configure AC_SUBSTs GLIB_MKENUMS from `pkg-config --variable=glib_mkenums
  # glib-2.0`, which resolves into the CROSS glib .dev — not guaranteed
  # runnable on the build host. Override the make variable with the native one
  # (mp-enums.[ch] are generated from mp-serializer.h at build time).
  makeFlags = [ "GLIB_MKENUMS=${cross.buildPackages.glib.dev}/bin/glib-mkenums" ];

  enableParallelBuilding = true;

  postInstall = ''
    # One compiled-schema file per profile dir — the guest's gschemas.compiled
    # is built centrally in gtk-assets.nix; a per-package copy would collide in
    # the environment.pathsToLink merge.
    rm -f "$out/share/glib-2.0/schemas/gschemas.compiled"
  '';

  postFixup = ''
    ${fpcast.shellFn}
    # GUI binary: dynsym-inject BEFORE fpcast (userspace/dynsym.nix) so every
    # export gets an elem slot + cb.dynsym entry — gtk_builder_connect_signals'
    # dlsym lookups resolve the .ui handler names to canonical-thunk indices.
    python3 ${../scripts/wasm-dynsym-inject.py} \
      "$out/bin/gcalctool" "$out/bin/gcalctool.dynsym"
    mv "$out/bin/gcalctool.dynsym" "$out/bin/gcalctool"
    fpcast_emu "$out/bin/gcalctool" "$out/bin/gcalctool.fpcast"
    mv "$out/bin/gcalctool.fpcast" "$out/bin/gcalctool"
    chmod +x "$out/bin/gcalctool"
    # Console binary: gobject casts too (GObject-based MathEquation), no dynsym
    # needed (no GtkBuilder autoconnect).
    fpcast_emu "$out/bin/gcalccmd" "$out/bin/gcalccmd.fpcast"
    mv "$out/bin/gcalccmd.fpcast" "$out/bin/gcalccmd"
    chmod +x "$out/bin/gcalccmd"
    # Leaf app: drop the propagated -dev closure metadata (the #43 lesson —
    # it drags the whole X11/-dev tree into the served store).
    rm -rf "$out/nix-support"
  '';
}
