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

  # The shared no-undef contract's allow-list (#52, toolchain/wasm-host-imports.nix)
  # — the same file every other guest link passes to wasm-ld via
  # --allow-undefined-file. This build can't use that flag directly (see the
  # --import-undefined comment in configurePhase below), so the FINAL shipped
  # binary is checked against this same list post-link instead (installPhase).
  allowUndefined = import ../toolchain/wasm-host-imports.nix { inherit pkgs; };
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
    # hush: support "N>&WORD" variable fd duplication redirects (e.g. the
    # autoconf-generated ">&$4"), previously a hard PARSE-time "ambiguous
    # redirect" that made every real autoconf `configure` script unparseable
    # under hush. This is what actually makes hush's /bin/sh capable of
    # running real generated configure scripts, not just hand-picked idioms.
    ../patches/busybox/0009-hush-variable-fd-redirect.patch
    # hush: a pre-existing (still-unfixed upstream) bug found while verifying
    # 0009 end-to-end against a real configure — "N<&0" (dup FROM stdin) was
    # misidentified as duplicating hush's own (unset, sentinel-0) interactive
    # fd and refused with a bogus "can't duplicate file descriptor". Every
    # autoconf configure's standard preamble ("exec 7<&0 </dev/null") hits
    # this, so it's a necessary companion fix for the same goal.
    ../patches/busybox/0010-hush-internally-opened-fd0.patch
  ];

  postPatch = ''
    substituteInPlace Makefile --replace-fail '/bin/pwd' 'pwd'
    patchShebangs scripts applets

    # Build-level guard for patches/busybox/0009+0010 (hush >&$fd / <&0
    # fixes): fail LOUDLY if a stacked patch apply silently dropped either
    # hunk (nixpkgs' default patch fuzz is 2 — these were only hand-verified
    # with --fuzz=0) instead of shipping a hush that silently regressed to
    # the parse-time "ambiguous redirect" / the <&0 "can't duplicate file
    # descriptor" bug. Same lesson as the kernel's 0017-0020 postPatch
    # assertion (CLAUDE.md).
    grep -q 'REDIRFD_TO_FD_VAR' shell/hush.c \
      || { echo "ERROR: 0009-hush-variable-fd-redirect.patch didn't apply (REDIRFD_TO_FD_VAR missing from shell/hush.c)" >&2; exit 1; }
    sed -n '/^static int internally_opened_fd/,/^}/p' shell/hush.c | grep -q 'fd != 0' \
      || { echo "ERROR: 0010-hush-internally-opened-fd0.patch didn't apply (internally_opened_fd missing its fd != 0 guard)" >&2; exit 1; }
  '';

  depsBuildBuild = [ pkgs.gcc ];
  nativeBuildInputs = [ pkgs.gnumake binaryen pkgs.python3 ];

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
      #
      # This is the exact blanket flag CLAUDE.md's no-undef contract (#52) warns
      # against (--allow-undefined-file with a named list is the rule everywhere
      # else). It is kept here NOT because kbuild lacks a seam to pass flags
      # (CONFIG_EXTRA_LDFLAGS passes anything fine) but because the CROSS
      # CC-WRAPPER (wasm-cross.nix) itself already bakes in its own
      # `--allow-undefined-file=<the shared list, without capture_stack>` via
      # nix-support/cc-ldflags, and nixpkgs' cc-wrapper appends cc-ldflags AFTER
      # the caller's flags — so a user-supplied --allow-undefined-file naming
      # capture_stack would be LAST-WINS-OVERRIDDEN by the wrapper's own, not
      # merged with it (confirmed empirically: a probe TU compiled with an extra
      # user --allow-undefined-file listing a symbol NOT in the shared list still
      # fails to link — the wrapper's own flag, appended after, wins outright).
      # Passing an allow-list file here would therefore silently NOT relax
      # anything, and a future reader "fixing" this by rewiring kbuild to pass
      # one would find it changes nothing. --import-undefined is the only lever
      # that actually reaches wasm-ld before the wrapper's own flag settles the
      # matter. The asyncify pass below also runs AFTER this link and may itself
      # touch imports, so the meaningful check point is the FINAL shipped binary
      # regardless. installPhase below runs wasm-check-imports.py over the
      # asyncified $out/bin/busybox against the shared allow-list (+ capture_stack)
      # to restore the "a stray unresolved symbol fails loudly" guarantee.
      "CONFIG_EXTRA_LDFLAGS=-Wl,--import-undefined ${muslFork}/lib/libc.a"
    )
    make "''${mk[@]}" wasm_defconfig

    # Real-fork model: flip OFF NOMMU so busybox uses stock fork()+exec everywhere.
    sed -i 's/^CONFIG_NOMMU=y$/# CONFIG_NOMMU is not set/' build/.config
    grep -q '^# CONFIG_NOMMU is not set' build/.config \
      || { echo "ERROR: CONFIG_NOMMU not disabled" >&2; exit 1; }

    # #131 slice-1 invariant asserts (mirrors the CONFIG_NOMMU idiom above and
    # userspace/busybox.nix's configurePhase asserts, PR-2 hardening). These all
    # hold BY CONSTRUCTION today (wasm_defconfig ships them this way and this
    # build applies no disabling sed for any of them) — assert it so a future
    # patches/busybox/0001-wasm-arch.patch regen or defconfig drift fails the
    # BUILD loudly instead of silently shipping a degraded fork guest.
    #
    # IFUP/IFDOWN/TELNETD: OPPOSITE polarity from the NOMMU build, which disables
    # them because their vfork()-exec spawn path has no NOMMU equivalent (see
    # userspace/busybox.nix). Real fork() makes that vfork call site safe again,
    # so the fork build KEEPS them enabled — no reason to leave real applets off
    # once the spawn model they needed actually works.
    for c in IFUP IFDOWN TELNETD; do
      grep -q "^CONFIG_$c=y" build/.config \
        || { echo "ERROR: CONFIG_$c not enabled in .config" >&2; exit 1; }
    done

    # SH_IS_HUSH: hush is the fork guest's shell. The #189 boot-measured idiom
    # matrix (the exact idioms autoconf's preamble/config.status use — variable
    # redirects with LITERAL fds, subshells, pipelines, multi-line if/fi) passes
    # under stock hush with correct exit statuses and zero aborts — unlike stock
    # ash, which SIGABRTs on every subshell via the wasm musl's longjmp abort
    # stub (#188). That is NOT yet the same claim as "a real autoconf-generated
    # ./configure completes under stock hush": one such script fails at parse
    # time on `as_fn_error`'s VARIABLE-fd redirect (`>&$4` — "ambiguous
    # redirect" → "syntax error at 'fi'"), which the idiom matrix didn't cover
    # (LITERAL fds only). A hush variable-fd-redirect fix is landing separately
    # (patches/busybox/00xx-hush-variable-fd-redirect); until it lands, no real
    # ./configure has completed under stock hush on this guest.
    grep -q '^CONFIG_SH_IS_HUSH=y' build/.config \
      || { echo "ERROR: CONFIG_SH_IS_HUSH not enabled in .config" >&2; exit 1; }

    # ASH must stay OFF: the wasm musl's longjmp is an abort() stub
    # (patches/musl/0000-harness-wasm-arch.patch), and stock ash unwinds through
    # longjmp on its normal $()/subshell path, so every subshell child would
    # SIGABRT (exit 134) — see #188/#189. hush is the fork shell; ash is not a
    # fallback.
    grep -q '^# CONFIG_ASH is not set' build/.config \
      || { echo "ERROR: CONFIG_ASH not disabled in .config" >&2; exit 1; }

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

    # #52/#131 slice-1 hardening: this build's -Wl,--import-undefined is the
    # blanket flag the shared no-undef contract forbids everywhere else (kept
    # only because the asyncify seam's capture_stack must stay undefined).
    # Restore the "a stray unresolved symbol fails loudly" guarantee by
    # checking the FINAL shipped binary (asyncify runs after the link and may
    # itself add/keep imports, so this is the meaningful check point) against
    # the SAME shared allow-list every other guest link uses, plus the one
    # documented extra: capture_stack, the asyncify unwind import provided by
    # kernel-worker.js since ENGINE_ABI 10 (fork-variant-only — the NOMMU guest
    # never links this seam).
    python3 ${../scripts/wasm-check-imports.py} "$bb" ${allowUndefined} capture_stack

    runHook postInstall
  '';

  dontStrip = true;
  dontFixup = true;
}
