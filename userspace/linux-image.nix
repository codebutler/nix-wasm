# linux-image.nix — the single versioned `linux` boot bundle (pc#315). ONE
# iso9660 image grafting the three boot artifacts plus a manifest, built with
# nixpkgs' standard make-iso9660-image (xorriso → reproducible). pc downloads it
# once via the disc installer, mounts it, reads the members out, and boots from
# the bytes. The compiler toolchain (nix-cache) is NOT in here — it stays a
# lazily-fetched R2 cache so opening a shell/GUI app doesn't pull the ~29 MB
# toolchain. See docs/superpowers/specs/2026-06-24-linux-bundle-channel-design.md.
{ pkgs, nixpkgs, kernel, initramfs, squashfs, version ? 1 }:
let
  lib = pkgs.lib;

  # minEngine is parsed from runtime/abi.js so it can never drift from the engine
  # ENGINE_ABI the JS actually implements. Match the ACTUAL export line, not the
  # comment lines that also mention ENGINE_ABI (findFirst would otherwise pick a
  # comment). builtins.match anchors on the whole line.
  abiPattern = "[[:space:]]*export const ENGINE_ABI = ([0-9]+);[[:space:]]*";
  abiLine = lib.findFirst (l: builtins.match abiPattern l != null) null
    (lib.splitString "\n" (builtins.readFile ../runtime/abi.js));
  abiMatch = if abiLine == null then null else builtins.match abiPattern abiLine;
  minEngine = lib.toInt (builtins.head (lib.throwIf (abiMatch == null)
    "linux-image.nix: could not parse ENGINE_ABI from runtime/abi.js" abiMatch));

  manifest = pkgs.writeText "manifest.json"
    (builtins.toJSON { inherit version minEngine; });

  # nixpkgs' standard data-ISO builder. callPackage fills the package deps
  # (lib/stdenv/xorriso/zstd/squashfsTools/…) from pkgs; we supply the image
  # args (contents/isoName/volumeID) in the same call. `syslinux = null`: the
  # builder lists syslinux (x86-only) in nativeBuildInputs unconditionally, but
  # it is only invoked for BOOTABLE images — ours is a plain data ISO (bootable
  # defaults to false), and stdenv filters null inputs, so nulling it keeps the
  # builder buildable on any host (e.g. the aarch64 dev box), not just x86_64.
  makeIso = args:
    pkgs.callPackage "${nixpkgs}/nixos/lib/make-iso9660-image.nix"
      (args // { syslinux = null; });
in
makeIso {
  isoName = "linux.iso";
  volumeID = "LINUX";
  contents = [
    { source = "${kernel}/vmlinux.wasm";         target = "/vmlinux.wasm"; }
    { source = "${initramfs}/initramfs.cpio.gz";  target = "/initramfs.cpio.gz"; }
    { source = "${squashfs}/base.squashfs";       target = "/base.squashfs"; }
    { source = manifest;                           target = "/manifest.json"; }
  ];
}

