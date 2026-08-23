# state-baseline.nix — a reproducible, already-installed ext2 state disk packed
# as a gzip-compressed CBHD sparse overlay. pc applies this immutable baseline
# to a zeroed SharedArrayBuffer and journals only writes made after attachment.
{ pkgs, toplevel, channel ? null, mode }:
let
  diskBytes = 1792 * 1024 * 1024;
  seedRoot = import ./seed-root.nix { inherit pkgs toplevel channel; };
  processModel = seedRoot.processModel;
  uuid =
    if mode == "mmu"
    then "594f5245-4d4d-5500-0000-000000000001"
    else if mode == "nommu"
    then "594f5245-4e4f-4d4d-5500-000000000001"
    else throw "userspace/state-baseline.nix: mode must be mmu or nommu";
in
pkgs.runCommand "wasm-state-baseline-${mode}"
  {
    nativeBuildInputs = [ pkgs.e2fsprogs pkgs.python3 ];
    passthru = {
      inherit diskBytes mode processModel;
      systemPath = seedRoot.systemPath;
      generation = 1;
      encoding = "gzip-cbhd-v1";
    };
  }
  ''
    export SOURCE_DATE_EPOCH=1
    export E2FSPROGS_FAKE_TIME=1
    export TZ=UTC

    mkdir -p root/nix root/home root/var $out
    cp -a ${seedRoot}/nix/. root/nix/
    printf 'installed=seed-v1\n' > root/.yore-linux-installed

    truncate -s ${toString diskBytes} state.ext2
    mkfs.ext2 -F -q -b 1024 -i 8192 -m 1 \
      -L YORE-${if mode == "mmu" then "MMU" else "NOMMU"} \
      -U ${uuid} \
      -E lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0 \
      -d root state.ext2
    e2fsck -fn state.ext2

    python3 ${../scripts/pack-state-baseline.py} \
      state.ext2 $out/state-baseline.cbhd.gz $out/state-baseline-info.json
    echo "state baseline: $(du -h $out/state-baseline.cbhd.gz | cut -f1)"
  ''
