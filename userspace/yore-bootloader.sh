#!/bin/sh
# Export the active Nix system generation to yore-pc's host boot mirror.
set -e

sys="$1"
[ -n "$sys" ] || exit 0

PROFILE=${YORE_SYSTEM_PROFILE:-/nix/var/nix/profiles/system}
HOST_LINUX=${YORE_HOST_LINUX:-/mnt/yore/Home/Library/Linux}
BOOT="$HOST_LINUX/boot"

# Harness boots without the host-prepared Linux tree intentionally skip export.
[ -d "$HOST_LINUX" ] || exit 0
[ -f "$sys/boot/vmlinux.wasm" ] || exit 0
[ -f "$sys/boot/initramfs.cpio.gz" ] || exit 0
[ -f "$sys/boot/manifest.json" ] || exit 0

# Generation is profile state, not immutable system metadata. Require the
# standard system -> system-N-link -> /nix/store/... chain and prove that the
# selected numbered link is the system activation asked us to export.
profile_target=$(readlink "$PROFILE" 2>/dev/null || true)
case "$profile_target" in
  system-[0-9]*-link) ;;
  *) echo "yore-bootloader: active system profile is not generational" >&2; exit 1 ;;
esac
gen=${profile_target#system-}
gen=${gen%-link}
case "$gen" in *[!0-9]*|'') echo "yore-bootloader: invalid generation" >&2; exit 1 ;; esac

profile_dir=${PROFILE%/*}
generation_sys=$(readlink "$profile_dir/system-$gen-link" 2>/dev/null || true)
[ "$generation_sys" = "$sys" ] || {
  echo "yore-bootloader: generation $gen does not select $sys" >&2
  exit 1
}

kernel_abi=$(sed -n 's/.*"kernelAbi"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  "$sys/boot/manifest.json" | head -n 1)
mode=$(sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$sys/boot/manifest.json" | head -n 1)
case "$kernel_abi" in *[!0-9]*|'') echo "yore-bootloader: invalid kernel ABI" >&2; exit 1 ;; esac
case "$mode" in mmu|nommu) ;; *) echo "yore-bootloader: invalid boot mode" >&2; exit 1 ;; esac

manifest=$(printf '{"kernelAbi":%s,"generation":%s,"system":"%s","mode":"%s"}\n' \
  "$kernel_abi" "$gen" "$sys" "$mode")

# BusyBox cp copies regular files in small blocks. Across the synchronous 9P
# mount that turns a 45 MiB initramfs into thousands of request/reply cycles.
# dd's 4 MiB input buffer lets the kernel fill the negotiated 4 MiB msize,
# preserving identical bytes with far fewer RPCs.
copy_boot_blob() {
  dd if="$1" of="$2" bs=4194304 2>/dev/null
}

gen_dir="$BOOT/generation-$gen"
cur_dir="$BOOT/current"
mkdir -p "$gen_dir" "$cur_dir"

# Retain every generation for recovery. Write manifest last: it is the commit
# marker consumed by the host, after both boot binaries are complete.
copy_boot_blob "$sys/boot/vmlinux.wasm" "$gen_dir/vmlinux.wasm"
copy_boot_blob "$sys/boot/initramfs.cpio.gz" "$gen_dir/initramfs.cpio.gz"
printf '%s' "$manifest" > "$gen_dir/manifest.json.tmp"
mv -f "$gen_dir/manifest.json.tmp" "$gen_dir/manifest.json"

# current/ is a tiny committed pointer to the retained generation. The host
# resolves its binaries from generation-N using this manifest; copying the same
# 52+ MiB payload here doubled activation time and storage for no new recovery
# value. Remove legacy flattened blobs before flipping the pointer.
rm -f "$cur_dir/vmlinux.wasm" "$cur_dir/initramfs.cpio.gz"
printf '%s' "$manifest" > "$cur_dir/manifest.json.tmp"
mv -f "$cur_dir/manifest.json.tmp" "$cur_dir/manifest.json"
