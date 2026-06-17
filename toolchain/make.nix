# make.wasm — pdpmake (rmyorston's small POSIX make) cross-compiled to the wasm32
# guest. BusyBox 1.36.1 has no make applet, so the guest needs this for in-guest
# builds (and Nix builders that run `make`). Faithful Nix port of pc's
# scripts/linux-demo/maketool/build.sh (#139 Layer 3 Step B).
#
# Works in-guest with NO patching: pdpmake runs each recipe via system(cmd), and
# musl's system() spawns through posix_spawn -> __clone(CLONE_VM|CLONE_VFORK|
# SIGCHLD) — the only spawn mode the wasm/NOMMU kernel supports. Same guest-ABI
# flags as the cbhello reference; the clang DRIVER does the one-shot compile+link
# (on the host it spawns wasm-ld natively). DEFAULT_SHELL=/bin/sh = the busybox sh.
{ pkgs, musl, busyboxKernelHeaders, compilerRt }:
let
  lib = pkgs.lib;
  llvm = pkgs.llvmPackages_21;
  cu = llvm.clang-unwrapped;
  bt = llvm.bintools-unwrapped;

  # pdpmake, pinned (POSIX make, pure C, no external deps).
  src = pkgs.fetchFromGitHub {
    owner = "rmyorston";
    repo = "pdpmake";
    rev = "699cde9d388a48f4f83b03d4c99a255de98301b7";
    hash = "sha256-zqIDMeybzKiLkYCUzm5lwoCKgY/UGjkYU/IbXZFnR8k=";
  };

  # The native clang resolves compiler-rt builtins from its DEFAULT resource dir,
  # which has no wasm32 variant → link fails. Provide a resource dir carrying
  # clang's builtin headers + OUR wasm builtins (same shape as guest-clang.nix).
  builtins_a = "${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a";
  resourceDir = pkgs.runCommand "make-clang-resource" { } ''
    mkdir -p $out/include $out/lib/wasm32-unknown-unknown
    cp -a ${lib.getLib cu}/lib/clang/*/include/. $out/include/
    cp ${builtins_a} $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
  '';
in
pkgs.stdenv.mkDerivation {
  pname = "make-wasm32";
  version = "pdpmake-699cde9";
  inherit src;

  nativeBuildInputs = [ cu bt ];
  dontConfigure = true;
  dontStrip = true; # wasm isn't ELF
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    export PATH=${bt}/bin:$PATH   # the clang driver spawns wasm-ld
    mkdir -p $out/bin
    ${cu}/bin/clang \
      --target=wasm32-unknown-unknown -fPIC \
      --sysroot=${musl} -resource-dir=${resourceDir} -isystem ${busyboxKernelHeaders} \
      -D__linux__ -D__unix__ -D__unix -DDEFAULT_SHELL='"/bin/sh"' \
      -Xclang -target-feature -Xclang +atomics \
      -Xclang -target-feature -Xclang +bulk-memory \
      -O2 *.c -o $out/bin/make \
      -Wl,-shared -Wl,-no-gc-sections -Wl,--no-merge-data-segments -Wl,--no-entry \
      -Wl,--export-all -Wl,--import-memory -Wl,--shared-memory \
      -Wl,--max-memory=4294967296 -Wl,--import-undefined -Wl,--import-table \
      -Wl,--export-if-defined=__set_tls_base -Wl,--export-if-defined=__libc_handle_signal
    runHook postBuild
  '';

  dontInstall = true;
}
