# autotools-fixture-hush-check.nix — the host-side, hermetic PROOF that
# patches/busybox/0009-hush-variable-fd-redirect.patch +
# 0010-hush-internally-opened-fd0.patch make busybox hush capable of running
# a REAL generated autoconf `configure` end to end.
#
# HISTORY: this derivation started life (2026-08-12 review, P2-1) as a
# reproduction of the GAP those two patches fix — autoconf's `as_fn_error`
# helper does `... >&$4` (a VARIABLE-fd redirect, not a literal `>&5`), which
# stock hush's parser rejected outright ("hush: ambiguous redirect" /
# "hush: syntax error at 'fi'" — the #189 hush measurement matrix only
# exercised LITERAL fds and so never caught it), and a second, independent,
# still-unfixed-upstream bug made `exec 7<&0 </dev/null` (autoconf's
# universal preamble) fail with a bogus "can't duplicate file descriptor".
# Both fixes landed in the SAME change as this flip (patches/busybox/0009 +
# 0010, wired into busybox-fork.nix/busybox.nix/ash.nix — see CLAUDE.md's
# "hush can't run a real autoconf configure at all without two independent
# fixes" learnings entry), so this derivation now builds a NATIVE busybox
# WITH those two patches applied and asserts the full chain succeeds instead
# of reproducing the failure. A derivation failure here IS the gate failing —
# wired as a hard `nix build` step in nix-wasm.yml, not soak/on-demand.
#
# UPDATE (2026-08-13, #193): a THIRD hush bug was found the same way as the
# first two — running the fixture `configure` for real, this time against a
# SABOTAGED (always-failing) compiler under the patched hush, in-guest
# during a soak. A bare "exit" run FROM WITHIN autoconf's universal
# `ac_exit_trap` EXIT-trap handler ("... && exit $exit_status" with
# $exit_status deliberately left empty) must resume the exit status that
# was PENDING before the trap fired (POSIX; bash/dash both do this) — hush
# instead resumed whatever the trap body's own cleanup commands (a
# successful "rm -f -r ...") last left in $?, so a genuinely FATAL
# `configure` reported CFGRC=0. Fixed by
# patches/busybox/0011-hush-exit-trap-status.patch (also wired here); this
# derivation's step 6 (below) reproduces the same shape hermetically (a
# sabotaged cc on PATH) as a hard NEGATIVE gate — every check before it only
# proved the HAPPY path, which could not have caught this.
#
# WHY A FRESH NATIVE BUSYBOX (not nixpkgs' own `pkgs.busybox`): the two
# patches were authored + `patch -p1 --fuzz=0` verified against pristine
# busybox-1.36.1 (the exact version userspace/busybox.nix, busybox-fork.nix,
# and ash.nix all build) — building the SAME source+patch pair here, just
# with a native (not wasm32-cross) stdenv, makes this an EXACT proof of
# `shell/hush.c` as it's compiled for **busybox-fork.nix** (the fork/MMU
# guest's `/bin/sh` — this derivation's actual target). It is only a
# REPRESENTATIVE proof for busybox.nix/ash.nix (the NOMMU guest's hush):
# those two additionally compile `shell/hush.c` with `CONFIG_NOMMU=y`, and
# busybox.nix layers three more hush patches on top (0003-hush-cmdsub-clone +
# 0006-hush-heredoc-clone, the NOMMU clone-spawn conversions of hush's
# `$()`/heredoc paths — see the busybox-fork.nix header's "HOW IT DIFFERS"
# section), none of which this check builds or exercises. Low real-world
# impact (NOMMU's actual `/bin/sh` is forkshell ash, not hush — see
# `bootstrap.nix`), but worth being precise about: this is the fork guest's
# exact hush, not a universal one. The build is native x86_64, no cross
# toolchain anywhere in this derivation, and small (~2 min).
{ pkgs, fixture }:
let
  # Native (host-arch) busybox carrying ONLY the two hush fixes — no wasm
  # arch/build patches (0001 etc.) at all; this is a plain host build.
  hushBusybox = pkgs.stdenv.mkDerivation {
    pname = "busybox-native-hush-check";
    version = "1.36.1";

    src = pkgs.fetchurl {
      url = "https://busybox.net/downloads/busybox-1.36.1.tar.bz2";
      hash = "sha256-uMwkyVdNgJ5yecO+NJeVxdXOtv3xnKcJ+AzeUOR94xQ=";
    };

    patches = [
      ../patches/busybox/0009-hush-variable-fd-redirect.patch
      ../patches/busybox/0010-hush-internally-opened-fd0.patch
      # hush: a bare "exit" run FROM WITHIN the EXIT (trap 0) handler must
      # resume the exit status that was PENDING before the trap fired
      # (POSIX; bash/dash both do this), not whatever the trap body's own
      # commands last left in $?. This is what THIS derivation's own
      # negative case (below) exists to catch — see its comment for the
      # full #193 finding.
      ../patches/busybox/0011-hush-exit-trap-status.patch
    ];

    postPatch = ''
      # Same build-level guard as the three wasm consumers (busybox-fork.nix,
      # busybox.nix, ash.nix) — fail LOUDLY if a stacked patch apply silently
      # dropped a hunk instead of shipping a stale hush to this check.
      grep -q 'REDIRFD_TO_FD_VAR' shell/hush.c \
        || { echo "ERROR: 0009-hush-variable-fd-redirect.patch didn't apply (REDIRFD_TO_FD_VAR missing from shell/hush.c)" >&2; exit 1; }
      sed -n '/^static int internally_opened_fd/,/^}/p' shell/hush.c | grep -q 'fd != 0' \
        || { echo "ERROR: 0010-hush-internally-opened-fd0.patch didn't apply (internally_opened_fd missing its fd != 0 guard)" >&2; exit 1; }
      # Tightened (2026-08-13 review, P2-1/P3-3): don't just check the two
      # G.pre_trap_exitcode/G.last_exitcode assignments are PRESENT somewhere
      # in hush_exit()'s body — a fuzzy patch apply could land them AFTER the
      # builtin_eval(argv) call that runs the EXIT trap (a position where
      # they are a no-op: the trap body has already run by then), which a
      # bare presence check would not catch. Assert both assignment lines'
      # line numbers precede builtin_eval(argv)'s within the extracted body.
      hush_exit_body=$(sed -n '/^static void hush_exit(int exitcode)$/,/^}/p' shell/hush.c)
      pre_line=$(printf '%s\n' "$hush_exit_body" | grep -n 'G\.pre_trap_exitcode = exitcode & 0xff;' | head -1 | cut -d: -f1)
      last_line=$(printf '%s\n' "$hush_exit_body" | grep -n 'G\.last_exitcode = exitcode & 0xff;' | head -1 | cut -d: -f1)
      eval_line=$(printf '%s\n' "$hush_exit_body" | grep -n 'builtin_eval(argv);' | head -1 | cut -d: -f1)
      if [ -z "$pre_line" ] || [ -z "$last_line" ] || [ -z "$eval_line" ] \
         || [ "$pre_line" -ge "$eval_line" ] || [ "$last_line" -ge "$eval_line" ]; then
        echo "ERROR: 0011-hush-exit-trap-status.patch didn't apply correctly (hush_exit's G.pre_trap_exitcode/G.last_exitcode assignments are missing, or don't precede its builtin_eval(argv) call that runs the EXIT trap)" >&2
        exit 1
      fi
    '';

    # Standard busybox defconfig already turns on CONFIG_HUSH=y (the `hush`
    # applet — installed as its own $out/bin/hush symlink, independent of
    # which shell "sh" aliases to), so no config surgery is needed for the
    # thing this derivation actually tests. ONE applet is force-disabled:
    # `tc` (traffic control) fails to compile against this host's modern
    # kernel headers — busybox 1.36.1's networking/tc.c references legacy
    # CBQ qdisc struct/constants (TCA_CBQ_*) that newer linux/pkt_sched.h
    # dropped, an upstream/kernel-headers version-skew issue with no
    # relation to hush or this check's autotools chain. `tc` is unused here
    # (this build's purpose is `hush` + the coreutils autoconf needs), so
    # disabling it is a targeted, zero-risk workaround, not a functionality
    # cut that matters to what's being proven.
    configurePhase = ''
      runHook preConfigure
      make defconfig
      sed -i 's/^CONFIG_TC=y$/# CONFIG_TC is not set/' .config
      # EOF on stdin (not a `yes |` pipe, which trips stdenv's pipefail on
      # `yes`'s own SIGPIPE once `conf` stops reading) makes Kconfig's `conf`
      # tool accept the default for every remaining prompt.
      make oldconfig < /dev/null
      grep -q '^CONFIG_HUSH=y' .config \
        || { echo "ERROR: CONFIG_HUSH not enabled by defconfig" >&2; exit 1; }
      grep -q '^# CONFIG_TC is not set' .config \
        || { echo "ERROR: CONFIG_TC still enabled after disabling it" >&2; exit 1; }
      runHook postConfigure
    '';

    buildPhase = ''
      runHook preBuild
      make -j$NIX_BUILD_CORES
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      make CONFIG_PREFIX=$out install

      # Flatten the bin/sbin/usr/bin/usr/sbin split into $out/bin (same as
      # userspace/busybox.nix / busybox-fork.nix) — busybox installs many
      # coreutils applets (test, expr, printf, tr, sort, uniq, cmp, …) under
      # BB_DIR_USR_BIN, and this check's PATH is deliberately busybox-only
      # (no separate /usr/bin), so autoconf's `configure` needs them all in
      # one directory to find them.
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

    dontStrip = true;
  };
