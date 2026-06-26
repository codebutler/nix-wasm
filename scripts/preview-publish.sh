#!/usr/bin/env bash
# preview-publish.sh — build this PR's boot artifacts and publish a browser
# preview to the nix-wasm-previews R2 bucket (served by infra/preview-worker).
#
#   cas/<buildhash>/{vmlinux.wasm,initramfs.cpio.gz,base.squashfs}  (immutable)
#   pr-<N>/…                       the rclone-synced runtime/ frontend tree
#   pr-<N>/demo/web/preview.json   { artifactsBase: "/cas/<buildhash>/", … }
#
# The heavy toolchain (guest-clang, kernel LLVM) substitutes from the Cachix
# cache #2 ships; only PR-changed derivations rebuild.
#
# Usage:  bash scripts/preview-publish.sh <pr-number>
# CI sets RCLONE_CONFIG_R2_* + R2_ACCESS_KEY_ID. Locally, omit them for a DRY-RUN
# (builds, hashes, prints the rclone commands, uploads NOTHING). Pass a root nix
# daemon via NIX_CMD, e.g.:
#   NIX_CMD="echo pw | sudo -S nix" bash scripts/preview-publish.sh 999
set -euo pipefail

PR="${1:?usage: preview-publish.sh <pr-number>}"
NIX_CMD="${NIX_CMD:-nix}"
NIX="$NIX_CMD --extra-experimental-features 'nix-command flakes'"
BUCKET="${PREVIEW_BUCKET:-nix-wasm-previews}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="${PR_COMMIT:-$(git -C "$ROOT" rev-parse HEAD)}"
BUILT_AT="$(date -u +%FT%TZ)"

# 1. Build the three boot artifacts (each prints its own out path).
echo "==> Building .#kernel …";
# shellcheck disable=SC2086
KERNEL_OUT=$(eval "$NIX build .#kernel --no-link --print-out-paths")
echo "==> Building .#wasm-initramfs …";
# shellcheck disable=SC2086
INITRD_OUT=$(eval "$NIX build .#wasm-initramfs --no-link --print-out-paths")
echo "==> Building .#wasm-base-squashfs …";
# shellcheck disable=SC2086
SQUASH_OUT=$(eval "$NIX build .#wasm-base-squashfs --no-link --print-out-paths")

KERNEL="$KERNEL_OUT/vmlinux.wasm"
INITRD="$INITRD_OUT/initramfs.cpio.gz"
SQUASH="$SQUASH_OUT/base.squashfs"
for f in "$KERNEL" "$INITRD" "$SQUASH"; do
  [ -f "$f" ] || { echo "ERROR: expected artifact missing: $f" >&2; exit 1; }
done

# 2. buildhash = sha256 of the three store-path basenames (each encodes its own
#    content hash). Cheap, and changes iff any artifact changes.
BUILDHASH=$(printf '%s' "$(basename "$KERNEL_OUT")$(basename "$INITRD_OUT")$(basename "$SQUASH_OUT")" \
  | sha256sum | cut -c1-32)

# 3. Stage the artifacts under their runtime-expected names.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$KERNEL" "$STAGE/vmlinux.wasm"
cp "$INITRD" "$STAGE/initramfs.cpio.gz"
cp "$SQUASH" "$STAGE/base.squashfs"

PREVIEW_JSON=$(printf '{"artifactsBase":"/cas/%s/","pr":%s,"commit":"%s","builtAt":"%s"}\n' \
  "$BUILDHASH" "$PR" "$COMMIT" "$BUILT_AT")

echo ""
echo "PR              : $PR"
echo "commit          : $COMMIT"
echo "buildhash       : $BUILDHASH"
echo "cas prefix      : r2:$BUCKET/cas/$BUILDHASH/"
echo "preview.json    : $PREVIEW_JSON"
echo ""

RCLONE_FLAGS=(--s3-no-check-bucket --retries 3 --low-level-retries 3 --contimeout 15s)

# 4. Dry-run guard: no R2 credentials → print the commands and exit.
if [ -z "${R2_ACCESS_KEY_ID:-}" ]; then
  echo "==> DRY-RUN (R2_ACCESS_KEY_ID unset) — commands that WOULD run:"
  echo "  rclone copy '$STAGE' 'r2:$BUCKET/cas/$BUILDHASH' --ignore-existing ${RCLONE_FLAGS[*]}"
  echo "  rclone sync '$ROOT/runtime' 'r2:$BUCKET/pr-$PR' --delete \\"
  echo "    --exclude 'node_modules/**' --exclude 'demo/node/**' --exclude '*.test.js' \\"
  echo "    --exclude '.git/**' --transfers 16 --checkers 32 ${RCLONE_FLAGS[*]}"
  echo "  printf '%s' '<preview.json>' | rclone rcat 'r2:$BUCKET/pr-$PR/demo/web/preview.json' ${RCLONE_FLAGS[*]}"
  echo "==> preview URL would be \${PREVIEW_BASE_URL}/pr-$PR/demo/web/"
  exit 0
fi

# 5. Upload content-addressed artifacts (no-op if this build already exists).
echo "==> rclone copy → cas/$BUILDHASH (skip-existing) …"
rclone copy "$STAGE" "r2:$BUCKET/cas/$BUILDHASH" --ignore-existing --transfers 8 "${RCLONE_FLAGS[@]}" -v

# 6. Sync the frontend tree (only changed files upload; --delete prunes removed).
echo "==> rclone sync runtime/ → pr-$PR …"
rclone sync "$ROOT/runtime" "r2:$BUCKET/pr-$PR" --delete \
  --exclude 'node_modules/**' --exclude 'demo/node/**' --exclude '*.test.js' --exclude '.git/**' \
  --transfers 16 --checkers 32 "${RCLONE_FLAGS[@]}" -v

# 7. Write the per-PR pointer AFTER the sync (sync --delete would otherwise prune it).
echo "==> writing pr-$PR/demo/web/preview.json …"
printf '%s' "$PREVIEW_JSON" | rclone rcat "r2:$BUCKET/pr-$PR/demo/web/preview.json" "${RCLONE_FLAGS[@]}"

echo ""
echo "==> PUBLISHED preview pr-$PR  buildhash=$BUILDHASH"
echo "==> URL: \${PREVIEW_BASE_URL}/pr-$PR/demo/web/"
