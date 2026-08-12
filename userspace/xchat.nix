# xchat — M-X5 of the XChat/X11 epic, the headline app the whole stack (Xvfb,
# xeyes/xwd/xdpyinfo, GTK2-over-X11) was built to run. XChat 2.8.8, the last
# upstream release (project dead since ~2010; nixpkgs dropped it years ago —
# no by-name/x shard at our 9ae611a pin, no alias), fetched as the pristine
# source tarball from xchat.org (the archive.org-mirrored Debian orig tarball
# is the same bytes; xchat.org's own /files/source/ mirror is still live and
# is the source of record here). A from-scratch derivation, like
# gcalctool/l3afpad — no native fallback exists (isWasm-guarded null below).
#
# UNLIKE l3afpad/galculator this ships with a pregenerated ./configure (a
# release tarball, not a git checkout) — no autoreconfHook/intltoolize dance.
# GTK2 signals are wired entirely in C (menu.c's arrays + g_signal_connect;
# grep confirms zero GtkBuilder/.glade/.ui use anywhere in src/fe-gtk), so —
# like gtk3-demo/l3afpad, and unlike galculator — XChat has NO GModule
# dependency; it needs only the gtk2 fpcast-emu seam (ridden automatically via
# gtk2's propagatedNativeBuildInputs, same as gtk2-hello/l3afpad get it).
#
# --- fork holdouts (docs/process-model.md's decision rule) -----------------
# XChat 2.8.8 has exactly three non-Windows fork() call sites, all fixed by
# patches/xchat/0001-wasm-posix-spawn-and-pthread-nofork.patch:
#   1. util_exec()/util_execv() (src/common/util.c) -- a plain fork+exec used
#      by the /EXEC family and the sound-player invocation. Real spawn API
#      with nothing shared after the fork -> rule 2, ported to
#      posix_spawnp()/posix_spawn().
#   2. cmd_exec() (src/common/outbound.c, the /EXEC command's socketpair +
#      dup2 + exec dance for piping a shell command's output into a
#      channel tab) -- also a genuine fork+exec, no shared state survives
#      it -> rule 2, ported to posix_spawn() + posix_spawn_file_actions
#      (adddup2 for the child's stdin/stdout/stderr, addclose for the
#      parent's pipe end -- the same fd setup the manual fork child used to
#      do by hand, now applied atomically by posix_spawn between clone()
#      and exec()).
#   3. server_connect()'s DNS-resolve/connect child (src/common/server.c) --
#      the ONE holdout that is NOT fork+exec: it forks, runs
#      server_child() (blocking name resolution + connect(), reporting
#      progress back over a pipe) IN PLACE, and _exit()s -- no exec at all.
#      There is no posix_spawn to port this to. XChat's own WIN32 port hits
#      this exact wall already (Windows has no fork()) and solves it with a
#      CreateThread() running server_child() in the parent's address space
#      instead of forking a child process -- we follow that precedent
#      exactly, with a POSIX pthread. Disclosed trade-off documented at the
#      patch site: cancelling an in-flight connection attempt can no longer
#      SIGKILL the resolver (it's a thread, not a process) -- closing the
#      pipe makes it stop reporting results, but a slow getaddrinfo() may
#      keep running in the background for up to its own timeout.
#   /EXEC's own fd-hygiene loop (closing every fd above 2 before exec, so a
#   spawned shell command doesn't inherit XChat's own sockets) has no
#   posix_spawn_file_actions equivalent (no "closefrom" action) and is a
#   disclosed, not silent, gap -- see the patch's util_exec()/cmd_exec()
#   comments.
#
# --- configure surface (kept minimal for the first green build) ------------
#   --enable-gtkfe                 the GTK2 frontend (the only one built)
#   --disable-textfe                (already configure's default)
#   --disable-plugin --disable-perl --disable-perl_old --disable-python
#     --disable-tcl                 no plugin interpreters (dlopen; their
#                                    own epic -- Track C dlopen now WORKS,
#                                    see docs/process-model.md, so lighting
#                                    plugins up is a viable follow-up, just
#                                    not in scope here)
#   --disable-dbus                  no D-Bus session on this guest
#   --disable-openssl               DEFERRED, not just "not built yet": src/
#                                    common/{server,ssl}.c reach directly into
#                                    struct fields OpenSSL made opaque in
#                                    1.1.0+ (X509_STORE_CTX::current_cert,
#                                    SSL::session, X509::cert_info/sig_alg) and
#                                    call SSLv3_client_method()/
#                                    SSLv3_server_method(), REMOVED outright in
#                                    1.1.0 -- our cross openssl is 3.6.2. This
#                                    is real, separate porting work (accessor
#                                    functions + TLS_method()), not a config
#                                    flag; cross openssl (deps-overlay.nix)
#                                    exists and is ready the day someone does
#                                    it. Follow-up, tracked in the M-X5 report,
#                                    not silently dropped.
#   --enable-spell=none             no libsexy/gtkspell/enchant cross build
#   --disable-ipv6                  (already configure's default; explicit)
#   --disable-nls                   no gettext .mo compilation for the first
#                                    build; the 27-language po/ tree is
#                                    functionality, not a build blocker --
#                                    revisit if translated UI is ever wanted
#   --disable-socks --disable-xft --enable-shm=no --enable-ntlm=no
#                                    (all already configure's defaults;
#                                    explicit for clarity)
# MMX (src/common/../fe-gtk/mmx_cmod.S, i386 SIMD tinting) self-disables via
# configure's own `case $host_cpu in i386|...)` gate -- wasm32 falls to the
# `*)` no-op branch, no flag needed.
{ cross, pkgs }:
cross.stdenv.mkDerivation rec {
  pname = "xchat";
  version = "2.8.8";

  src = pkgs.fetchurl {
    url = "https://xchat.org/files/source/2.8/xchat-${version}.tar.bz2";
    hash = "sha256-DW1pQ3teHkXz5mJw/jaTRJQ96KEZDkmPr6UpYxWifbA=";
  };

  patches = [
    ../patches/xchat/0001-wasm-posix-spawn-and-pthread-nofork.patch
    # Not wasm-specific: xchat.h/util.c/servlist.c/text.c include individual
    # glib subheaders directly (<glib/gslist.h>, <glib/ghash.h>, ...), which
    # glib >= 2.32 or so rejects ("Only <glib.h> can be included directly.")
    # -- 2.8.8 predates that guard. Any 2026-era glib (native OR cross) hits
    # this identically; fold the individual includes into <glib.h>. (glib/
    # gi18n.h and glib/gprintf.h are genuinely standalone convenience headers
    # with no such guard and are left alone; the untouched dbus-plugin.c and
    # sexy-spell-entry.c uses of glib/gi18n.h are in code we don't build
    # anyway, --disable-dbus / --enable-spell=none.)
    ../patches/xchat/0002-glib-2.88-header-compat.patch
    ../patches/xchat/0003-add-selftest.patch
  ];

  # gdk-pixbuf-csource is a codegen tool (embeds the tray/notification PNGs
  # as inline C source, src/pixmaps/Makefile.am) that RUNS at build time --
  # it must be the NATIVE (build-platform) gdk-pixbuf, not the wasm cross
  # one (which produces a wasm binary that can't execute on the builder).
  nativeBuildInputs = [ cross.buildPackages.pkg-config cross.buildPackages.gdk-pixbuf ];
  # gtk2's own propagatedBuildInputs already carry glib/pango/cairo/atk/
  # gdk-pixbuf's .pc files onto PKG_CONFIG_PATH (the same transitive
  # resolution gtk2-hello/l3afpad rely on). No openssl here -- see
  # --disable-openssl below.
  buildInputs = [ cross.gtk2 cross.glib ];

  # XChat's bundled AM_PATH_GTK_2_0 (a ~2007 gtk+-2.0.m4, well before
  # cross-pkg-config awareness) does its OWN ad-hoc pkg-config discovery
  # instead of using the modern PKG_CHECK_MODULES macro (which correctly
  # falls back to "${PKG_CONFIG:-pkg-config}"): it PATH-searches literally
  # for a binary named "pkg-config", and only honors a pre-set $PKG_CONFIG
  # if it's ALREADY an absolute path. nixpkgs' cross setup hook exports
  # $PKG_CONFIG as the bare cross-prefixed name (`wasm32-unknown-linux-musl-
  # pkg-config`) precisely so a plain "pkg-config" lookup does NOT
  # accidentally resolve to the native tool -- which is exactly what defeats
  # this macro's literal search. First symptom: configure quietly printed
  # "checking for GTK+ ... no" / "Cannot find GTK! Not building GTK
  # FrontEnd." and produced a `share/`-only package with NO $out/bin/xchat
  # at all (no error, no fe-gtk subdir built) -- `--enable-gtkfe` alone does
  # nothing once AM_PATH_GTK_2_0 has already set no_gtk=yes. Fix: hand it an
  # ABSOLUTE path so its `[\\/]* | ?:[\\/]*` override case matches.
  #
  # That alone still isn't enough, though: `AM_PATH_GTK_2_0`'s pkg-config
  # discovery shares its autoconf CACHE VARIABLE name (`ac_cv_path_PKG_CONFIG`)
  # with an EARLIER, unrelated `AM_PATH_GLIB_2_0`-style check elsewhere in the
  # same `configure` run -- and that earlier check's own `${ac_tool_prefix}
  # pkg-config` PATH search (which DOES find our cross-prefixed
  # `wasm32-unknown-linux-musl-pkg-config` on PATH, hence "checking pkg-config
  # is at least version 0.16... yes" a few lines before the GTK failure)
  # leaves that autoconf cache variable in a state the later GTK block does
  # NOT end up reusing (traced by hand through the generated `configure`;
  # the two checks' control flow diverges enough that the cache hit never
  # fires and the GTK block re-runs its OWN literal "pkg-config" PATH search).
  # Exporting the `ac_cv_path_PKG_CONFIG` shell variable directly seeds
  # autoconf's cache-check (`if test "${ac_cv_path_PKG_CONFIG+set}" = set`,
  # which a plain environment variable also satisfies) BEFORE either block's
  # discovery runs, so both short-circuit to "(cached) <path>" -- the
  # standard autoconf escape hatch for a macro whose own probing can't be
  # trusted, rather than patching the generated `configure` script by hand.
  env.PKG_CONFIG = "${cross.buildPackages.pkg-config}/bin/${cross.stdenv.hostPlatform.config}-pkg-config";
  env.ac_cv_path_PKG_CONFIG = "${cross.buildPackages.pkg-config}/bin/${cross.stdenv.hostPlatform.config}-pkg-config";

  # Getting the DISCOVERY right (above) still isn't the end of it: once
  # discovered, `AM_PATH_GTK_2_0`'s minimum-pkg-config-version check calls
  # the BARE, unprefixed `pkg-config` command literally --
  # `if pkg-config --atleast-pkgconfig-version 0.7` -- instead of `$PKG_CONFIG`,
  # a genuine bug baked into this ~2007 macro itself (confirmed: "./configure:
  # line 16823: pkg-config: command not found" even with $PKG_CONFIG/
  # $ac_cv_path_PKG_CONFIG both correctly resolving to the cross-prefixed
  # binary one line earlier). No env var can fix a literal, unprefixed
  # command invocation. Same shim trick as l3afpad/galculator's native-xz-bin
  # PATH shim for autopoint's bare `xz` call: put a `pkg-config` shim on PATH,
  # pointing at the exact cross-prefixed binary, scoped to this build only.
  preConfigure =
    let
      pkgConfigBin = "${cross.buildPackages.pkg-config}/bin/${cross.stdenv.hostPlatform.config}-pkg-config";
    in
    ''
      # $PKG_CONFIG as set via `env.PKG_CONFIG` above gets CLOBBERED back to
      # the bare (non-absolute) cross-prefixed name by pkg-config's own
      # setup-hook, which runs (as part of stdenv sourcing every
      # nativeBuildInputs setup hook) AFTER our derivation-level env is
      # established but BEFORE this preConfigure hook -- so by the time we
      # get here `$PKG_CONFIG` is back to a bare name again. Interpolate the
      # absolute store path directly from Nix instead of trusting the shell
      # env var survives to this point.
      mkdir -p .wasm-pkg-config-shim
      ln -sf "${pkgConfigBin}" .wasm-pkg-config-shim/pkg-config
      export PATH="$PWD/.wasm-pkg-config-shim:$PATH"
      export PKG_CONFIG="${pkgConfigBin}"
      export ac_cv_path_PKG_CONFIG="${pkgConfigBin}"
    '';

  configureFlags = [
    "--enable-gtkfe"
    "--disable-textfe"
    "--disable-plugin"
    "--disable-perl"
    "--disable-perl_old"
    "--disable-python"
    "--disable-tcl"
    "--disable-dbus"
    "--disable-openssl"
    "--enable-spell=none"
    "--disable-ipv6"
    "--disable-nls"
    "--disable-socks"
    "--disable-xft"
    "--enable-shm=no"
    "--enable-ntlm=no"
  ];

  enableParallelBuilding = true;

  # No GtkBuilder/.glade/.ui anywhere (menu.c wires signals in C) -> no
  # GModule dependency, so gtk2's propagated fpcast-emu hook is all this
  # needs (same posture as l3afpad/gtk3-demo). Drop the -dev propagation
  # from the served-image closure (#43's galculator/l3afpad lesson).
  postFixup = ''rm -rf "$out/nix-support"'';

  meta.description = "XChat 2.8.8 IRC client (GTK2, X11) on wasm32 -- the M-X5 headline of the XChat/X11 epic";
}
