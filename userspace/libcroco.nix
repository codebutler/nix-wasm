# libcroco 0.6.13 — the GNOME CSS2 parsing library, needed ONLY as librsvg
# 2.40's CSS engine (the GNOME games' SVG renderer — see librsvg.nix). Plain
# autotools C over glib + libxml2; nixpkgs dropped it in 2021 when librsvg
# went Rust, so this is a from-scratch pin (the gcalctool recipe).
{ cross, pkgs }:
cross.stdenv.mkDerivation {
  pname = "libcroco";
  version = "0.6.13";

  src = pkgs.fetchurl {
    url = "https://download.gnome.org/sources/libcroco/0.6/libcroco-0.6.13.tar.xz";
    hash = "sha256-dn7CNK56poRpWzpzVUgiSIgTLgY/kttYV1m0IlcGIdQ=";
  };

  nativeBuildInputs = [ cross.buildPackages.pkg-config ];
  buildInputs = [ cross.glib cross.libxml2 ];

  strictDeps = false;

  # The cross wasm xz from the dep closure shadows native xz on the loose PATH
  # and unpackPhase dies with Exec format error (the gcalctool trap). Prepend a
  # native-xz shim; the PATH export persists for the whole builder run.
  preUnpack = ''
    mkdir -p "$TMPDIR/native-xz-bin"
    ln -sf ${cross.buildPackages.xz}/bin/xz "$TMPDIR/native-xz-bin/xz"
    export PATH="$TMPDIR/native-xz-bin:$PATH"
  '';

  configureFlags = [
    "--disable-gtk-doc"
    # Same check as librsvg: -Wl,-Bsymbolic-functions is an ELF dynamic-link
    # flag wasm-ld doesn't have, and libcroco's configure hard-errors on it
    # ("requested but not supported by ld") instead of just skipping.
    "--disable-Bsymbolic"
  ];

  enableParallelBuilding = true;

  # Library-only leaf for our purposes: drop the propagated -dev closure
  # metadata (the #43 lesson) — nothing in the served store builds against it.
  postFixup = ''
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
