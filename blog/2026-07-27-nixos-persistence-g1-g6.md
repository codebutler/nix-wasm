# Installed NixOS persistence — G1–G6 landed (smoke pending CI)

**Date:** 2026-07-27  
**Refs:** [#177](https://github.com/codebutler/nix-wasm/issues/177), PR [#178](https://github.com/codebutler/nix-wasm/pull/178), pc [#793](https://github.com/codebutler/pc/pull/793)

Eric locked the model: ISO = installer/recovery seed; first boot **copies**
`/nix` onto a RW virtio-blk; later boots mount that store directly; updates are
Nix/Cachix only. This session implements the engine + bootstrap + bootloader
export seams (and the pc host store against them).

## What shipped

| Gate | Change |
|------|--------|
| G2/G3 | `ENGINE_ABI` 11→12; `/dev/vdb` at host index 1 (reclaim echo); RW `BlkDevice` + CBHD `saveDisk` |
| G4 | `bootstrap.nix` install vs installed (mkfs+copy vs mount `vdb`) |
| G5 | `pc-bootloader` copies `$sys/boot/*` → `/mnt/pc/Home/Library/Linux/boot/` after activate |
| G6 | `$sys/boot/{vmlinux.wasm,initramfs.cpio.gz,manifest.json}` in the system closure |
| pc | `linux-store`, lock/quota/Reset, autosave, flush-before-kill, pagehide, boot-mirror I/O |

## Still open

- **G1 smoke** (`blk-rw-smoke.mjs`) needs a healthy Node virtio boot. This agent
  environment hangs worker/`Atomics` before console output even on master
  kernel+runtime — prove G1 in CI / on the rig.
- Full E2E DoD (§10): package survives Shut Down; Cachix upgrade without ISO;
  generation switch + rollback; two-tab lock.
- Channel publish runbook: Cachix for installed systems; ISO republish for seed only.
