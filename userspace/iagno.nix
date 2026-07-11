# iagno 3.22.0 — GNOME Reversi, sixth of the games tier. Vala upstream,
# autotools dist tarball ships the generated C (the mahjongg story). Deps:
# gtk3 + librsvg — upstream also wants libcanberra-gtk3, which we DON'T
# cross-build (canberra-gtk.c is X11-only source and our GTK3 is
# wayland-only; a null-driver build would be silent anyway — no audio
# device). The one ca_gtk_play_for_widget site in the SHIPPED generated
# iagno.c is stubbed by patches/iagno/0001-disable-sound.patch (stable —
# the pinned tarball's generated C never changes) and the configure
# requirement is sed'd out below. Revisit when the guest grows audio.
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

  patches = [ ../patches/iagno/0001-disable-sound.patch ];

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
