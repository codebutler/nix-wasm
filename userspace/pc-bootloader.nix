# pc-bootloader — guest→host bootloader export (nix-wasm#177 G5).
#
# After activate, copy the current generation's kernel + initramfs + manifest
# onto the host VFS via 9P (`/mnt/pc/Home/Library/Linux/boot/`). Host JS then
# cold-boots from that mirror (pc linux-store loadBootMirror) without needing
# the ISO. Missing /mnt/pc is a no-op so busybox/harness boots still work.
#
# writeText (not writeShellScript): same rationale as activate.nix — avoid
# dragging host bash into the guest closure. Invoked as `sh "$script" "$sys"`.
{ pkgs }:
pkgs.writeText "pc-bootloader" ''
  #!/bin/sh
  set -e
  sys="$1"
  [ -n "$sys" ] || exit 0
  # Require the host-prepared Linux library tree (pc ensureLinuxTree). Harness
  # MemVfs boots expose /mnt/pc/Home for 9P tests only — copying multi-MB
  # vmlinux.wasm there during activate blocks the shell past CI prompt budgets.
  [ -d /mnt/pc/Home/Library/Linux ] || exit 0
  [ -f "$sys/boot/vmlinux.wasm" ] || exit 0
  [ -f "$sys/boot/initramfs.cpio.gz" ] || exit 0
  [ -f "$sys/boot/manifest.json" ] || exit 0

  BOOT=/mnt/pc/Home/Library/Linux/boot
  mkdir -p "$BOOT/current" || exit 0

  # Generation number: prefer manifest, else basename of a system-N-link, else 1.
  gen=$(sed -n 's/.*"generation"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
    "$sys/boot/manifest.json" 2>/dev/null | head -n 1)
  [ -n "$gen" ] || gen=1

  mkdir -p "$BOOT/generation-$gen" || true
  for f in vmlinux.wasm initramfs.cpio.gz manifest.json; do
    cp -f "$sys/boot/$f" "$BOOT/current/$f" || exit 0
    cp -f "$sys/boot/$f" "$BOOT/generation-$gen/$f" || true
  done
''
