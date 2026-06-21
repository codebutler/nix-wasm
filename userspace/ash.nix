# busybox ASH for the wasm32-linux-musl NOMMU guest — the autoconf-capable shell
# that hush can't be. ash's dash-derived parser
# runs autoconf `configure`; the NOMMU "fork-without-exec" problem (subshells,
# $(shell-code), pipelines, heredocs) is solved by pc's forkshell port
# (busybox-w32 lineage), reused here with a GUEST backend:
#
#   patches/busybox/ash/0001-ash-cb-spawn.patch   — CMDUNKNOWN external exec → cb_spawn()
#   patches/busybox/ash/0002-ash-m3-m4.patch       — redirections + $(external) capture
#   patches/busybox/ash/0003-ash-forkshell.patch   — serialize shell state, run in `ash --fs`
#   userspace/ash-cb-guest.c                        — the `cb` surface over posix_spawn/pipe/
#                                                     waitpid (NOT pc's WASI futex-SAB bridge)
#
# The cb wasm-import attributes the forkshell patch injects into ash.c are
# stripped in postPatch so the __cb_* calls bind to the linked guest adapter
# instead of a (nonexistent) "cb" host module. Built via the SAME cross cc-wrapper
# as busybox.nix — same wasm dylink link, same NOMMU clone-with-fn spawn model.
{ pkgs, cross, busyboxKernelHeaders }:
let
  cc = cross.stdenv.cc;
  p = cc.targetPrefix;
