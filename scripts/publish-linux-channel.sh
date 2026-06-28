#!/usr/bin/env bash
# publish-linux-channel.sh — republish the versioned `linux` guest channel that
# pc resolves at runtime (`js/packages/linux-channel.js` → `packages/linux/latest.json`).
#
# This is the channel republish from `vendor/linux-wasm/SOURCE.md` §"Republish the
# guest", automated: build the boot bundle + toolchain cache, upload them under a
# NEW immutable version, then flip the `latest.json` pointer. A guest change reaches
# the live site with NO pc deploy — pc fetches latest.json (served no-cache) on the
# next Linux-app open.
#
# R2 layout (bucket `pc-previews`, served by infra/preview-worker with CORP+CORS):
#   packages/linux/<v>/linux.iso        — the channel image (.#linux-image):
#                                         vmlinux.wasm + initramfs.cpio.gz +
#                                         base.squashfs + manifest.json bundled
#   packages/linux/<v>/nix-cache/       — ONLY pkgs.nix + paths.nix (the nix-wasm
#                                         `nix-env -iA` / new-CLI catalogs, NOT in
#                                         Cachix). The heavy nars + *.narinfo +
#                                         nix-cache-info are NOT uploaded — the guest
#                                         gets them from Cachix through the worker's
#                                         /cachix/<v> proxy (nix-wasm#78).
#   packages/linux/latest.json          — the pointer pc reads (no-cache route);
#                                         its nixCacheBaseUrl points at /cachix/<v>
#
# <v> = the linux.iso sha256 (content-addressed → immutable, safe to cache forever;
# republishing identical bytes is idempotent, new bytes get a fresh key).
#
# minEngine is parsed from runtime/abi.js (the SAME source .#linux-image bakes into
# the image's manifest.json) so the channel guard can never drift from the engine
# ABI the vendored JS implements. pc refuses an image whose minEngine exceeds the
# vendored engine's ENGINE_ABI ("reload pc"), so this number MUST match a deployed
# pc that vendors an engine at or above it.
#
# On CI (publish-linux-channel.yml, x86_64, cachix/install-nix-action): `nix` needs
# no sudo; CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID are present from secrets.
# Locally: pass NIX_CMD for a root daemon, e.g.
#   NIX_CMD="echo password | sudo -S nix" bash scripts/publish-linux-channel.sh
# Without CLOUDFLARE_API_TOKEN (or with DRY_RUN=true) the script is a DRY-RUN: it
# builds, hashes, and prints the wrangler commands + the latest.json it WOULD
# write, then exits 0 — uploading nothing.
#
# IMPORTANT — --remote is MANDATORY on `wrangler r2 object put`. Without it
# wrangler 4.x writes to the local simulator and the live URL 404s.

set -euo pipefail

NIX_CMD="${NIX_CMD:-nix}"
NIX="$NIX_CMD --extra-experimental-features 'nix-command flakes'"
BUCKET="${PREVIEW_BUCKET:-pc-previews}"
# Public origin the worker serves R2 under (used to build the absolute URLs pc fetches).
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://pc-previews.eric-c6b.workers.dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# 1. Build the channel image + toolchain cache
# ---------------------------------------------------------------------------
echo "==> Building .#linux-image …"
# shellcheck disable=SC2086
IMG_STORE=$(eval "$NIX build .#linux-image --print-out-paths --no-link")
# make-iso9660-image emits the iso under $out/iso/; locate it robustly.
ISO=$(find "$IMG_STORE" -name linux.iso -type f | head -1)
[ -n "$ISO" ] && [ -f "$ISO" ] || { echo "ERROR: linux.iso not found under $IMG_STORE" >&2; exit 1; }

echo "==> Building .#wasm-binary-cache …"
# shellcheck disable=SC2086
CACHE=$(eval "$NIX build .#wasm-binary-cache --print-out-paths --no-link")

# ---------------------------------------------------------------------------
# 2. Version (= image content hash) + minEngine (from runtime/abi.js)
# ---------------------------------------------------------------------------
SHA=$(sha256sum "$ISO" | cut -d' ' -f1)
BYTES=$(stat -c%s "$ISO")
VERSION="$SHA"

