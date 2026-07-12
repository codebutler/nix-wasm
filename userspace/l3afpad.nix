# l3afpad — the GTK3 fork of leafpad (a Notepad-class text editor), the first
# real (non-showcase) GTK3 PRODUCTIVITY app on the wasm guest (#122). Like
# gtk3-demo (#121) it is pure C with every signal wired via g_signal_connect /
# GtkActionEntry tables (GtkUIManager menubar) — it never calls
# gtk_builder_connect_signals(NULL), so it has NO GModule dependency and needs
# no dynsym-inject seam; the address-taken G_CALLBACK(&handler) pointers are
# exactly the fpcast canonical thunks. Open/edit/save works on any writable
# guest path, notably /mnt/pc (the 9P pc-VFS mount) — saved files land in the
# pc VFS.
#
# nixpkgs dropped l3afpad before our pin (no pkgs/by-name/l3 shard, no alias at
# 9ae611a), so like gcalctool this is a from-scratch derivation — pinned to the
# same upstream rev nixpkgs last shipped (24.05). A git checkout, not a dist
# tarball: no pregenerated ./configure, so autoreconfHook + an explicit
# intltoolize run (autogen.sh's recipe; autoreconf does not invoke intltoolize
# and the repo carries no po/Makefile.in.in).
#
# Built --disable-print: the cross GTK3 is wayland-only with no unix-print
# layer compiled into libgtk (the gap that dropped gtk3-demo's pagesetup demo),
# so the GtkPrintOperation platform backend does not exist. Patch 0002 compiles
# gtkprint.c out under that flag — upstream guards every print USE with
# #if ENABLE_PRINT but left the definitions unconditional, which would pull the
# missing libgtk members at link (a loud failure under the no-undef contract).
#
# --selftest (patch 0001) is the display-free headless gate (the node harness
# has no compositor): menubar/textview/scrolledwindow class_init through the
# fpcast seam, a GtkTextBuffer "changed" signal fired into an address-taken C
# handler, and gtk_get_major_version()==3 → `L3AFPAD-SELFTEST: ... OK`
# (runtime/demo/node/l3afpad-smoke.mjs). The real editor window is a MANUAL
# browser check.
#
# No GSettings schema (config is ~/.config/l3afpad/l3afpadrc, plain fopen).
# The window icon loads at runtime from the baked ICONDIR store path
# ($out/share/pixmaps/l3afpad.png), so the package must ride the served /nix
# closure via environment.systemPackages — the galculator/gcalctool pattern.
{ cross, pkgs }:
cross.stdenv.mkDerivation {
  pname = "l3afpad";
  # l3afpad links gtk3, so gtk3's propagated hook (deps-overlay.nix) fpcasts
  # $out/bin/l3afpad automatically — no fpcast line here. Opt into the leaf
  # served-closure nix-support strip (#43):
  wasmLeafApp = true;
  # The last rev nixpkgs shipped (24.05); upstream has been quiet since.
  version = "unstable-2022-02-14";

  src = pkgs.fetchFromGitHub {
    owner = "stevenhoneyman";
    repo = "l3afpad";
    rev = "16f22222116b78b7f6a6fd83289937cdaabed624";
    hash = "sha256-ly2w9jmRlprm/PnyC0LYjrxBVK+J0DLiSpzuTUMZpWA=";
  };

  patches = [
    ../patches/l3afpad/0001-add-selftest.patch
    ../patches/l3afpad/0002-compile-out-gtkprint-when-print-disabled.patch
  ];

  nativeBuildInputs = [
    cross.buildPackages.pkg-config
    cross.buildPackages.autoreconfHook # git checkout — no shipped ./configure
    cross.buildPackages.intltool # AC_PROG_INTLTOOL + intltoolize + .desktop merge
    cross.buildPackages.gettext # msgfmt for po/
  ];
  # strictDeps=false (below) also puts these dev outputs' share/aclocal on the
  # aclocal search path — AM_GLIB_DEFINE_LOCALEDIR/AM_GLIB_GNU_GETTEXT come from
  # the cross glib's glib-gettext.m4 (arch-independent m4), the galculator trick.
  # Native glib must stay OUT of the inputs: its glib-2.0.pc requires
  # sysprof-capture-4 (our cross glib is -Dsysprof=disabled) and would shadow
  # the cross one on the pkg-config path (the gcalctool trap).
  buildInputs = [ cross.gtk3 cross.glib ];

  # The intltool/AM_GLIB macro layer predates strictDeps; keep the loose PATH
  # (same posture as galculator/gcalctool/the games tier).
  strictDeps = false;

  # autogen.sh's recipe: autoreconf does NOT run intltoolize, and the git tree
  # has no po/Makefile.in.in — without it config.status dies on po/Makefile.in.
  preAutoreconf = ''
    intltoolize -c --automake --force
  '';

  configureFlags = [ "--disable-print" ]; # no unix-print layer in the cross libgtk

  enableParallelBuilding = true;

  postInstall = ''
    # install-data-hook's gtk-update-icon-cache is a cross wasm binary here, so
    # the `-`-prefixed make rule fails harmlessly and no cache is emitted — but
    # delete defensively: a hicolor icon-theme.cache would collide in the
    # profile symlink merge with every other app's hicolor tree.
    rm -f "$out/share/icons/hicolor/icon-theme.cache"
  '';

  # No dynsym-inject and no manual fpcast: l3afpad wires signals in C (no
  # GtkBuilder autoconnect, gtk3-demo posture), so the standard indirect-call
  # cast fix is all it needs — and that arrives automatically from gtk3's
  # propagated hook. `wasmLeafApp = true` (above) is the whole wasm footprint.

  meta.description = "L3afpad — simple GTK3 text editor (leafpad fork) on wasm32; signals wired in C, no GModule";
}
