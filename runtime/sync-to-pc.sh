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
# Engine files only (including make-worker.js). dylink.js + ffi-codegen.js are
# the #126 Track C runtime loader + FFI codegen (ENGINE_ABI 8) kernel-worker.js
# imports; asyncify.js (#129 fork seam) + softmmu-pass.js (#128 MMU
# instrumentation) are ENGINE_ABI 10's — the engine fails to load without them.
# (The ABI-10 sync shipped WITHOUT those two because this list wasn't updated:
# pc's kernel worker 404'd on ./asyncify.js and died detail-less before any
# code ran. The completeness check below now fails the sync instead.)
cp "$SRC"/{index.js,abi.js,boot.js,boot-nix-system.js,session.js,nix-cache.js,nix-store.js,kernel-host.js,kernel-worker.js,make-worker.js,dylink.js,ffi-codegen.js,asyncify.js,softmmu-pass.js} "$DEST/"
cp "$SRC"/ninep/{protocol.js,server.js,mem-vfs.js} "$DEST/ninep/"
# Wayland Phase 1 (1a/1b/1c/1d): the virtio_wasm transport device models + the
# virtio_wl device. Engine files only — the *.test.js bun harnesses stay in
# nix-wasm. wl-server.js is the Phase-1 in-worker stub; pc's Phase-2 inversion
# (worker→main Greenfield bridge) lives in pc, not synced from here. ninep-device.js
# is the virtio-9p host device (#10) — the 9P filesystem transport. console-device.js
# is the MULTIPORT virtio-console host device (#10 option 2 / #83) — the guest's
# SOLE console (hvc0..hvcN) on the stock mainline virtio-console driver; it
# replaced the bespoke hvc_wasm backend.
# vsock-device.js is the virtio-vsock host device (#10 option 3) — the AF_VSOCK
# socket channel substrate for the guest→host /Ctl bridge.
# snd-device.js is the virtio-snd host device (#145) — the guest's sound card;
# pc attaches its AudioWorklet sink via the snd.onReady boot hook.
cp "$SRC"/virtio/{device.js,vring.js,shared-queues.js,echo-device.js,wl-device.js,wl-server.js,net-device.js,blk-device.js,ninep-device.js,console-device.js,vsock-device.js,snd-device.js} "$DEST/virtio/"

# Completeness check: every relative import in the synced tree must resolve to
# a synced file. The copy lists above are hardcoded, so a new engine module
# (imported by kernel-worker.js etc.) that isn't added to a list would vendor a
# broken graph into pc — the kernel worker 404s a module and dies with a
# detail-less worker.onerror before any code (even the fatal reporter) runs.
# That shipped once (asyncify.js/softmmu-pass.js, ENGINE_ABI 10); never again.
check_failed=0
while IFS= read -r f; do
  dir="$(dirname "$f")"
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    if [ ! -f "$dir/$spec" ]; then
      echo "ERROR: $(basename "$f") imports \"$spec\" but the sync did not copy it — add it to the cp list above." >&2
      check_failed=1
    fi
  done < <(sed -n 's/^import[^"]*"\(\.[^"]*\)".*/\1/p' "$f")
done < <(find "$DEST" -name '*.js')
if [ "$check_failed" != 0 ]; then
  echo "ERROR: synced engine has unresolved imports; aborting (DEST left in place for inspection)." >&2
  exit 1
fi

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
