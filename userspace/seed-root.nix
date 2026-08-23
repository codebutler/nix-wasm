# seed-root.nix — deterministic directory tree shared by the legacy squashfs
# installer and the preseeded writable state-disk baseline.
{ pkgs, toplevel, channel ? null }:
let
  closure = pkgs.closureInfo {
    rootPaths = [ toplevel ] ++ pkgs.lib.optional (channel != null) channel;
  };
  processModel = toplevel.processModel or (throw
    "userspace/seed-root.nix: toplevel is missing passthru.processModel");
  processModelValid = builtins.elem processModel [ "nommu-spawn" "mmu-fork" ] || throw
    "userspace/seed-root.nix: unknown process model `${processModel}`";
in
assert processModelValid;
pkgs.runCommand "wasm-seed-root"
  {
    passthru = {
      inherit processModel;
      systemPath = toString toplevel;
    };
  }
  ''
    mkdir -p $out/nix/store $out/nix/var/nix/profiles
    while read -r p; do
      cp -a "$p" $out/nix/store/
    done < ${closure}/store-paths

    ln -s ${toplevel} $out/nix/var/nix/profiles/system-1-link
    ln -s system-1-link $out/nix/var/nix/profiles/system

    # The browser state disk is capped at 1.75 GiB. Gate the expanded tree,
    # not either compressed transport, so both delivery formats obey the same
    # installation budget.
    seed_bytes=$(du -s --block-size=1 $out/nix | cut -f1)
    seed_inodes=$(find $out/nix -xdev | wc -l)
    max_seed_bytes=$((1280 * 1024 * 1024))
    max_seed_inodes=100000
    echo "seed root: $seed_bytes bytes, $seed_inodes inodes"
    if [ "$seed_bytes" -gt "$max_seed_bytes" ]; then
      echo "ERROR: expanded seed exceeds 1280 MiB state-disk budget" >&2
      exit 1
    fi
    if [ "$seed_inodes" -gt "$max_seed_inodes" ]; then
      echo "ERROR: expanded seed exceeds 100000-inode state-disk budget" >&2
      exit 1
    fi
  ''
