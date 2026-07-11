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

  configureFlags = [ "--disable-gtk-doc" ];

  enableParallelBuilding = true;

  # Library-only leaf for our purposes: drop the propagated -dev closure
  # metadata (the #43 lesson) — nothing in the served store builds against it.
  postFixup = ''
    rm -rf "$out/nix-support"
  '';
}
