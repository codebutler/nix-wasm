# The REAL-FORK wasm32-linux-musl busybox — #131 slice 1. Retires the NOMMU
# clone-with-fn spawn hack (userspace/busybox.nix) now that real fork() works on
# the software MMU + COW (#128 A2 / #129 Track B). This is the busybox that boots
# as init on .#kernel-mmu-a2 and runs a genuine multi-process system.
#
# HOW IT DIFFERS FROM userspace/busybox.nix (the NOMMU build):
#   1. CONFIG_NOMMU=n. busybox's BB_MMU macro flips to 1, so every applet uses the
#      STOCK fork()+exec / fork()+direct-applet-call spawn model instead of the
#      NOMMU vfork/re-exec dance. That is exactly the COW-fork model the software
#      MMU now provides — a child gets its own COW page table and diverges on
#      write. No shared-memory error-reporting trick (the BB_MMU=0-only path) is
#      compiled, so the concern that made vfork-as-fork look unsafe never arises.
#   2. patches/busybox/0001-wasm-arch.patch — 0001 with the five clone-spawn
#      conversion files (init/init.c, shell/hush.c, the three archival
#      decompressors) REMOVED, leaving only the wasm arch/build support
#      (Makefile{,​.flags}, arch/wasm/Makefile, wasm_defconfig, trylink, the
#      wasm setjmp/longjmp portability fixes in test.c/vi.c/fdisk.c). Stock
#      fork/vfork call sites are thus preserved. Patches 0003–0008 (all further
#      clone-spawn / NOMMU-argv conversions) are dropped entirely.
#   3. muslFork is linked FIRST (its libc.a before the sysroot -lc) so the
#      asyncify-seam _Fork() wins, and vfork() resolves to muslFork's
#      vfork-as-fork (see toolchain/musl.nix). fork()/vfork() therefore return
#      twice through the engine's capture_stack unwind.
#   4. A host `wasm-opt --asyncify` pass runs over the final module, whole-module
#      (the fork call graph is spread across init/hush/libbb/tar/decompressors and
#      reached through busybox's applet_main[] function-pointer dispatch, so a
#      bounded addlist can't be enumerated — same reason forkStdenv instruments
#      the whole module). The engine additionally software-MMU-instruments this
#      module AT LOAD (kernel-worker.js, gated on pt_base != 0).
#
# The GUI/no-fork guest keeps userspace/busybox.nix (clone-with-fn, no asyncify
# tax). This build is opt-in for the fork-on-MMU boot path.
#
# STATUS (#131 slice 1, 2026-07): builds clean; whole-module asyncify over the
# 1.26MB module succeeds (→4.48MB, the feared -shared dylink-table break did NOT
# occur once the full --enable-* feature set is passed). It BOOTS as PID 1 on
# .#kernel-mmu-a2, init fork+execs /bin/sh, and the SHELL runs full multi-command
# scripts with forked external commands (runtime/demo/node/busybox-fork-smoke.mjs).
#
# HISTORY — the "shell fork mis-rewind" (task #5, RESOLVED 2026-07-08). A shell
# that fork()+wait()ed a NON-last external command appeared to resume at the
# wrong continuation and exit early. That was NEVER a fork/asyncify defect: hush
# installs a SIGCHLD handler (CONFIG_HUSH_FAST), and musl's wasm
# __libc_handle_signal read the sigframe's info_param through a stray-constant
# ABSOLUTE load of address 8 (NULL page) — harmless-by-luck on NOMMU (physical
# addr 8 reads 0), a silent SIGSEGV kill on the software MMU's first handler
# delivery. Fixed in patches/musl/0000-harness-wasm-arch.patch (info_param =
# [SP+4|8]); regression gates: .#deepfork-sig-child (the minimal repro — deep
# fork+wait WITH a SIGCHLD handler) + the shell-script assertion in
# busybox-fork-smoke. The isolation suite that disproved the fork-machinery
# theories lives in userspace/deepfork-*.c / grandfork-*.c.
{ pkgs, cross, muslFork, busyboxKernelHeaders, binaryen ? pkgs.buildPackages.binaryen }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix; # "wasm32-unknown-linux-musl-"
in
cross.stdenv.mkDerivation {
  pname = "busybox-wasm32-fork";
  version = "1.36.1";

  src = pkgs.fetchurl {
    url = "https://busybox.net/downloads/busybox-1.36.1.tar.bz2";
    hash = "sha256-uMwkyVdNgJ5yecO+NJeVxdXOtv3xnKcJ+AzeUOR94xQ=";
  };

  patches = [
    # 0001 minus the clone-spawn conversion files — wasm arch/build support only.
    # Stock fork()/vfork() spawn sites are preserved for the real-fork model.
    ../patches/busybox/0001-wasm-arch.patch
  ];

  postPatch = ''
    substituteInPlace Makefile --replace-fail '/bin/pwd' 'pwd'
    patchShebangs scripts applets
  '';

  depsBuildBuild = [ pkgs.gcc ];
  nativeBuildInputs = [ pkgs.gnumake binaryen ];

  configurePhase = ''
    runHook preConfigure
    mkdir -p build
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
      # muslFork's libc.a FIRST on the link line so its asyncify-seam _Fork() and
      # vfork-as-fork override the sysroot musl's clone-syscall versions. Every
      # other archive member is byte-identical to the sysroot's, so no ODR risk.
      # --import-undefined keeps the seam's `capture_stack` (the asyncify unwind
      # trigger, host-provided at runtime like the syscall imports) an undefined
      # import instead of a link error — same as userspace/asyncify-cc.nix.
      "CONFIG_EXTRA_LDFLAGS=-Wl,--import-undefined ${muslFork}/lib/libc.a"
    )
    make "''${mk[@]}" wasm_defconfig

    # Real-fork model: flip OFF NOMMU so busybox uses stock fork()+exec everywhere.
    sed -i 's/^CONFIG_NOMMU=y$/# CONFIG_NOMMU is not set/' build/.config
    grep -q '^# CONFIG_NOMMU is not set' build/.config \
      || { echo "ERROR: CONFIG_NOMMU not disabled" >&2; exit 1; }

    # Colorized ls with no env config (same as the NOMMU build).
    for c in FEATURE_LS_COLOR FEATURE_LS_COLOR_IS_DEFAULT; do
      sed -i "s/^# CONFIG_$c is not set\$/CONFIG_$c=y/" build/.config
      grep -q "^CONFIG_$c=y" build/.config || echo "CONFIG_$c=y" >> build/.config
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

    # Flatten the bin/sbin/usr split into $out/bin (same as the NOMMU build).
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

    # Whole-module asyncify for the fork seam (env.capture_stack is the unwind
    # import). The full wasm feature set must be enabled so the pass preserves the
    # dylink module's threads/bulk-memory/reference-types shape.
    bb=$out/bin/busybox
    echo "[busybox-fork] asyncify $(wc -c < "$bb") bytes ..."
    wasm-opt \
      --enable-threads --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-reference-types --enable-multivalue \
      --asyncify \
      --pass-arg=asyncify-imports@env.capture_stack \
      "$bb" -o "$bb.fork"
    mv "$bb.fork" "$bb"
    chmod +x "$bb"
    echo "[busybox-fork] asyncified -> $(wc -c < "$bb") bytes"
    runHook postInstall
  '';

  dontStrip = true;
  dontFixup = true;
}
