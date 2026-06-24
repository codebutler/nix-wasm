#!/usr/bin/env bash
# build-artifacts.sh — build the wasm guest artifacts and assemble them under
# <repo>/.artifacts/ for the browser demo (runtime/web/artifacts -> ../../.artifacts).
#
# Builds four artifacts: vmlinux.wasm (.#kernel), initramfs.cpio.gz (.#wasm-initramfs),
# base.squashfs (.#wasm-base-squashfs — the read-only /nix overlay lowerdir, served
# over virtio-blk), and nix-cache/ (.#wasm-binary-cache — on-demand binary cache for
# toolchain substitution). galculator + the whole GTK3 stack and any deps-overlay fixes
# are pulled in transitively by the initramfs + squashfs base image.
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

echo "==> base squashfs (/nix overlay lowerdir)"
ln -sfn "$(nixbuild .#wasm-base-squashfs)/base.squashfs" "$ART/base.squashfs"

echo "==> binary cache (nix-cache/ — on-demand toolchain substitution)"
ln -sfn "$(nixbuild .#wasm-binary-cache)" "$ART/nix-cache"

echo "==> assembled artifacts in $ART:"
ls -l "$ART"