# Parse the ACTUAL `export const ENGINE_ABI = N;` line (not the comment lines that
# also mention ENGINE_ABI) — matches linux-image.nix's parse exactly.
MIN_ENGINE=$(grep -oE '^[[:space:]]*export const ENGINE_ABI = [0-9]+;' "$ROOT/runtime/abi.js" \
  | grep -oE '[0-9]+' | head -1)
[ -n "$MIN_ENGINE" ] || { echo "ERROR: could not parse ENGINE_ABI from runtime/abi.js" >&2; exit 1; }

IMG_URL="$PUBLIC_BASE_URL/packages/linux/$VERSION/linux.iso"
# The guest's nix-cache.js uses ONE baseUrl for nix-cache-info / *.narinfo / nar/*
# AND pkgs.nix / paths.nix. The worker's /cachix/<v> route unifies them: catalogs
# from R2 (packages/linux/<v>/nix-cache/), everything else proxied from
# nix-wasm.cachix.org (nix-wasm#78). Point at it, NOT the raw R2 nix-cache path.
NIX_CACHE_URL="$PUBLIC_BASE_URL/cachix/$VERSION"

# latest.json — exactly the shape js/packages/linux-channel.js resolves:
#   { version, minEngine, nixCacheBaseUrl, image: { url, bytes, sha256 } }
LATEST_JSON=$(printf '{"version":"%s","minEngine":%s,"nixCacheBaseUrl":"%s","image":{"url":"%s","bytes":%s,"sha256":"%s"}}\n' \
  "$VERSION" "$MIN_ENGINE" "$NIX_CACHE_URL" "$IMG_URL" "$BYTES" "$SHA")

echo ""
echo "linux.iso path  : $ISO"
echo "linux.iso bytes : $BYTES"
echo "linux.iso sha256: $SHA"
echo "version <v>      : $VERSION"
echo "minEngine        : $MIN_ENGINE"
echo "nix-cache path   : $CACHE"
echo "latest.json      : $LATEST_JSON"
echo ""

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## linux channel republished"
    echo "| field | value |"
    echo "|-------|-------|"
    echo "| version | \`$VERSION\` |"
    echo "| minEngine | \`$MIN_ENGINE\` |"
    echo "| bytes | \`$BYTES\` |"
    echo "| image | \`$IMG_URL\` |"
    echo ""
    echo "pc resolves \`packages/linux/latest.json\` on the next Linux-app open — no pc deploy needed."
  } >> "$GITHUB_STEP_SUMMARY"
fi

# ---------------------------------------------------------------------------
# 3. Dry-run when no Cloudflare credentials are present
# ---------------------------------------------------------------------------
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ "${DRY_RUN:-}" = "true" ]; then
  echo "==> DRY-RUN (CLOUDFLARE_API_TOKEN unset or DRY_RUN=true) — wrangler commands that WOULD run:"
  echo ""
  echo "  bunx wrangler r2 object put \"$BUCKET/packages/linux/$VERSION/linux.iso\" \\"
  echo "    --file \"$ISO\" --content-type application/x-iso9660-image --remote"
  echo ""
  echo "  # ONLY the nix-wasm catalogs (pkgs.nix + paths.nix); nars come from Cachix (#78)"
  ( cd "$CACHE" && find . -maxdepth 1 -type f \( -name pkgs.nix -o -name paths.nix \) -print0 | while IFS= read -r -d '' f; do
      REL="${f#./}"
      echo "  bunx wrangler r2 object put \"$BUCKET/packages/linux/$VERSION/nix-cache/$REL\" \\"
      echo "    --file \"$CACHE/$REL\" --content-type application/octet-stream --remote"
    done )
  echo ""
  echo "  # flip the pointer LAST (served no-cache → picked up immediately)"
  echo "  printf '%s' '<latest.json above>' | bunx wrangler r2 object put \\"
  echo "    \"$BUCKET/packages/linux/latest.json\" --file - --content-type application/json --remote"
  echo ""
  echo "==> version=$VERSION minEngine=$MIN_ENGINE bytes=$BYTES"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Real upload — CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID must be set.
