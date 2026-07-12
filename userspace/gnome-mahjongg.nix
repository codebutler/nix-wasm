# gnome-mahjongg 3.22.0 — the GNOME tile-matching solitaire, first of the
# GNOME games tier. Picked from the AUTOTOOLS era deliberately: it's Vala
# upstream, but autotools `make dist` tarballs ship the GENERATED C (and the
# .stamp files that stop make from regenerating), so no Vala toolchain is
# needed — the build compiles the shipped .c like any C app. (Meson-era
# versions ≥3.26 do NOT ship generated C; don't bump past the autotools era
# without bringing valac.) Deps are the proven stack + librsvg (the tier
# enabler, userspace/librsvg.nix): glib/gio/gtk3/librsvg only.
#
# Assets: tilesets install to $(datadir)/gnome-mahjongg/themes/*.svg and maps
# to …/maps — loaded at runtime from the baked store path, riding the served
# closure (the galculator/gcalctool pattern). GSettings schema
# (org.gnome.mahjongg) is compiled centrally in gtk-assets.nix.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "gnome-mahjongg";
  version = "3.22.0";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/gnome-mahjongg/3.22/gnome-mahjongg-3.22.0.tar.xz";
    hash = "sha256-9ZcqFPpK0EFTvW5oR1uFzXnGtE9srB/h7bZNutQTUhg=";
  };

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    cross.buildPackages.intltool # .desktop/.appdata merges
    cross.buildPackages.itstool # help/ pages (YELP_HELP_INIT)
    cross.buildPackages.libxml2.bin # xmllint only — NOT the dev output (its
    # native libxml-2.0.pc would shadow the cross one; the gcalctool trap)
    cross.buildPackages.gettext # msgfmt for po/
    cross.buildPackages.python3 # wasm-dynsym-inject.py
    fpcast.binaryen
  ];
  buildInputs = [
    cross.gtk3
    cross.glib
    cross.librsvg
    # librsvg-2.0.pc's Requires chain, listed explicitly (librsvg's leaf
    # posture drops its nix-support propagation): pkg-config must resolve
    # libcroco/cairo/pango/gdk-pixbuf/png from OUR inputs.
    cross.libcroco
    cross.cairo
    cross.pango
    cross.gdk-pixbuf
    cross.libpng
    cross.libxml2
    cross.freetype
    cross.fontconfig
    cross.pixman
    cross.zlib
  ];

  strictDeps = false;

  # Native-xz shim before unpack (the gcalctool trap).
  preUnpack = ''
    mkdir -p "$TMPDIR/native-xz-bin"
    ln -sf ${cross.buildPackages.xz}/bin/xz "$TMPDIR/native-xz-bin/xz"
    export PATH="$TMPDIR/native-xz-bin:$PATH"
  '';

  # Native glib tools by absolute path (AC_PATH_PROG honors preset env vars) —
  # native glib itself must stay out of the inputs or its glib-2.0.pc (which
  # requires sysprof-capture-4, unlike our -Dsysprof=disabled cross glib)
  # shadows the cross one on the loose PATH. Same fix as gcalctool.
  GLIB_COMPILE_SCHEMAS = "${cross.buildPackages.glib.dev}/bin/glib-compile-schemas";
  GLIB_COMPILE_RESOURCES = "${cross.buildPackages.glib.dev}/bin/glib-compile-resources";

  # glib-compile-resources/glib-mkenums are AC_SUBST'd from pkg-config's
  # gio-2.0/glib-2.0 variables — which resolve into the CROSS glib (wasm
  # binaries, Exec format error). Override the make variables with the native
  # tools (the gcalctool GLIB_MKENUMS lesson; env presets only reach
  # AC_PATH_PROG-style checks).
  makeFlags = [
    "GLIB_COMPILE_RESOURCES=${cross.buildPackages.glib.dev}/bin/glib-compile-resources"
    "GLIB_MKENUMS=${cross.buildPackages.glib.dev}/bin/glib-mkenums"
  ];

  # valac-0.32-era generated C assigns GMarkup/Builder callbacks with const-
  # qualification drift (gchar** vs const gchar**); clang >=16 promotes
  # incompatible-function-pointer-types to a hard error. ABI-identical —
  # demote it back to a warning for the GENERATED code (hand-written-C games
  # stay strict and get real patches instead).
  NIX_CFLAGS_COMPILE = "-Wno-error=incompatible-function-pointer-types";

  enableParallelBuilding = true;

  postInstall = ''
    # Central gschemas.compiled lives in gtk-assets; a per-package copy would
    # collide in the profile symlink merge.
    rm -f "$out/share/glib-2.0/schemas/gschemas.compiled"
  '';

  postFixup = ''
    ${fpcast.shellFn}
    # dynsym-inject BEFORE fpcast, then the standard indirect-call cast fix —
    # the uniform GTK-binary recipe (galculator/gcalctool). dynsym keeps any
    # GModule-resolved symbol (Vala signal plumbing) dlsym-able.
    python3 ${../scripts/wasm-dynsym-inject.py} \
      "$out/bin/gnome-mahjongg" "$out/bin/gnome-mahjongg.dynsym"
    mv "$out/bin/gnome-mahjongg.dynsym" "$out/bin/gnome-mahjongg"
    fpcast_emu "$out/bin/gnome-mahjongg" "$out/bin/gnome-mahjongg.fpcast"
    mv "$out/bin/gnome-mahjongg.fpcast" "$out/bin/gnome-mahjongg"
    chmod +x "$out/bin/gnome-mahjongg"
    # Leaf app: drop the propagated -dev closure metadata (the #43 lesson).
    rm -rf "$out/nix-support"
  '';
}
