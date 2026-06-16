# The pinned wasm-kernel source: joelseverin/linux (the out-of-tree wasm Linux
# arch port, NOT upstream Linux), pinned by commit. Shared by both the UAPI
# headers (kernel-headers.nix) and the kernel build (kernel.nix) so they can
# never drift apart. Bump the rev+hash together when moving the kernel pin.
{ pkgs }:
pkgs.fetchFromGitHub {
  owner = "joelseverin";
  repo = "linux";
  rev = "039e5f3e583f56f329657d1fe9945510dba10f41";
  hash = "sha256-La+8ZfCyPiFt2BSixlRZn/Y9etA2CKoumN5/RB8Kt1U=";
}
