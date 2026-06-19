# The wasm32-linux-musl NOMMU busybox — the guest's init + shell + coreutils,
# built from busybox 1.36.1 + the harness wasm-arch/clone-spawn patch.
#
# WHY a custom derivation and not nixpkgs `cross.busybox`: stock busybox spawns
# children with fork()/vfork()+exec. On the wasm NOMMU clone-with-fn model a raw
# fork/vfork CANNOT return twice (a fresh wasm instance can't resume the parent
# mid-function), so those calls read garbage and the child SIGILLs. The harness
# patch (patches/busybox/0001-wasm-arch-and-clone-spawn.patch) rewrites every
# spawn site (init/init.c run(), hush.c pipe exec, the decompressors) to
# `clone(child_fn, CLONE_VM | CLONE_VFORK | SIGCHLD)` — musl's clone-WITH-a-fn
# path, which IS implemented on the new exec ABI (the child re-enters
# __libc_clone_callback and call_indirect's the stored fn). This is THE fix that
# makes the in-guest userspace actually run. The patch also adds arch/wasm and
# configs/wasm_defconfig (CONFIG_NOMMU=y, CONFIG_STATIC=y, hush as /bin/sh,
# FEATURE_PREFER_APPLETS off, applet symlinks on).
#
# TOOLCHAIN: the `cross` stdenv cc-wrapper (wasm-cross.nix) — the SAME wrapper
# nix.wasm and every cross.* dep use. NOT the kernel's fake-llvm shim: that's a
# kbuild-specific hack (argv rewriting in Python) the kernel needs for its exotic
# EXPORT_SYMBOL asm / vmlinux.lds / objcopy, and its conditional `-shared`
# handling makes clang pick the reactor crt (`crt1-reactor.o` + `--entry
# _initialize`) — which, since nothing is reachable from `_initialize`, garbage-
# collects ALL the applet code into an empty 700-byte module. The cross cc-wrapper
# selects the command crt (`crt1.o`, `_start`/`main`) so `main` seeds the applet
# dependency graph, and injects the dylink link flags (--export-all, import-memory,
# shared-memory, …) + the flag-filtering wasm-ld (which already special-cases
# busybox's `-r` built-in.o combine). Result: a real ~1.5MB dylink wasm module,
# same toolchain path as the rest of the guest.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix; # "wasm32-unknown-linux-musl-"
in
cross.stdenv.mkDerivation {
  pname = "busybox-wasm32-nommu";
  version = "1.36.1";

  src = pkgs.fetchurl {
    url = "https://busybox.net/downloads/busybox-1.36.1.tar.bz2";
    hash = "sha256-uMwkyVdNgJ5yecO+NJeVxdXOtv3xnKcJ+AzeUOR94xQ=";
  };

  patches = [
    ../patches/busybox/0001-wasm-arch-and-clone-spawn.patch
    # The 0001 patch converted run_pipe's command fork but left $(...) command
    # substitution on vfork(); convert it to clone-with-fn too (NOMMU can't vfork).
    ../patches/busybox/0003-hush-cmdsub-clone.patch
    # The remaining NOMMU vfork+exec spawn paths: libbb spawn()/fork_or_rexec()
    # (the shared helpers behind spawn_and_wait/bb_daemonize_or_rexec) + timeout.
    ../patches/busybox/0004-libbb-spawn-clone.patch
    # tar's vfork_compressor (tar.c): the compress-on-create child still used
    # xvfork → musl abort. clone-with-fn so `tar czf` (and bzip2/xz) work. (The
    # decompress side, fork_transformer, was already converted in 0001.)
    ../patches/busybox/0005-tar-compressor-clone.patch
    # hush's heredoc writer (setup_heredoc, >pipe-buf heredocs): nested xvfork →
    # clone-with-fn. The last reachable vfork in a kept/core applet — the rest of
    # busybox's ~24 vfork applets (daemons/servers/edge tools) are DISABLED in the
    # config below rather than patched, so they can never be invoked and crash.
    ../patches/busybox/0006-hush-heredoc-clone.patch
  ];

  # busybox's Makefile resolves the O= dir via a hardcoded `/bin/pwd`, which
  # doesn't exist in the Nix sandbox; use the PATH `pwd`. Also rewrite the
  # `#!/usr/bin/env`-style shebangs in the kbuild scripts to store paths.
  postPatch = ''
    substituteInPlace Makefile --replace-fail '/bin/pwd' 'pwd'
    patchShebangs scripts applets
  '';

  # gnumake drives the build; gcc builds busybox's own kconfig host tools
  # (HOSTCC). The cross toolchain comes from cross.stdenv (CC/AR/… set below).
  depsBuildBuild = [ pkgs.gcc ];
  nativeBuildInputs = [ pkgs.gnumake ];

  # The patched busybox Makefile hardcodes CC=$(CROSS_COMPILE)clang, LD=ld.lld,
  # AR=llvm-ar, …; we override each on the command line (recursive `=` vars yield
  # to command-line assignment) to the cross cc-wrapper's tools. CC is the wrapped
  # clang (injects --target/sysroot/wasm features + the dylink ldflags); LD is the
  # FILTERED wasm-ld (drops ELF-only flags, handles the `-r` built-in.o combine).
  # CONFIG_EXTRA_CFLAGS supplies only the musl-patched kernel UAPI headers
  # (-isystem, ahead of the sysroot's unpatched linux/*.h); the wrapper provides
  # the rest. SYSROOT is left to the wrapper.
  configurePhase = ''
    runHook preConfigure
    mkdir -p build   # O=build (out-of-tree); kbuild requires it to pre-exist
    mk=(
      O=build
      ARCH=wasm
      HOSTCC=gcc
      "CC=${cc}/bin/${p}cc"
      "LD=${cc}/bin/wasm-ld"
      "AR=${cc}/bin/${p}ar"
      "NM=${cc}/bin/${p}nm"
      "STRIP=${cc}/bin/${p}strip"
      "OBJCOPY=${cc}/bin/${p}objcopy"
      "CONFIG_SYSROOT="
      "CONFIG_EXTRA_CFLAGS=-isystem ${busyboxKernelHeaders}"
      "CONFIG_EXTRA_LDFLAGS="
    )
    make "''${mk[@]}" wasm_defconfig

    # Curated NOMMU surface: DISABLE every applet that still spawns via vfork() and
    # that the guest doesn't need (network servers/clients, service supervisors,
    # cron, mail, misc) — so an unpatched vfork can never be reached and abort
    # ("vfork() is not implemented yet"). The core/kept spawn paths (hush run_pipe/
    # cmdsub/heredoc, libbb spawn/fork_or_rexec, tar, fork_transformer, timeout) are
    # converted to clone-with-a-fn by the patches above; everything else with a live
    # vfork is removed here. `time` is dropped too (marginal; its applet vfork isn't
    # worth keeping). Disabling rather than patching is the deliberate choice (no
    # landmines). olddefconfig then re-resolves deps.
    for c in CROND CRONTAB CONSPY SCRIPT RUNSV SVLOGD RUNSVDIR OPENVT \
             FTPD HTTPD INETD NC TCPSVD UDPSVD WGET REFORMIME SENDMAIL MAKEMIME \
             POPMAILDIR START_STOP_DAEMON BOOTCHARTD NSENTER TIME \
             FEATURE_TAR_TO_COMMAND; do
      sed -i "s/^CONFIG_$c=y\$/# CONFIG_$c is not set/" build/.config
    done
    # Colorized `ls` with NO alias/env var: busybox's LS_COLOR_IS_DEFAULT makes the
    # applet emit ANSI colors whenever stdout is a tty (it ignores $LS_COLORS and
    # uses a built-in palette). GNU coreutils can't do this without `--color=auto`;
    # busybox can, so the guest gets colored ls in scripts and subshells too, with
    # zero profile config.
    for c in FEATURE_LS_COLOR FEATURE_LS_COLOR_IS_DEFAULT; do
      sed -i "s/^# CONFIG_$c is not set\$/CONFIG_$c=y/" build/.config
      grep -q "^CONFIG_$c=y" build/.config || echo "CONFIG_$c=y" >> build/.config
    done
    # No `make olddefconfig` (busybox 1.36 kconfig has no such target); the build
    # regenerates include/autoconf.h from .config via silentoldconfig, which keeps
    # these existing values disabled. Sanity-check a few stuck.
    for c in CROND HTTPD WGET NC TIME; do
      grep -q "^# CONFIG_$c is not set" build/.config \
        || { echo "ERROR: CONFIG_$c not disabled in .config" >&2; exit 1; }
    done
    for c in FEATURE_LS_COLOR_IS_DEFAULT; do
      grep -q "^CONFIG_$c=y" build/.config \
        || { echo "ERROR: CONFIG_$c not enabled in .config" >&2; exit 1; }
    done
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make "''${mk[@]}" -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make "''${mk[@]}" CONFIG_PREFIX=$out install

    # busybox's default install splits applets across bin/sbin/usr/{bin,sbin}
    # (getty/init/syslogd land in sbin). The guest profile + inittab address every
    # applet at /run/current-system/sw/bin/<name>, and nixpkgs' own busybox
    # flattens the same way. Every applet is just a symlink to the single busybox
    # binary, so re-point them all into $out/bin -> busybox and drop the split
    # dirs + the linuxrc alias.
    for d in sbin usr/bin usr/sbin; do
      [ -d "$out/$d" ] || continue
      for f in "$out/$d"/*; do
        n=$(basename "$f")
        [ "$n" = busybox ] && continue
        ln -sf busybox "$out/bin/$n"
      done
      rm -rf "$out/$d"
    done
    rmdir "$out/usr" 2>/dev/null || true
    rm -f "$out/linuxrc"

    runHook postInstall
  '';

  # The output is a wasm module, not a host ELF; nixpkgs' fixup (strip/patchelf)
  # would choke on it.
  dontStrip = true;
  dontFixup = true;
}
