# base-squashfs.nix — the base-system store closure as ONE read-only squashfs
# image (the NixOS live-ISO design). The runtime serves it over virtio-blk; the
# guest mounts it -t squashfs as the /nix overlay lowerdir. Replaces store.json
# (#43). The image root holds store/<hash>… + var/nix/profiles/system → toplevel
# (the symlink bootstrap reads), so mounting at /mnt/nix-ro and overlaying to
# /nix resolves /nix/store/* and /nix/var/nix/profiles/system in-guest.
#
# drvSeed (optional, codebutler/nix-wasm#1): a `pkgs.closureInfo` over the
# catalog packages' DERIVERS (.drv files). Its store-paths (.drv text + small
# build scripts — NOT the big sources, which are fetch-derivation OUTPUTS and so
# are not in a .drv's reference closure) are copied into the store, and its
# `registration` is shipped at /nix/.drv-registration so the guest /init can
# `nix-store --load-db` it. That makes those .drvs read as VALID locally, so the
# new CLI (`nix profile install`, which realises Built{drvPath} and requires the
# .drv present — Nix never substitutes a .drv from a cache) finds the deriver and
# substitutes the OUTPUT from the binary cache. Real-NixOS store state, sourced
# by `nix copy --derivation` instead of in-guest eval (#92).
{ pkgs, toplevel, drvSeed ? null, blockSize ? 131072 }:
let
  inherit (pkgs) lib;
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "base-squashfs"
  { nativeBuildInputs = [ pkgs.squashfsTools ]; }
  ''
    mkdir -p root/nix/store root/nix/var/nix/profiles
    # Copy the closure's store paths to their real /nix/store locations.
    while read -r p; do
      cp -a "$p" root/nix/store/
    done < ${closure}/store-paths
    ${lib.optionalString (drvSeed != null) ''
      # Seed the catalog packages' .drv closure into the store + ship its
      # registration (the guest /init loads it into the Nix DB). cp -an: the .drv
      # closure can share small source paths with the system closure copied above;
      # those are byte-identical so skip rather than clobber.
      while read -r p; do
        cp -an "$p" root/nix/store/ 2>/dev/null || true
      done < ${drvSeed}/store-paths
      cp ${drvSeed}/registration root/nix/.drv-registration
    ''}
    # The system profile symlink the bootstrap reads (absolute target so it
    # resolves against the /nix guest mount, like a real Nix profile symlink).
    ln -s ${toplevel} root/nix/var/nix/profiles/system

    mkdir -p $out
    mksquashfs root/nix $out/base.squashfs \
      -comp zstd -b ${toString blockSize} \
      -all-root -noappend -no-progress -reproducible
    echo "base.squashfs: $(du -h $out/base.squashfs | cut -f1)"
  ''
