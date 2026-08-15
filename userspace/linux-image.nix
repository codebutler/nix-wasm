# linux-image.nix — one coherent process-model boot bundle (pc#315). Each
# instantiation grafts vmlinux + initramfs + squashfs + manifest into an iso9660
# image built with nixpkgs' standard make-iso9660-image (xorriso → reproducible).
# The production channel instantiates this twice (MMU and NOMMU); yore-pc chooses
# a mode, downloads that image once via the disc installer, mounts it, reads the
# members out, and boots from the bytes. The compiler toolchain (nix-cache) is
# shared and remains a lazily-fetched R2 cache. See
# docs/superpowers/specs/2026-06-24-linux-bundle-channel-design.md.
{ pkgs, nixpkgs, kernel, initramfs, squashfs, version ? 1 }:
let
  lib = pkgs.lib;

  # nix-wasm#202 PR-1: the mechanical guard that a future attr-rename can't
  # produce a mismatched image. `kernel`/`initramfs`/`squashfs` are three
  # INDEPENDENT args here — userspace/toplevel.nix already cross-checks
  # kernel/initramfs/busybox against EACH OTHER when it assembles the
  # squashfs's own toplevel, but nothing stopped a DIFFERENT toplevel's
  # squashfs from being combined with a mismatched kernel/initramfs pair
  # right here, at the final assembly point this file exists to be. A NOMMU
  # spawn-contract kernel paired with a real-fork userspace (or the reverse)
  # corrupts the guest's own memory model at boot — see kernel.nix's
  # passthru.processModel comment and
  # docs/superpowers/notes/2026-08-05-mmu-phase1-parity-plan.md.
  reqProcessModel = name: drv: drv.processModel or (throw
    "userspace/linux-image.nix: the `${name}` derivation has no "
    + "passthru.processModel — wire it before assembling a boot image");
  kernelModel = reqProcessModel "kernel" kernel;
  initramfsModel = reqProcessModel "initramfs" initramfs;
  squashfsModel = reqProcessModel "squashfs" squashfs;
  processModelCoherent =
    if kernelModel == initramfsModel && initramfsModel == squashfsModel
    then true
    else throw ''
      userspace/linux-image.nix: process-model MISMATCH assembling the boot
      image: kernel=${kernelModel} initramfs=${initramfsModel} squashfs=${squashfsModel}.
      A NOMMU spawn-contract kernel paired with a real-fork userspace (or the
      reverse) corrupts the guest's own memory model at boot. This assert
      exists so a future attr-rename (swapping in .#kernel-mmu-a2 without
      also swapping .#wasm-initramfs-fork/.#wasm-base-squashfs-fork, or vice
      versa) fails at EVAL time instead of shipping a silently-broken image.
    '';

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
assert processModelCoherent;
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
