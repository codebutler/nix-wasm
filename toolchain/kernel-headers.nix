# Linux UAPI headers for the wasm arch — what musl, libc++, and every guest
# program compile against (linux/*.h, asm/*.h). `make ARCH=wasm headers_install`
# on the pinned joelseverin/linux wasm-7.0 tree (the wasm Linux arch is
# out-of-tree, not upstream Linux — this is SOURCE, pinned by commit). No kernel
# compile; headers only (fast).
{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "linux-wasm-uapi-headers";
  version = "wasm-7.0";

  # Shared pinned source (also used by kernel.nix) — see toolchain/kernel-src.nix.
  src = import ./kernel-src.nix { inherit pkgs; };

  nativeBuildInputs = [ pkgs.gnumake pkgs.rsync pkgs.bison pkgs.flex pkgs.python3 pkgs.bc ];

  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    make ARCH=wasm headers_install INSTALL_HDR_PATH=$out -j$NIX_BUILD_CORES
    runHook postBuild
  '';
  dontInstall = true;
  dontFixup = true;
}
