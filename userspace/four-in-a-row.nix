# four-in-a-row 3.22.1 — GNOME Four-in-a-row (Connect Four), fifth of the
# games tier. Vala upstream, autotools dist tarball ships the generated C
# (the mahjongg story). Deps: gtk3 + librsvg — upstream also wants
# libcanberra-gtk3, which we DON'T cross-build (canberra-gtk.c is X11-only
# source and our GTK3 is wayland-only; a null-driver build would be silent
# anyway since the guest has no audio device). The sound calls are stubbed
# by patches/four-in-a-row/0001-disable-sound.patch (one call site in
# hand-written main.c) and the configure requirement is sed'd out below.
# Revisit when the guest grows an audio stack.
#
# GSettings schema (org.gnome.four-in-a-row) compiles centrally in
# gtk-assets.nix; its themes ride the closure via systemPackages.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "four-in-a-row";
  version = "3.22.1";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/four-in-a-row/3.22/four-in-a-row-3.22.1.tar.xz";
    hash = "sha256-PM9lqdoI2OiI+pCnv1UZK8NEmBzsOx9W+g2nD0IxN9Q=";
  };

  patches = [
    ../patches/four-in-a-row/0001-disable-sound.patch
    # player_active tentative definition in main.h — -fcommon is NOT an option
    # on wasm32 (no common symbols in the object format; clang ICEs), so the
    # header gets a real extern. See the patch header.
    ../patches/four-in-a-row/0002-extern-player-active.patch
  ];

  # Drop the libcanberra-gtk3 requirement from the SHIPPED configure (we
  # don't autoreconf). Asserted: the build fails loudly if the string moves.
  postPatch = ''
    grep -c "libcanberra-gtk3" configure >/dev/null || (echo "canberra sed anchor missing" >&2; exit 1)
    sed -i 's/ *libcanberra-gtk3 >= [$\\]*CANBERRA_GTK_REQUIRED//g' configure
    if grep -q "libcanberra-gtk3" configure; then echo "canberra sed incomplete" >&2; exit 1; fi
  '';

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
  # stay strict and get real patches instead). NO -fcommon: it ICEs clang on
  # wasm32 (no common symbols in the object format), so the hand-written-C
  # half's lone tentative definition (player_active) gets a real extern via
  # 0002-extern-player-active.patch instead.
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
      "$out/bin/four-in-a-row" "$out/bin/four-in-a-row.dynsym"
    mv "$out/bin/four-in-a-row.dynsym" "$out/bin/four-in-a-row"
    fpcast_emu "$out/bin/four-in-a-row" "$out/bin/four-in-a-row.fpcast"
    mv "$out/bin/four-in-a-row.fpcast" "$out/bin/four-in-a-row"
    chmod +x "$out/bin/four-in-a-row"
    # Leaf app: drop the propagated -dev closure metadata (the #43 lesson).
    rm -rf "$out/nix-support"
  '';
}