in
pkgs.runCommand "autotools-fixture-hush-check"
  {
    nativeBuildInputs = [ hushBusybox pkgs.gnumake pkgs.buildPackages.gcc ];
  }
  ''
    cp ${fixture}/configure.ac ${fixture}/configure ${fixture}/Makefile.in ${fixture}/prog.c .
    chmod -R u+w .
    chmod +x configure

    # PIN CONFIG_SHELL to hush — do NOT unset it (2026-08-12 P2 review: an
    # earlier cut of this check unset CONFIG_SHELL/SHELL and reasoned that
    # was enough because the sandbox has no `/bin/sh` to fall back to. That
    # reasoning was wrong on two counts, both found by the reviewer:
    #  1. `/bin/sh` DOES exist here (either the real sandbox=false host
    #     shell, or nix's sandbox-paths busybox `sh` under sandbox=true) —
    #     the claim it "doesn't exist" was never actually true, the gate was
    #     silently passing partly on THAT shell rather than exclusively on
    #     hush. The tell is in the (previously unexplained) DUPLICATE
    #     "config.status: creating Makefile" line in the build log: autoconf's
    #     generated `configure` embeds `SHELL=''${CONFIG_SHELL-/bin/sh}` as
    #     config.status's shebang AND, at the end of its own run, execs
    #     `$SHELL $CONFIG_STATUS` itself to produce the Makefile immediately —
    #     a SEPARATE invocation from the explicit `"$HUSH" ./config.status`
    #     step below. With CONFIG_SHELL unset, that first, configure-internal
    #     invocation defaulted to `/bin/sh`, not hush — so step 1 below was
    #     NOT running its whole chain under hush as claimed, only PART of it
    #     (our own explicit step 2 re-run was hush; configure's own internal
    #     one wasn't).
    #  2. Worse latent failure mode: PATH here also carries busybox `sh`
    #     (native defconfig aliases `sh` to `ash`, not `hush`) — so even a
    #     future hush that fails autoconf's `as_required` self-test would get
    #     silently re-exec'd into the shell-hunt loop's `ash`/`/bin/sh`
    #     fallback instead of failing loudly, and this gate would stay GREEN
    #     having never actually exercised hush on the failing input. This is
    #     the direct cousin of the pre-flip bug this derivation exists to
    #     catch (a check that looks like it tests hush but doesn't).
    # Fix: `export CONFIG_SHELL="$HUSH"` — the preamble's `test "x$CONFIG_SHELL"
    # != x` check is satisfied immediately (no shell-hunt, no /bin/sh/ash
    # fallback reachable at all), `SHELL=''${CONFIG_SHELL-/bin/sh}` resolves to
    # hush too (it's only a default-if-UNSET expansion), and BOTH the
    # configure-internal config.status invocation and our own explicit re-run
    # below execute under exactly the same patched hush. PATH is still
    # busybox-only + the native compiler/make this check needs to complete
    # the chain — matching the booted guest's own minimalism (busybox applets
    # + the substituted wasm-tools guest-cc/make-wasm32), not a full nixpkgs
    # PATH; `sh`/`ash` stay on PATH only because dropping them isn't a real
    # defense (CONFIG_SHELL pinning is what actually closes the hole — see
    # above) and a configure/make helper script invoked via a bare `sh`
    # shebang elsewhere in the chain would break for no safety benefit.
    HUSH="${hushBusybox}/bin/hush"
    export CONFIG_SHELL="$HUSH"
    export PATH="${hushBusybox}/bin:${pkgs.buildPackages.gcc}/bin:${pkgs.gnumake}/bin"

    # 1. `./configure` under the patched hush — a REAL compiler probe
    #    ("checking whether the C compiler works", the two AC_CHECK_HEADERS
    #    probes, AC_CHECK_FUNCS([printf])), never relying on the generated
    #    script's shebang/exec bit (matching autotools-fork-smoke.mjs).
    set +e
    "$HUSH" ./configure > configure.log 2>&1
    cfg_rc=$?
    set -e
    cat configure.log
    if [ "$cfg_rc" -ne 0 ]; then
      echo "FAIL: ./configure exited $cfg_rc under patched hush (expected 0)" >&2
      exit 1
    fi

    # EVIDENCE (2026-08-12 P2 review) that the CONFIG_SHELL pin actually
    # took, not just that ./configure's OWN top-level invocation (the one we
    # control, above) ran under hush: config.status's shebang line
    # (`#! $SHELL`, baked in by configure at generation time — see the
    # CONFIG_SHELL comment above) must name exactly this build's hush. This
    # is what proves the configure-INTERNAL `$SHELL $CONFIG_STATUS`
    # invocation (the one that produces the FIRST of the two "config.status:
    # creating Makefile" lines in the build log, before step 2 below ever
    # explicitly runs config.status itself) also ran under hush, not
    # /bin/sh — the exact gap the P2 review caught.
    config_status_shebang="$(head -1 config.status)"
    echo "config.status shebang: $config_status_shebang"
    # autoconf writes the shebang as "#! $SHELL" (note the space after #!).
    if [ "$config_status_shebang" != "#! $HUSH" ]; then
      echo "FAIL: config.status shebang is '$config_status_shebang', expected '#! $HUSH' — CONFIG_SHELL pinning did not take; the configure-internal config.status invocation ran under some OTHER shell" >&2
      exit 1
    fi

    # 2. config.status re-run must ALSO succeed cleanly — autoconf's
    #    idempotent-regeneration contract, and config.status shares
    #    configure's exact preamble (same CONFIG_SHELL-hunt logic), so this
    #    is a second, independent exercise of the same parser paths.
    set +e
    "$HUSH" ./config.status > config-status.log 2>&1
    cs_rc=$?
    set -e
    cat config-status.log
    if [ "$cs_rc" -ne 0 ]; then
      echo "FAIL: ./config.status exited $cs_rc under patched hush (expected 0)" >&2
      exit 1
    fi

    # 3. `make`, with every recipe line run through the SAME patched hush
    #    (not whatever /bin/sh the sandbox happens to provide — there may be
    #    none at all): GNU Make's SHELL variable, set on the command line,
    #    overrides the Makefile's/its own built-in default.
    set +e
    make SHELL="$HUSH" > make.log 2>&1
    make_rc=$?
    set -e
    cat make.log
    if [ "$make_rc" -ne 0 ]; then
      echo "FAIL: make exited $make_rc under patched hush (expected 0)" >&2
      exit 1
    fi

    # 4. The built program must actually run and print its marker — both the
    #    stdout marker AND the exit status, matching autotools-fork-smoke.mjs.
    set +e
    prog_out=$(./prog)
    prog_rc=$?
    set -e
    echo "$prog_out"
    if [ "$prog_rc" -ne 0 ] || [ "$prog_out" != "AUTOTOOLS_FIXTURE_OK" ]; then
      echo "FAIL: ./prog rc=$prog_rc output='$prog_out' (expected AUTOTOOLS_FIXTURE_OK / 0)" >&2
      exit 1
    fi

    # 5. P1 negative probe (2026-08-12 review lesson, pinned here so it can
    #    never silently regress): a DANGLING variable-fd redirect target
    #    (the next character isn't a word character at all) must fail
    #    LOUDLY and cleanly — exit 1, no crash. The first cut of 0009
    #    SIGSEGV'd on exactly this input (rc=139) because it omitted the
    #    same `rd_filename == NULL` guard its sibling REDIRFD_TO_FILE branch
    #    already carries; fixed, it now reports "ambiguous redirect" and
    #    exits 1, same as pristine (unpatched) hush's parse-time rejection —
    #    the fix changes WHEN the rejection happens, not whether one does.
    set +e
    "$HUSH" -c 'echo hi >&<x' >neg.log 2>&1
    neg_rc=$?
    set -e
    cat neg.log
    if [ "$neg_rc" -ne 1 ]; then
      echo "FAIL: dangling '>&<x' redirect exited $neg_rc under patched hush, expected exactly 1 (not a crash, not silent success)" >&2
      exit 1
    fi

    # 6. NEGATIVE case (2026-08-13, #193 finding; tightened 2026-08-13 review
    #    P2-2): a genuinely-FAILING ./configure must exit NONZERO under this
    #    hush, matching bash/dash — not the "exit status class" bug
    #    patches/busybox/0011-hush-exit-trap-status.patch fixes (autoconf's
    #    universal `ac_exit_trap` idiom — "... && exit $exit_status" with
    #    $exit_status deliberately left empty, i.e. a bare "exit" run FROM
    #    WITHIN the EXIT/trap-0 handler — must resume the exit status that
    #    was PENDING before the trap fired, not whatever the trap body's own
    #    cleanup commands (here, a successful "rm -f -r ...") last left in
    #    $?). Every check above this point only proves the HAPPY path
    #    (configure succeeds); without this case, this gate could not have
    #    caught #193's finding (a real in-guest boot: the fixture's
    #    ./configure hit a genuinely fatal, unrelated cc bug — #192 —
    #    printed its error correctly, and still reported CFGRC=0 to the
    #    harness). Reproduce the same shape hermetically here: sabotage the
    #    compiler this hush's ./configure resolves ("gcc" — AC_PROG_CC's
    #    first probe name — and "cc" as a fallback) so AC_PROG_CC's real
    #    "checking whether the C compiler works" probe genuinely fails, in a
    #    FRESH copy of the fixture (the steps above already wrote
    #    config.status/Makefile/prog/*.o into the cwd copy; reusing it here
    #    would exercise config.status's cache reuse, not a first-run
    #    compiler-fails path). `unset CC CXX` so this build's own environment
    #    could never hand configure a working, PATH-independent compiler
    #    that bypasses the sabotage (nothing sets them here today, but this
    #    closes the hole against a future change that would).
    #
    #    ATTRIBUTABILITY (P2-2): a bare "exited nonzero" is too weak a check
    #    on its own — a REGRESSION elsewhere in this same hush build (e.g. in
    #    0009's variable-fd-redirect handling, the one place a real configure
    #    actually uses ">&$4", inside as_fn_error itself) could make
    #    configure fail EARLY with some OTHER nonzero status, and this gate
    #    would still declare the exit-trap fix "holds" without having
    #    exercised it at all. Pin to the EXACT value bash/dash/hush (post-fix)
    #    all independently produce for this exact sabotage (measured and
    #    recorded in the 0011 patch header's VERIFIED section: 77, from
    #    `as_fn_error 77 "C compiler cannot create executables"`) AND grep the
    #    captured configure output for that exact diagnostic, so a pass here
    #    is attributable specifically to the compiler-probe -> as_fn_error ->
    #    exit-trap path this patch fixes, not to some other failure that
    #    happens to also be nonzero.
    mkdir -p neg-cc-case/sabotage-bin
    cat > neg-cc-case/sabotage-bin/cc <<'SABOTAGE'
