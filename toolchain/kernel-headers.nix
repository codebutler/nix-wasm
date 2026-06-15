# Linux UAPI headers for the wasm arch — what musl, libc++, and every guest
# program compile against (linux/*.h, asm/*.h). `make ARCH=wasm headers_install`
# on the pinned joelseverin/linux wasm-7.0 tree (the wasm Linux arch is
# out-of-tree, not upstream Linux — this is SOURCE, pinned by commit). No kernel
# compile; headers only (fast).
{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "linux-wasm-uapi-headers";
  version = "wasm-7.0";

  src = pkgs.fetchFromGitHub {
    owner = "joelseverin";
    repo = "linux";
    rev = "039e5f3e583f56f329657d1fe9945510dba10f41";
    hash = "sha256-La+8ZfCyPiFt2BSixlRZn/Y9etA2CKoumN5/RB8Kt1U=";
  };

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
