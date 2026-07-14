# tali 3.22.0 — GNOME Tali (Yahtzee-style dice), third of the GNOME games
# tier and the pure-C member alongside five-or-more (its src/ is hand-written
# C — no Vala at all, autotools throughout). Deps are the tier minimum:
# gtk3 + librsvg (userspace/librsvg.nix) only.
#
# Assets: dice pixmaps install to $(datadir)/tali — loaded at runtime from
# the baked store path, riding the served closure (the galculator/gcalctool
# pattern). GSettings schema (org.gnome.tali) is compiled centrally in
# gtk-assets.nix.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "tali";
  dontFpcastEmu = true; # does its own dynsym+fpcast in postFixup below
  version = "3.22.0";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/tali/3.22/tali-3.22.0.tar.xz";
    hash = "sha256-W6F3lNb7BreU2q/6Yqaqo3K33oiGzl7FlsN+Yrtxcos=";
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

  # NO -fcommon: it ICEs clang on wasm32 (the object format has no common
  # symbols). Tali's headers already declare every global with `extern`
  # (yahtzee.h/gyahtzee.h) and no symbol is defined at file scope in two TUs,
  # so -fno-common (clang's default) links cleanly with no extern patch needed
  # — unlike four-in-a-row, whose main.h carried a real tentative definition.
  # Keep the incompatible-function-pointer-types demotion that this GTK-era C
  # needs for its g_signal_connect callback casts (same as gnome-mines).
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
      "$out/bin/tali" "$out/bin/tali.dynsym"
    mv "$out/bin/tali.dynsym" "$out/bin/tali"
    fpcast_emu "$out/bin/tali" "$out/bin/tali.fpcast"
    mv "$out/bin/tali.fpcast" "$out/bin/tali"
    chmod +x "$out/bin/tali"
    # Leaf app: drop the propagated -dev closure metadata (the #43 lesson).
    rm -rf "$out/nix-support"
  '';
}
