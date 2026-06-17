# busybox ASH for the wasm32-linux-musl NOMMU guest — the autoconf-capable shell
# that hush can't be (see docs/plan-guest-shell.md). ash's dash-derived parser
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
    # ash forkshell stack (pc vendor/busybox/wasi-compat, busybox-w32 lineage):
    ../patches/busybox/ash/0001-ash-cb-spawn.patch
    ../patches/busybox/ash/0002-ash-m3-m4.patch
    ../patches/busybox/ash/0003-ash-forkshell.patch
  ];

  postPatch = ''
    substituteInPlace Makefile --replace-fail '/bin/pwd' 'pwd'
    patchShebangs scripts applets

    # The forkshell patch declares the cb bridge as wasm imports from module
    # "cb". On the guest there is no "cb" host module — strip the import
    # attributes so the __cb_* calls bind to the linked guest adapter instead.
    sed -i '/__attribute__((import_module("cb")/d' shell/ash.c

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
    for c in STATIC LFS \
             ASH SHELL_ASH SH_IS_ASH \
             ASH_ECHO ASH_PRINTF ASH_TEST ASH_SLEEP ASH_ALIAS ASH_GETOPTS \
             ASH_CMDCMD ASH_OPTIMIZE_FOR_SIZE ASH_INTERNAL_GLOB ASH_EXPAND_PRMT \
             ASH_RANDOM_SUPPORT ASH_BASH_COMPAT \
             FEATURE_SH_MATH FEATURE_SH_MATH_64 FEATURE_SH_MATH_BASE; do
      sed -i "s/^# CONFIG_$c is not set\$/CONFIG_$c=y/" "$cfg"
      grep -q "^CONFIG_$c=y" "$cfg" || echo "CONFIG_$c=y" >> "$cfg"
    done
    # oldconfig (not silentoldconfig — it prompts for new symbols and dies on
    # redirected stdin); feeding empty lines takes each new symbol's default.
    ( set +o pipefail; yes "" | make "''${mk[@]}" oldconfig ) >/dev/null
    grep -q '^CONFIG_SHELL_ASH=y' "$cfg" || { echo "ERROR: ash not enabled"; cat "$cfg" | grep -iE "ASH|HUSH" ; exit 1; }
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