#!/bin/sh
echo "sabotaged cc: refusing to compile" >&2
exit 1
SABOTAGE
    cp neg-cc-case/sabotage-bin/cc neg-cc-case/sabotage-bin/gcc
    chmod +x neg-cc-case/sabotage-bin/cc neg-cc-case/sabotage-bin/gcc
    cp ${fixture}/configure.ac ${fixture}/configure ${fixture}/Makefile.in ${fixture}/prog.c neg-cc-case/
    chmod -R u+w neg-cc-case
    chmod +x neg-cc-case/configure
    (
      cd neg-cc-case
      unset CC CXX
      set +e
      PATH="$PWD/sabotage-bin:$PATH" "$HUSH" ./configure >configure.log 2>&1
      echo $? > cfg_rc.txt
      set -e
    )
    neg_cfg_rc=$(cat neg-cc-case/cfg_rc.txt)
    cat neg-cc-case/configure.log
    if [ "$neg_cfg_rc" -ne 77 ]; then
      echo "FAIL: ./configure against a SABOTAGED (always-failing) compiler exited $neg_cfg_rc under patched hush, expected EXACTLY 77 (as_fn_error's status, matching bash/dash on this identical setup) -- this is the #193 broken-exit-status class patches/busybox/0011-hush-exit-trap-status.patch fixes" >&2
      exit 1
    fi
    if ! grep -q 'C compiler cannot create executables' neg-cc-case/configure.log; then
      echo "FAIL: ./configure exited 77 but its output doesn't mention 'C compiler cannot create executables' -- the nonzero status isn't attributable to the compiler-probe -> as_fn_error -> exit-trap path this gate exists to exercise (some OTHER failure produced a coincidentally-matching 77)" >&2
      exit 1
    fi
    echo "sabotaged-cc ./configure correctly exited 77 (as_fn_error's status, matching bash/dash) via the C-compiler-cannot-create-executables path"

    echo "PASS: patched hush ran a real generated ./configure && make && ./prog end to end (rc=0 throughout), the P1 dangling-redirect fix holds (rc=1, no crash), and a genuinely-failing ./configure (sabotaged compiler) correctly exits exactly 77 via the C-compiler-cannot-create-executables path (the #193 exit-trap-status fix holds, attributably)." | tee "$out"
  ''
