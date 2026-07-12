# l3afpad 0.8.18.1.11 — the GTK3 fork of leafpad (a Notepad-class text
# editor), the first real *productivity* app on the guest (#122). Where the
# earlier GTK milestones were showcases (gtk-hello, widget-factory, gtk3-demo,
# calculators, games), this is a genuinely useful open/edit/save editor.
#
# Why it is the clean candidate (the gtk3-demo lesson, #121): it is pure C and
# wires every signal in C — menu.c builds the menubar from GtkActionEntry
# tables whose handlers are `G_CALLBACK(on_foo)` function pointers, and
# window.c g_signal_connect()s the rest. It never calls
# gtk_builder_connect_signals(), so there is NO GModule dependency and no .ui
# handler-name resolution — it sidesteps the GModule wall entirely (no dynsym
# inject needed, unlike galculator/gcalctool). Tiny dep set: GTK3 + the
# existing cross closure; no GSettings schema (config is a plain
# ~/.config/l3afpad/l3afpadrc), no plugins.
#
# nixpkgs never packaged l3afpad (only the dead upstream leafpad, long
# removed), so this is a from-scratch derivation (the gcalctool pattern —
# PRIME DIRECTIVE corollary 1 doesn't apply when there is no nixpkgs recipe to
# reuse). Source = the Debian orig tarball (byte-stable mirror of the upstream
# 0.8.18.1.11 GitHub tag; github's on-the-fly archive tarballs are not
# hash-stable for fetchurl). It's the raw git tree — no pre-generated
# ./configure — so the build runs autoreconfHook plus `intltoolize` (the same
# step upstream's autogen.sh and Debian's dh_autoreconf run: configure.ac uses
# AC_PROG_INTLTOOL, and intltoolize installs po/Makefile.in.in + the
# intltool-* helpers autoreconf alone does not).
#
# --disable-print: compiles out gtkprint.c (GtkPrintOperation). The cross gtk3
# is wayland-only/no-cups (deps-overlay.nix) and a printer is meaningless on
# the guest — the same reasoning that dropped pagesetup.c from gtk3-demo.
#
# --selftest (patches/l3afpad/0001-add-selftest.patch) is the display-free
# headless CI gate — the node harness has no compositor, so the real window is
# a MANUAL browser check (open/edit/save a file under /mnt/pc). Gate:
# runtime/demo/node/l3afpad-smoke.mjs matches /L3AFPAD-SELFTEST: .* OK/.
{ cross, pkgs, fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
cross.stdenv.mkDerivation {
  pname = "l3afpad";
  version = "0.8.18.1.11";

  src = pkgs.fetchurl {
    url = "mirror://debian/pool/main/l/l3afpad/l3afpad_0.8.18.1.11.orig.tar.gz";
    hash = "sha256-hvN0svlQt8YN2lCqgKUDS448gN7VzTKEwtWSGzFlJ5M=";
  };

  patches = [ ../patches/l3afpad/0001-add-selftest.patch ];

  nativeBuildInputs = [
    cross.buildPackages.autoreconfHook
    cross.buildPackages.pkg-config
    cross.buildPackages.intltool # IT_PROG_INTLTOOL + intltoolize (git tree, no dist files)
    cross.buildPackages.gettext # msgfmt for po/
    fpcast.binaryen
  ];
  buildInputs = [ cross.gtk3 cross.glib ];

  # configure.ac's AM_GLIB_DEFINE_LOCALEDIR lives in glib's glib-gettext.m4;
  # with strictDeps the cross glib's share/aclocal never reaches aclocal's
  # search path and autoreconf fails on the undefined macro. Same posture as
  # the galculator override (its AM_GLIB_GNU_GETTEXT comes from the same file).
  strictDeps = false;

  # intltoolize installs po/Makefile.in.in + the intltool build helpers the
  # tarball doesn't ship (upstream autogen.sh runs it; autoreconf does not).
  preAutoreconf = ''
    intltoolize --automake --copy --force
  '';

  configureFlags = [ "--disable-print" ];

  enableParallelBuilding = true;

  postFixup = ''
    ${fpcast.shellFn}
    # gobject/GTK C function-pointer casts (GtkActionEntry callbacks, gobject
    # class_init) → strict wasm call_indirect traps without the shared
    # binaryen --fpcast-emu post-link pass. No dynsym inject: no GtkBuilder
    # handler-name dlsym resolution anywhere (signals are wired in C).
    fpcast_emu "$out/bin/l3afpad" "$out/bin/l3afpad.fpcast"
    mv "$out/bin/l3afpad.fpcast" "$out/bin/l3afpad"
    chmod +x "$out/bin/l3afpad"
    # Leaf app: drop the propagated -dev closure metadata (the #43 lesson —
    # it drags the whole X11/-dev tree into the served store).
    rm -rf "$out/nix-support"
  '';

  meta.description = "L3afpad (GTK3 leafpad fork) on wasm32 — the first real productivity app on the guest; signals wired in C, no GModule";
}