#    Order matters: upload the immutable image + cache FIRST, flip latest.json
#    LAST, so a client never resolves a pointer to bytes that aren't up yet.
# ---------------------------------------------------------------------------

# Preflight: wrangler must actually RUN. On too-old Node it prints a "requires
# Node >= 22" notice and exits 0 (uploading nothing) — which is exactly how the
# first run silently published nothing while the job went green. Catch that here
# (grep the output, not just the exit code) and fail loudly before relying on it.
echo "==> wrangler preflight …"
WRANGLER_OUT="$(bunx wrangler --version 2>&1)" || { echo "ERROR: wrangler failed to run:" >&2; echo "$WRANGLER_OUT" >&2; exit 1; }
case "$WRANGLER_OUT" in
  *"requires at least Node"*|*"Wrangler requires"*)
    echo "ERROR: wrangler cannot run in this environment:" >&2; echo "$WRANGLER_OUT" >&2; exit 1;;
esac
echo "    wrangler $WRANGLER_OUT"

echo "==> Uploading linux.iso → $BUCKET/packages/linux/$VERSION/linux.iso …"
bunx wrangler r2 object put "$BUCKET/packages/linux/$VERSION/linux.iso" \
  --file "$ISO" --content-type application/x-iso9660-image --remote

# Upload ONLY the nix-wasm catalogs (pkgs.nix + paths.nix) — the `nix-env -iA` /
# new-CLI indexes, which are nix-wasm artifacts NOT present in Cachix. The heavy
# nars + *.narinfo + nix-cache-info are deliberately NOT uploaded: the guest
# substitutes them from Cachix through the worker's /cachix/<v> proxy
# (nix-wasm#78, which nixCacheBaseUrl points at). Same split publish-to-r2.sh
# already does. Precondition: nix-wasm CI pushed the .#wasm-binary-cache closure
# to nix-wasm.cachix.org — the nix-wasm.yml artifacts job does, on this commit;
# this publish substitutes that same closure, so it is guaranteed present.
echo "==> Uploading nix-wasm catalogs (pkgs.nix + paths.nix) → $BUCKET/packages/linux/$VERSION/nix-cache/ …"
( cd "$CACHE" && find . -maxdepth 1 -type f \( -name pkgs.nix -o -name paths.nix \) -print0 | while IFS= read -r -d '' f; do
    REL="${f#./}"
    echo "  uploading nix-cache/$REL …"
    bunx wrangler r2 object put "$BUCKET/packages/linux/$VERSION/nix-cache/$REL" \
      --file "$CACHE/$REL" --content-type application/octet-stream --remote
  done )

echo "==> Flipping pointer → $BUCKET/packages/linux/latest.json …"
TMP_LATEST="$(mktemp)"
trap 'rm -f "$TMP_LATEST"' EXIT
printf '%s' "$LATEST_JSON" > "$TMP_LATEST"
bunx wrangler r2 object put "$BUCKET/packages/linux/latest.json" \
  --file "$TMP_LATEST" --content-type application/json --remote

# Verify the flip actually landed (latest.json is served no-cache). Belt-and-
# suspenders against any silent wrangler no-op: re-fetch the live pointer and
# assert it now carries THIS version, else fail the job.
echo "==> Verifying latest.json went live …"
for attempt in 1 2 3 4 5; do
  LIVE="$(curl -fsS "$PUBLIC_BASE_URL/packages/linux/latest.json" 2>/dev/null || true)"
  case "$LIVE" in
    *"\"version\":\"$VERSION\""*) echo "    verified: latest.json → $VERSION"; break;;
  esac
  if [ "$attempt" = 5 ]; then
    echo "ERROR: latest.json did not update to version $VERSION after the flip." >&2
    echo "live latest.json was: $LIVE" >&2
    exit 1
  fi
  sleep 3
done

echo ""
echo "==> PUBLISHED linux channel: version=$VERSION minEngine=$MIN_ENGINE"
echo "==> image: $IMG_URL"
echo "==> pc will resolve it on the next Linux-app open (latest.json is no-cache)."
