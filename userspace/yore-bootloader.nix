# yore-bootloader — guest→host bootloader export (nix-wasm#177 G5).
#
# After activate, copy the current generation's kernel + initramfs + manifest
# onto the host VFS via 9P (`/mnt/yore/Home/Library/Linux/boot/`). Host JS then
# cold-boots from that mirror (pc linux-store loadBootMirror) without needing
# the ISO. Missing /mnt/yore is a no-op so busybox/harness boots still work.
#
# writeText (not writeShellScript): same rationale as activate.nix — avoid
# dragging host bash into the guest closure. Invoked as `sh "$script" "$sys"`.
{ pkgs }:
pkgs.writeText "yore-bootloader" (builtins.readFile ./yore-bootloader.sh)
