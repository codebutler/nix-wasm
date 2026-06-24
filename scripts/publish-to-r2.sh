#!/usr/bin/env bash
# publish-to-r2.sh — build the wasm artifacts and upload them to the
# pc-previews R2 bucket via wrangler (the preview-worker stamps CORP+CORS
# on /packages/* and /nix-cache/* routes).
#
# VERSION = the squashfs sha256 (content-addressed; safe to cache forever
# with immutable headers — the same bytes always live at the same key).
#
# On CI (x86_64-linux, cachix/install-nix-action):
#   - `nix` is available without sudo; the install-nix-action wires the daemon.
#   - Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID as GitHub secrets and
#     they'll be present in the env when this runs.
#
# Locally (aarch64 or x86_64 with a root nix daemon):
#   - The nix daemon requires sudo; pass NIX_CMD to override, e.g.:
#       NIX_CMD="echo password | sudo -S nix" bash scripts/publish-to-r2.sh
#   - Without CLOUDFLARE_API_TOKEN the script runs in DRY-RUN mode: it builds,
#     hashes, and prints the wrangler commands that WOULD run, then exits 0
#     without uploading anything.
#
# IMPORTANT — --remote is MANDATORY on wrangler r2 object put.
# Without it wrangler 4.x writes to the local wrangler-local-state simulator
# and the live URL returns 404. Always pass --remote when uploading for real.
#
# R2 bucket layout (served by the pc-previews Cloudflare Worker):
#   packages/nix-wasm-base/<version>   — base.squashfs (virtio-blk block device)
#   nix-cache/<relpath>                — binary cache tree (nix-cache.js serves)
#
# After publishing, update pc js/packages/registry.js with the emitted
# bytes/sha256/version values (see the deploy-r2.md runbook).

set -euo pipefail

# NIX_CMD can be overridden locally when sudo is required.
# CI default: plain `nix` (install-nix-action provides daemon access).
NIX_CMD="${NIX_CMD:-nix}"
NIX="$NIX_CMD --extra-experimental-features 'nix-command flakes'"

# ---------------------------------------------------------------------------
# 1. Build the artifacts
# ---------------------------------------------------------------------------
echo "==> Building .#wasm-base-squashfs …"
# shellcheck disable=SC2086
SQ_STORE=$(eval "$NIX build .#wasm-base-squashfs --print-out-paths --no-link")
SQ="$SQ_STORE/base.squashfs"

echo "==> Building .#wasm-binary-cache …"
# shellcheck disable=SC2086
CACHE=$(eval "$NIX build .#wasm-binary-cache --print-out-paths --no-link")

# ---------------------------------------------------------------------------
# 2. Compute version (= content hash) + byte size
# ---------------------------------------------------------------------------
SHA=$(sha256sum "$SQ" | cut -d' ' -f1)
BYTES=$(stat -c%s "$SQ")
VERSION="$SHA"

echo ""
echo "base.squashfs path  : $SQ"
echo "base.squashfs bytes : $BYTES"
echo "base.squashfs sha256: $SHA"
echo "version             : $VERSION"
echo "binary-cache path   : $CACHE"
echo ""

# Emit as GitHub step summary (no-op outside CI — GITHUB_STEP_SUMMARY is unset)
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## wasm artifacts published"
    echo "| field | value |"
    echo "|-------|-------|"
    echo "| bytes | \`$BYTES\` |"
    echo "| sha256 | \`$SHA\` |"
    echo "| version | \`$VERSION\` |"
    echo ""
    echo "Update \`pc js/packages/registry.js\` with these values (see deploy-r2.md)."
  } >> "$GITHUB_STEP_SUMMARY"
fi

# ---------------------------------------------------------------------------
# 3. Guard: dry-run when no Cloudflare credentials are present
# ---------------------------------------------------------------------------
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "==> DRY-RUN (CLOUDFLARE_API_TOKEN is unset) — wrangler commands that WOULD run:"
  echo ""
  echo "  # Upload base squashfs (identity mount; Linux reads .squashfs directly via virtio-blk)"
  echo "  bunx wrangler r2 object put \\"
  echo "    \"pc-previews/packages/nix-wasm-base/$VERSION\" \\"
  echo "    --file \"$SQ\" --content-type application/octet-stream --remote"
  echo ""
  echo "  # Upload binary-cache tree (nix-cache-info + *.narinfo + nar/* + pkgs.nix + manifest.json)"
  ( cd "$CACHE" && find . -type f -print0 | while IFS= read -r -d '' f; do
      REL="${f#./}"
      echo "  bunx wrangler r2 object put \"pc-previews/nix-cache/$REL\" \\"
      echo "    --file \"$CACHE/$REL\" --content-type application/octet-stream --remote"
    done )
  echo ""
  echo "==> bytes=$BYTES sha256=$SHA version=$VERSION"
  echo "==> update pc js/packages/registry.js: bytes=$BYTES sha256=$SHA version=$VERSION"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Real upload — CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID must be set
# ---------------------------------------------------------------------------

# 4a. Base squashfs → packages/nix-wasm-base/<version>
# The content-type is application/octet-stream; the preview-worker adds
# CORP+CORS+immutable headers on the /packages/* route.
echo "==> Uploading base.squashfs to pc-previews/packages/nix-wasm-base/$VERSION …"
bunx wrangler r2 object put \
  "pc-previews/packages/nix-wasm-base/$VERSION" \
  --file "$SQ" --content-type application/octet-stream --remote

# 4b. Binary-cache tree → nix-cache/<relpath>
# Uploads: nix-cache-info, *.narinfo, nar/*.nar.zst, pkgs.nix, manifest.json.
# The runtime/nix-cache.js fetches manifest.json first to build its file index.
echo "==> Uploading binary-cache tree to pc-previews/nix-cache/ …"
( cd "$CACHE" && find . -type f -print0 | while IFS= read -r -d '' f; do
    REL="${f#./}"
    echo "  uploading nix-cache/$REL …"
    bunx wrangler r2 object put "pc-previews/nix-cache/$REL" \
      --file "$CACHE/$REL" --content-type application/octet-stream --remote
  done )

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo ""
echo "==> PUBLISHED nix-wasm-base version=$VERSION"
echo "==> bytes=$BYTES sha256=$SHA version=$VERSION"
echo "==> update pc js/packages/registry.js: bytes=$BYTES sha256=$SHA version=$VERSION"
