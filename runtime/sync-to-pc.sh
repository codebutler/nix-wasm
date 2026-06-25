#!/usr/bin/env bash
# sync-to-pc.sh — copy the linux-wasm-runtime ENGINE subset into pc's vendor
# tree. Excludes node/, web/, tests, package config (pc consumes the engine,
# not the dev harnesses). Stamps the source commit into pc's SOURCE.md.
#
# Usage: runtime/sync-to-pc.sh /path/to/pc
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # nix-wasm/runtime
PC="${1:?usage: sync-to-pc.sh <pc-repo-path>}"
DEST="$PC/vendor/linux-wasm/runtime"
SHA="$(git -C "$SRC" rev-parse --short HEAD)"
DATE="$(date -u +%Y-%m-%d)"

rm -rf "$DEST"
mkdir -p "$DEST/ninep" "$DEST/virtio"
# Engine files only (including make-worker.js):
cp "$SRC"/{index.js,abi.js,boot.js,boot-nix-system.js,session.js,nix-cache.js,nix-store.js,kernel-host.js,kernel-worker.js,make-worker.js} "$DEST/"
cp "$SRC"/ninep/{protocol.js,server.js,mem-vfs.js} "$DEST/ninep/"
# Wayland Phase 1 (1a/1b/1c/1d): the virtio_wasm transport device models + the
# virtio_wl device. Engine files only — the *.test.js bun harnesses stay in
# nix-wasm. wl-server.js is the Phase-1 in-worker stub; pc's Phase-2 inversion
# (worker→main Greenfield bridge) lives in pc, not synced from here. ninep-device.js
# is the virtio-9p host device (#10) — the 9P filesystem transport.
# vsock-device.js is the virtio-vsock host device (#10 option 3) — the AF_VSOCK
# socket channel substrate for the guest→host /Ctl bridge.
cp "$SRC"/virtio/{device.js,vring.js,shared-queues.js,echo-device.js,wl-device.js,wl-server.js,net-device.js,blk-device.js,ninep-device.js,vsock-device.js} "$DEST/virtio/"

# Provenance stamp into pc's SOURCE.md (idempotent: replace the marker line).
MARK="<!-- runtime-sync -->"
LINE="$MARK Engine synced from nix-wasm@$SHA on $DATE."
SRCMD="$PC/vendor/linux-wasm/SOURCE.md"
if grep -q "$MARK" "$SRCMD" 2>/dev/null; then
  # portable in-place replace
  tmp="$(mktemp)"; sed "s|^$MARK.*|$LINE|" "$SRCMD" > "$tmp" && mv "$tmp" "$SRCMD"
else
  printf '\n%s\n' "$LINE" >> "$SRCMD"
fi
echo "synced engine → $DEST (nix-wasm@$SHA)"
