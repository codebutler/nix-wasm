# base-squashfs.nix — the base-system store closure as ONE read-only squashfs
# image (the NixOS live-ISO design). The runtime serves it over virtio-blk; the
# guest mounts it -t squashfs as the /nix overlay lowerdir. Replaces store.json
# (#43). The image root holds store/<hash>… plus a real generation-1 system
# profile (system -> system-1-link -> toplevel), so the installed copy starts
# with the same profile layout nix-env later advances and rolls back.
# channel — the wasm-nixpkgs channel tree (userspace/wasm-nixpkgs-channel.nix).
# Baked into the squashfs (a real on-disk dir → directory traversal works, unlike
# the flat binary-cache 9P export) so the guest's `nix-env -iA nixpkgs.<pkg>`
# default expr (`import <channel> {}`, set in bootstrap.nix) is always present. It
# is tiny (~1.3 MB of config text) and its closure is just itself — nixpkgs is NOT
# pulled in (the channel reaches it via <nixpkgs>, substituted from the cache).
{ pkgs, toplevel, channel ? null, blockSize ? 131072 }:
let
  seedRoot = import ./seed-root.nix { inherit pkgs toplevel channel; };

  # nix-wasm#202 PR-1: the process-model coherence marker, propagated from
  # `toplevel` (already coherence-checked against ITS OWN kernel/initramfs/
  # busybox inputs by userspace/toplevel.nix's own `assert`, which — because
  # that assert is a real `assert`, not a passthru-only value — is ALREADY
  # forced transitively the moment `closure` above is evaluated (closureInfo
  # needs `toplevel`'s outPath, which requires evaluating the `assert ...;
  # runCommand ...` expression toplevel.nix returns to WHNF). This file's OWN
  # `busyboxModelValid`-style self-check (below) is the same belt-and-braces
  # forcing initramfs.nix does — if a future caller ever constructs a
  # `toplevel`-shaped value that bypasses toplevel.nix's own assert, this
  # still catches a missing/malformed marker locally rather than trusting the
  # transitive path alone. userspace/linux-image.nix reads this passthru
  # alongside its own `kernel`/`initramfs` args for the final cross-check.
  toplevelModel = seedRoot.processModel or (throw
    "userspace/base-squashfs.nix: the `toplevel` derivation has no "
    + "passthru.processModel — wire it in userspace/toplevel.nix before "
    + "building a squashfs of otherwise-ambiguous process model");
  toplevelModelValid = builtins.elem toplevelModel [ "nommu-spawn" "mmu-fork" ] || throw ''
    userspace/base-squashfs.nix: toplevel.processModel = "${toplevelModel}" is
    not one of the known process-model strings ("nommu-spawn"/"mmu-fork").
  '';
in
assert toplevelModelValid;
pkgs.runCommand "base-squashfs"
  {
    nativeBuildInputs = [ pkgs.squashfsTools ];
    # `passthru` is metadata-only — it does not affect $out's content.
    passthru.processModel = toplevelModel;
  }
  ''
    mkdir -p $out
    mksquashfs ${seedRoot}/nix $out/base.squashfs \
      -comp zstd -b ${toString blockSize} \
      -all-root -noappend -no-progress -reproducible
    echo "base.squashfs: $(du -h $out/base.squashfs | cut -f1)"
  ''
