# base-squashfs.nix — the base-system store closure as ONE read-only squashfs
# image (the NixOS live-ISO design). The runtime serves it over virtio-blk; the
# guest mounts it -t squashfs as the /nix overlay lowerdir. Replaces store.json
# (#43). The image root holds store/<hash>… + var/nix/profiles/system → toplevel
# (the symlink bootstrap reads), so mounting at /mnt/nix-ro and overlaying to
# /nix resolves /nix/store/* and /nix/var/nix/profiles/system in-guest.
# channel — the wasm-nixpkgs channel tree (userspace/wasm-nixpkgs-channel.nix).
# Baked into the squashfs (a real on-disk dir → directory traversal works, unlike
# the flat binary-cache 9P export) so the guest's `nix-env -iA nixpkgs.<pkg>`
# default expr (`import <channel> {}`, set in bootstrap.nix) is always present. It
# is tiny (~1.3 MB of config text) and its closure is just itself — nixpkgs is NOT
# pulled in (the channel reaches it via <nixpkgs>, substituted from the cache).
{ pkgs, toplevel, channel ? null, blockSize ? 131072 }:
let
  closure = pkgs.closureInfo {
    rootPaths = [ toplevel ] ++ pkgs.lib.optional (channel != null) channel;
  };
in
pkgs.runCommand "base-squashfs"
  { nativeBuildInputs = [ pkgs.squashfsTools ]; }
  ''
    mkdir -p root/nix/store root/nix/var/nix/profiles
    # Copy the closure's store paths to their real /nix/store locations.
    while read -r p; do
      cp -a "$p" root/nix/store/
    done < ${closure}/store-paths
    # The system profile symlink the bootstrap reads (absolute target so it
    # resolves against the /nix guest mount, like a real Nix profile symlink).
    ln -s ${toplevel} root/nix/var/nix/profiles/system

    mkdir -p $out
    mksquashfs root/nix $out/base.squashfs \
      -comp zstd -b ${toString blockSize} \
      -all-root -noappend -no-progress -reproducible
    echo "base.squashfs: $(du -h $out/base.squashfs | cut -f1)"
  ''
