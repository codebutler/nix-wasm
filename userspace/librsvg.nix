# librsvg 2.40.21 — the LAST all-C librsvg (2.41+ is Rust, a whole second
# toolchain this project doesn't carry). This is the shared enabler for the
# GNOME games tier (gnome-mahjongg, five-or-more, later gnome-mines /
# four-in-a-row): they all draw their pieces/tilesets from SVG via the
# RsvgHandle API, linked statically. nixpkgs' librsvg is the Rust one, so
# this is a from-scratch pin over the GNOME tarball (the gcalctool recipe).
#
# Requires cairo built WITH the PNG backend (cairo-png.pc) — flipped on in
# the cairo override (deps-overlay.nix) together with a cross libpng; that
# was the one closure gap librsvg exposed.
#
# --enable-tools ships /bin/rsvg-convert, which doubles as the HEADLESS CI
# GATE for this whole tier with zero source patches: rendering a game's real
# tileset SVG to PNG in-guest exercises libcroco → librsvg → pango/cairo →
# pixbuf end-to-end, display-free (runtime/demo/node/rsvg-smoke.mjs).
# --disable-pixbuf-loader: the games call librsvg directly — no loadable
# gdk-pixbuf module needed (and loaders.cache registration is its own yak).
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "librsvg";
  version = "2.40.21";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/librsvg/2.40/librsvg-2.40.21.tar.xz";
    hash = "sha256-92KJBfHK2oTofisUiD7VfYCU3KMoHVvLJOzkJ56akro=";
  };

  # Modern-libxml2 compatibility (our cross libxml2 is 2.15): SAX.h no longer
  # pulls in the parser types. See the patch header.
  patches = [ ../patches/librsvg/0001-libxml2-2.15-parser-include.patch ];

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    # Auto-fpcasts $out/bin/rsvg-convert in postFixup (userspace/fpcast-emu.nix).
    fpcast.hook
  ];
  buildInputs = [
    # gdk-pixbuf-BASE, not the svg-loader variant: the svg gdk-pixbuf compiles
    # in librsvg's io-svg.c and thus depends on THIS librsvg — building librsvg
    # against base breaks that derivation cycle (base has no svg loader; it's
    # only used here). See the gdk-pixbuf override in deps-overlay.nix.
    cross.gdk-pixbuf-base
    cross.pango
    cross.cairo
    cross.glib
    cross.libcroco
    cross.libxml2
    cross.freetype
    cross.fontconfig
    cross.pixman
    cross.libpng
    cross.zlib
  ];

  strictDeps = false;

  # Native-xz shim before unpack (the gcalctool trap — cross wasm xz shadows
  # native xz on the loose PATH and the .tar.xz unpack dies).
  preUnpack = ''
    mkdir -p "$TMPDIR/native-xz-bin"
    ln -sf ${cross.buildPackages.xz}/bin/xz "$TMPDIR/native-xz-bin/xz"
    export PATH="$TMPDIR/native-xz-bin:$PATH"
  '';

  configureFlags = [
    "--disable-pixbuf-loader"
    "--enable-tools" # rsvg-convert: the tier's headless CI gate
    "--disable-introspection"
    # -Bsymbolic-functions is an ELF dynamic-linking flag; the wasm link is
    # fully static and wasm-ld has no such flag.
    "--disable-Bsymbolic"
    "--disable-gtk-doc"
  ];

  enableParallelBuilding = true;

  postInstall = ''
    # STATIC-LINK REQUIRES FIX: upstream's .pc assumes shared linking (the .so
    # would carry libxml2/libcroco/pango internally), so consumers linking the
    # static librsvg-2.a underlink — wasm-ld: undefined xmlCreatePushParserCtxt /
    # cr_doc_handler_new at every game's link. Everything on this platform is
    # static-only, so promote librsvg's real dependencies into public Requires.
    pc="$out/lib/pkgconfig/librsvg-2.0.pc"
    grep -q '^Requires: glib-2.0 gio-2.0 gdk-pixbuf-2.0 cairo$' "$pc" \
      || (echo "librsvg .pc Requires line moved — update the sed" >&2; exit 1)
    # Promote librsvg's real static-link deps into Requires (upstream assumes
    # shared linking) — but DROP gdk-pixbuf-2.0. librsvg builds against
    # gdk-pixbuf-BASE, while every downstream consumer (the games, via gtk3)
    # links the svg-loader gdk-pixbuf. Leaving gdk-pixbuf in Requires here would
    # put the BASE gdk-pixbuf's .pc on their pkg-config path too, and whichever
    # gdk-pixbuf-2.0.pc pkg-config resolved first would win — nondeterministically
    # dropping the svg loader. Consumers get gdk-pixbuf from gtk3 (svg) instead.
    sed -i 's/^Requires: glib-2.0 gio-2.0 gdk-pixbuf-2.0 cairo$/Requires: glib-2.0 gio-2.0 cairo pangocairo pangoft2 libcroco-0.6 libxml-2.0/' "$pc"
  '';

  # fpcast.hook (nativeBuildInputs) applies the standard gobject/pango
  # indirect-call cast fix to $out/bin/rsvg-convert automatically (the .a
  # libraries need nothing — fpcast is a per-final-binary pass; the games run
  # the same hook on their own linked outputs). This postFixup only does the
  # served-closure cleanup below.
  postFixup = ''
    # Leaf posture for the served closure (the #43 lesson). The games build
    # against this package's .dev output in the BUILD graph, which does not
    # read nix-support from the installed store copy.
    rm -rf "$out/nix-support"
    # Libtool archives embed dependency_libs with ABSOLUTE STORE PATHS — they
    # dragged the entire build closure (glib-dev → native python3 62MB /
    # gettext / bash-dev / glibc…) into the SERVED image: 36 → 112 store
    # paths, base.squashfs 112MB → 306MB. Consumers link via pkg-config
    # -L/-l; .la files are pure liability (distros strip them for the same
    # reason). The -config script embeds dep -L paths the same way.
    rm -f "$out/lib/"*.la "$out/bin/"*-config
  '';
}
