#!/usr/bin/env bash
# build-artifacts.sh — build the wasm guest artifacts and assemble them under
# <repo>/.artifacts/ for the browser demo (runtime/web/artifacts -> ../../.artifacts).
#
# Builds vmlinux.wasm (.#kernel), initramfs.cpio.gz (.#wasm-initramfs), and the
# served store (.#wasm-store-manifest -> store.json + store-content/). galculator +
# the whole GTK3 stack and any deps-overlay fixes (e.g. the libxkbcommon HAVE_MMAP
# fix) are pulled in transitively by the initramfs + store manifest.
#
# The nix daemon runs as root in this environment, so builds use `sudo nix`.
# sudo must be usable non-interactively (run `sudo -v` first if it prompts).
# Drop sudo with `SUDO= bun run artifacts` if your daemon does not need root.
#
# Run via the package.json script: `bun run artifacts` (from runtime/).
set -euo pipefail

SUDO="${SUDO-sudo}"
# repo root = runtime/.. ; .artifacts lives there (the runtime/web/artifacts symlink target).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ART="$ROOT/.artifacts"

nixbuild() {
  $SUDO nix --extra-experimental-features "nix-command flakes" \
    build "$1" --no-link --print-out-paths
}

mkdir -p "$ART"
cd "$ROOT"

echo "==> kernel (vmlinux.wasm)"
ln -sfn "$(nixbuild .#kernel)/vmlinux.wasm" "$ART/vmlinux.wasm"

echo "==> initramfs.cpio.gz (busybox + /bin/* incl. galculator/gtk-hello)"
ln -sfn "$(nixbuild .#wasm-initramfs)/initramfs.cpio.gz" "$ART/initramfs.cpio.gz"

echo "==> store manifest (store.json + store-content/)"
sm="$(nixbuild .#wasm-store-manifest)"
ln -sfn "$sm/store.json" "$ART/store.json"
ln -sfn "$sm/store-content" "$ART/store-content"

echo "==> assembled artifacts in $ART:"
ls -l "$ART"
