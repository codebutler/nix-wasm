# five-or-more 3.22.2 — GNOME's "Color Lines" (align five balls). Second of
# the GNOME games tier, and the pure-C sibling (no Vala at all — unlike
# mahjongg, its src/ is hand-written C). Deps beyond the proven stack:
# librsvg (the tier enabler) and gmodule — its UI is GtkBuilder .ui files
# (five-or-more.ui) with autoconnected handlers, i.e. the Track C
# GModule/dlopen path gcalctool proved. Ball themes install to
# $(datadir)/five-or-more/themes/*.svg, loaded from the baked store path.
# GSettings schema (org.gnome.five-or-more) compiles centrally in gtk-assets.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "five-or-more";
  dontFpcastEmu = true; # does its own dynsym+fpcast in postFixup below
  version = "3.22.2";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/five-or-more/3.22/five-or-more-3.22.2.tar.xz";
    hash = "sha256-us+OA62UBGI6FSkAuFRddF04ov4PASCLx9yILL1TRqw=";
  };

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    cross.buildPackages.intltool
    cross.buildPackages.itstool
    cross.buildPackages.libxml2.bin # xmllint only (native .pc shadow trap)
    cross.buildPackages.gettext
    cross.buildPackages.python3 # wasm-dynsym-inject.py
    fpcast.binaryen
  ];
  buildInputs = [
    cross.gtk3
    cross.glib
    cross.librsvg
    # librsvg's Requires chain, explicit (see gnome-mahjongg.nix).
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

  # Native glib tools by absolute path; native glib stays out of the inputs
  # (its .pc requires sysprof-capture-4 — the gcalctool trap).
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

  enableParallelBuilding = true;

  postInstall = ''
    rm -f "$out/share/glib-2.0/schemas/gschemas.compiled"
  '';

  postFixup = ''
    ${fpcast.shellFn}
    # dynsym-inject BEFORE fpcast: five-or-more's .ui handlers resolve via
    # gtk_builder_connect_signals → GModule → dlsym, which needs the cb.dynsym
    # name→slot map + canonical thunks (the gcalctool recipe, #130).
    python3 ${../scripts/wasm-dynsym-inject.py} \
      "$out/bin/five-or-more" "$out/bin/five-or-more.dynsym"
    mv "$out/bin/five-or-more.dynsym" "$out/bin/five-or-more"
    fpcast_emu "$out/bin/five-or-more" "$out/bin/five-or-more.fpcast"
    mv "$out/bin/five-or-more.fpcast" "$out/bin/five-or-more"
    chmod +x "$out/bin/five-or-more"
    rm -rf "$out/nix-support"
  '';
}
