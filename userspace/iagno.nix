# iagno 3.22.0 — GNOME Reversi, sixth of the games tier. Vala upstream,
# autotools dist tarball ships the generated C (the mahjongg story). Deps:
# gtk3 + librsvg + libcanberra-gtk3 — SOUND IS REAL now (issue #145): the
# guest has a virtio-snd sound card and libcanberra cross-builds with the
# builtin ALSA backend against our wayland-only GTK3 (deps-overlay.nix +
# patches/libcanberra/0001), so the upstream ca_gtk_play_for_widget site in
# the SHIPPED generated iagno.c builds unmodified (the old
# 0001-disable-sound.patch + configure sed are retired).
#
# GSettings schema (org.gnome.iagno) compiles centrally in gtk-assets.nix.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "iagno";
  version = "3.22.0";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/iagno/3.22/iagno-3.22.0.tar.xz";
    hash = "sha256-5wcMVfH3TNk0U4juEg8ObMRzkoaMJgFmTCag+iZy/hM=";
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
    # Event sounds (issue #145): libcanberra-gtk3 + its static link chain
    # (libcanberra.pc pulls vorbisfile + alsa via Libs.private).
    cross.libcanberra
    cross.alsa-lib
    cross.libvorbis
    cross.libogg
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
      "$out/bin/iagno" "$out/bin/iagno.dynsym"
    mv "$out/bin/iagno.dynsym" "$out/bin/iagno"
    fpcast_emu "$out/bin/iagno" "$out/bin/iagno.fpcast"
    mv "$out/bin/iagno.fpcast" "$out/bin/iagno"
    chmod +x "$out/bin/iagno"
    # Leaf app: drop the propagated -dev closure metadata (the #43 lesson).
    rm -rf "$out/nix-support"
  '';
}