in
cross.stdenv.mkDerivation {
  pname = "ash-wasm32-nommu";
  version = "1.36.1";

  src = pkgs.fetchurl {
    url = "https://busybox.net/downloads/busybox-1.36.1.tar.bz2";
    hash = "sha256-uMwkyVdNgJ5yecO+NJeVxdXOtv3xnKcJ+AzeUOR94xQ=";
  };

  patches = [
    ../patches/busybox/0001-wasm-arch-and-clone-spawn.patch
    ../patches/busybox/0004-libbb-spawn-clone.patch
    # wasm: xfork() uses fork() which is absent in wasm musl even when BB_MMU=1
    # (ash.nix uses allnoconfig without CONFIG_NOMMU=y, so BB_MMU stays 1 so that
    # ash can be compiled — ash depends on !NOMMU in Kconfig — but fork() is still
    # absent on wasm; guard xfork() with !defined(__wasm__) to match musl's reality).
    ../patches/busybox/0007-xfork-no-fork-wasm.patch
    # ash forkshell stack (pc vendor/busybox/wasi-compat, busybox-w32 lineage):
    ../patches/busybox/ash/0001-ash-cb-spawn.patch
    ../patches/busybox/ash/0002-ash-m3-m4.patch
    ../patches/busybox/ash/0003-ash-forkshell.patch
    # NOMMU: route a CMDNORMAL external command that needs a child (not the last
    # command) through cb_spawn instead of ash's native fork()+exec — the wasm
    # port has no working fork(), so `cc foo; echo done` (any non-terminal
    # external command) otherwise hangs. The guest's real find_command resolves
    # found commands to CMDNORMAL (unlike pc's WASI build where externals stayed
    # CMDUNKNOWN), so this default-case path is reachable here and must not fork.
    ../patches/busybox/ash/0004-ash-nommu-cmdnormal-spawn.patch
  ];

  postPatch = ''
    substituteInPlace Makefile --replace-fail '/bin/pwd' 'pwd'
    patchShebangs scripts applets

    # The forkshell patch declares the cb bridge as wasm imports from module
    # "cb". On the guest there is no "cb" host module — strip the import
    # attributes so the __cb_* calls bind to the linked guest adapter instead.
    sed -i '/__attribute__((import_module("cb")/d' shell/ash.c

    # FIX: each forkshell parent helper leaves g_parsefile pointing at basepf
    # instead of the caller's parsefile (the -c string / a sourced file). ash's
    # outer evalcommand then does unwindfiles(file_stop), whose
    # `while (g_parsefile != stop) popfile()` spins forever (popfile() stops at
    # basepf, so the unreachable stop is never hit) — hanging the command after a
    # $()/subshell/pipeline. g_parsefile is only RESET here, not freed, so save it
    # across each forkshell helper and restore it. (Root-caused via pid-tagged
    # traces; the six forkshell/spawn fixes are documented in these patches + git.)
    sed -i 's|fslen = forkshell_capture(&fs, &fsbuf, &fsstatus);|struct parsefile *_spf = g_parsefile; fslen = forkshell_capture(\&fs, \&fsbuf, \&fsstatus); g_parsefile = _spf;|' shell/ash.c
    sed -i 's|status = forkshell_run(&fs, backgnd);|{ struct parsefile *_spf = g_parsefile; status = forkshell_run(\&fs, backgnd); g_parsefile = _spf; }|' shell/ash.c
    sed -i 's|status = forkshell_pipeline(n, flags);|{ struct parsefile *_spf = g_parsefile; status = forkshell_pipeline(n, flags); g_parsefile = _spf; }|' shell/ash.c

    # FIX: the M3a redirect-detach (patch 0002) was a WASI workaround — there
    # dup2-based redirects were stubbed, so it detached an external command's
    # redirect list and re-wired it via cb_spawn_redirect. On THIS guest dup2
    # works, so ash's own redirect() applies redirects in-process and the
    # posix_spawn child inherits them (exactly like cb_spawn_pipeline inherits
    # its pipe fds). Worse, the detach keys off the EARLY find_command
    # (DO_REGBLTIN → CMDUNKNOWN) and fires before the later find_command
    # reclassifies a found command to CMDNORMAL; the CMDNORMAL path then ignores
    # the detached list, dropping the redirect entirely (e.g. autoconf's
    # `cat >conftest.c <<EOF` never creates the file). Neutralize the detach so
    # redirectsafe() handles every redirect (files, >&N, heredocs) in-process.
    sed -i 's|if (cmdentry.cmdtype == CMDUNKNOWN && cmd->ncmd.redirect) {|if (0 \&\& cmdentry.cmdtype == CMDUNKNOWN \&\& cmd->ncmd.redirect) {|' shell/ash.c

    # FIX: clear the inherited redirlist in a forkshell child before it runs.
    # The forkshell serializer copies the parent's redirlist (the active brace/
    # command redirects) into the child. On a real fork that's fine — the saved
    # backup fds are valid in the forked copy. But this child is a re-exec'd
    # `ash --fs` that inherited only the ALREADY-APPLIED fds (via posix_spawn);
    # the squirreled-away backup fds the redirtab references don't exist here.
    # So when the child exits, exitreset()→unwindredir(NULL) tries to restore
    # fds from invalid backups and HANGS. (Manifests as `$( (cmd) || … )` /
    # any backtick whose body can't exec-replace, inside a `{ … } >&5` block —
    # autoconf's `## Platform. ##` section: the capture pipe is never closed, so
    # the parent's read never EOFs.) The child just _exit()s, which closes its
    # fds — it must NOT unwind the parent's redirect stack. Clearing redirlist
    # leaves a clean stack for the child's OWN redirects (pushed/popped during
    # its execution) while making the inherited entries a no-op.
    #
    # Also pin SIGCHLD to SIG_DFL for the child's lifetime: it does its own
    # specific-pid waits (cb_spawn / __cb_fork_*) and never needs ash's
    # SIGCHLD-driven job control, whose dowait(NONBLOCK)→waitpid(-1,WNOHANG)
    # blocks on this NOMMU kernel when there are no children.
    sed -i 's|\tforkshell_child(fs);|\t{ struct sigaction _fsd; memset(\&_fsd, 0, sizeof _fsd); _fsd.sa_handler = SIG_DFL; sigaction(SIGCHLD, \&_fsd, (struct sigaction *)0); }\n\tfs->gvp->redirlist = NULL; /* drop inherited (parent) redirects; see above */\n\tforkshell_child(fs);|' shell/ash.c

    # Compile the guest cb adapter + the wasm SjLj runtime as part of the shell
    # dir (gated on CONFIG_ASH). The SjLj runtime provides __wasm_setjmp/_test/
    # __wasm_longjmp + the __c_longjmp tag that `-mllvm -wasm-enable-sjlj` needs
    # (LLVM-21 ships no standalone impl).
    cp ${./ash-cb-guest.c} shell/ash_cb_guest.c
    cp ${./ash-wasm-sjlj.c} shell/ash_wasm_sjlj.c
    echo 'lib-$(CONFIG_ASH) += ash_cb_guest.o ash_wasm_sjlj.o' >> shell/Kbuild.src
  '';

  depsBuildBuild = [ pkgs.gcc ];
  nativeBuildInputs = [ pkgs.gnumake ];

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
      # -mllvm -wasm-enable-sjlj: ash's exit/error control flow uses
      # setjmp/longjmp (exraise/EXEXIT). musl-wasm's longjmp is literally
      # `call abort` ("forbidden"; setjmp is a no-op) — so every ash exit
      # SIGABRTs. clang's wasm SjLj lowers setjmp/longjmp via wasm EH itself
      # (never calling musl's longjmp), exactly as pc's sh.wasm build does.
      # The cross stdenv adds no -fwasm-exceptions here, so there's no EH/SjLj
      # conflict.
      "CONFIG_EXTRA_CFLAGS=-isystem ${busyboxKernelHeaders} -mllvm -wasm-enable-sjlj"
      "CONFIG_EXTRA_LDFLAGS="
    )
    # Minimal ash binary (pc's sh.wasm recipe, sans WASI): allnoconfig → enable
    # ash + the builtins/arith autoconf needs → oldconfig. This binary only needs
    # to BE the shell; external applets (sed/grep/cat/…) resolve to the existing
    # busybox on PATH. The wasm arch/NOMMU come from ARCH=wasm + patch 0001 + the
    # cross toolchain, not .config symbols.
    cfg=build/.config
    make "''${mk[@]}" allnoconfig
    # The FEATURE_EDITING* / *_COMPLETION group turns on busybox's libbb/lineedit.c
    # so the interactive ash (now the login /bin/sh, bootstrap.nix) has arrow-key
    # editing, history, reverse-search, and tab completion (paths + commands on
    # $PATH + usernames + ash builtins). Same lineedit code the busybox hush build
    # already runs on this guest — completion is readdir/stat-based (no fork/exec),
    # so it's NOMMU-safe. The int-valued MAX_LEN/HISTORY symbols are pulled in with
    # their defaults (1024 / 255) by the oldconfig pass below.
    # UNICODE_SUPPORT makes lineedit count cursor columns by display width (the
    # Ghostty console is UTF-8), so multibyte/CJK/combining input doesn't corrupt
    # the line. CHECK_UNICODE_IN_ENV gates that on a UTF-8 LANG/LC_ALL; we use the
    # built-in wcwidth tables (NOT FEATURE_UNICODE_USING_LOCALE) to avoid depending
    # on musl's limited locale support. SAVE_ON_EXIT flushes history on exit.
    for c in STATIC LFS \
             ASH SHELL_ASH SH_IS_ASH \
             ASH_ECHO ASH_PRINTF ASH_TEST ASH_SLEEP ASH_ALIAS ASH_GETOPTS \
             ASH_CMDCMD ASH_OPTIMIZE_FOR_SIZE ASH_INTERNAL_GLOB ASH_EXPAND_PRMT \
             ASH_RANDOM_SUPPORT ASH_BASH_COMPAT \
             FEATURE_SH_MATH FEATURE_SH_MATH_64 FEATURE_SH_MATH_BASE \
             FEATURE_EDITING FEATURE_TAB_COMPLETION FEATURE_USERNAME_COMPLETION \
             FEATURE_REVERSE_SEARCH FEATURE_EDITING_SAVEHISTORY \
             FEATURE_EDITING_SAVE_ON_EXIT \
             FEATURE_EDITING_FANCY_PROMPT FEATURE_EDITING_WINCH \
             UNICODE_SUPPORT FEATURE_CHECK_UNICODE_IN_ENV \
             FEATURE_UNICODE_COMBINING_WCHARS FEATURE_UNICODE_WIDE_WCHARS; do
      sed -i "s/^# CONFIG_$c is not set\$/CONFIG_$c=y/" "$cfg"
      grep -q "^CONFIG_$c=y" "$cfg" || echo "CONFIG_$c=y" >> "$cfg"
    done
    # Int-valued editing knobs: allnoconfig zeroes these, but REVERSE_SEARCH and
    # SAVEHISTORY reference the history ring (state->history), which lineedit.c
    # only compiles when FEATURE_EDITING_HISTORY > 0 — so set them explicitly
    # (the boolean loop above can't emit int values).
    for kv in FEATURE_EDITING_MAX_LEN=1024 FEATURE_EDITING_HISTORY=255; do
      sym=''${kv%%=*}
      sed -i "/^CONFIG_$sym=/d;/^# CONFIG_$sym is not set\$/d" "$cfg"
      echo "CONFIG_$kv" >> "$cfg"
    done
    # oldconfig (not silentoldconfig — it prompts for new symbols and dies on
    # redirected stdin); feeding empty lines takes each new symbol's default.
    ( set +o pipefail; yes "" | make "''${mk[@]}" oldconfig ) >/dev/null
    grep -q '^CONFIG_SHELL_ASH=y' "$cfg" || { echo "ERROR: ash not enabled"; cat "$cfg" | grep -iE "ASH|HUSH" ; exit 1; }
    # Guard the interactive editing symbols: oldconfig silently drops a symbol whose
    # deps go unmet, which would ship an ash with no completion and no warning.
    for need in FEATURE_EDITING FEATURE_TAB_COMPLETION FEATURE_REVERSE_SEARCH UNICODE_SUPPORT; do
      grep -q "^CONFIG_$need=y" "$cfg" || { echo "ERROR: $need dropped by oldconfig"; grep -i "$need" "$cfg" || true; exit 1; }
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
    # Install ONLY the ash binary as `ash`, to avoid colliding with the main
    # busybox (which provides `sh` + coreutils) in the shared system profile.
    # External commands ash runs resolve to that busybox on PATH.
    mkdir -p "$out/bin"
    cp build/busybox "$out/bin/busybox"
    ln -sf busybox "$out/bin/ash"
    runHook postInstall
  '';

  dontStrip = true;
  dontFixup = true;
}
