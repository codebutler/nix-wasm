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
# R2 layout — the DEDICATED `pc-packages` bucket (pc#416), served by
# infra/preview-worker with CORP+CORS. Keys are FLATTENED (no `packages/` prefix):
# the worker's `/packages/<id>/…` route drops the `/packages` segment and reads
# `<id>/…` from env.PACKAGES, so the R2 key for the linux channel is `linux/…`
# while the public URL pc fetches stays `…/packages/linux/…`.
#   linux/<v>/linux.iso        — the channel image (.#linux-image): vmlinux.wasm +
#                                initramfs.cpio.gz + base.squashfs + manifest.json
#   linux/<v>/nix-cache/       — ONLY pkgs.nix + paths.nix (the nix-wasm `nix-env
#                                -iA` / new-CLI catalogs, NOT in Cachix). The heavy
#                                nars + *.narinfo + nix-cache-info are NOT uploaded
#                                — the guest gets them from Cachix through the
#                                worker's /cachix/<v> proxy (nix-wasm#78).
#   linux/latest.json          — the pointer pc reads (no-cache route);
#                                its nixCacheBaseUrl points at /cachix/<v>
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
#
# The linux.iso goes up via RCLONE, not wrangler: `wrangler r2 object put` caps
# at 300 MiB and the image passed that when the X11 stack landed (~340 MiB). That
# needs R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (an R2 token's S3 keys) and
# CLOUDFLARE_ACCOUNT_ID, alongside CLOUDFLARE_API_TOKEN for the small objects.

set -euo pipefail

# Wrangler is PINNED. `bunx wrangler` (unpinned) resolves to the newest release,
# and on 2026-08-11 that broke the publish outright:
#
#     error: No version matching "5.20260804.1-alpha" found for specifier
#            "miniflare" (but package exists)
#     error: miniflare@5.20260804.1-alpha failed to resolve
#
# A transitive alpha dep of a newer wrangler stopped resolving, so a release
# path failed for reasons unrelated to what was being released. 4.119.0 is the
# version this script last published successfully with. Same lesson as the
# unpinned xkeyboard-config clone: never leave a tool floating in a path you
# need to be reproducible.
WRANGLER=wrangler@4.119.0

NIX_CMD="${NIX_CMD:-nix}"
NIX="$NIX_CMD --extra-experimental-features 'nix-command flakes'"
# The dedicated disc-packages bucket (pc#416). The linux channel image + pointer
# live here, NOT in pc-previews (which now only holds the site preview overlay).
BUCKET="${PACKAGES_BUCKET:-pc-packages}"
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
  echo "  # rclone (not wrangler): the image is >300 MiB, wrangler's hard cap"
  echo "  rclone copyto \"$ISO\" \"r2:$BUCKET/linux/$VERSION/linux.iso\" \\"
  echo "    --header-upload \"Content-Type: application/x-iso9660-image\" \\"
  echo "    --s3-chunk-size 64M --no-check-dest"
  echo ""
  echo "  # ONLY the nix-wasm catalogs (pkgs.nix + paths.nix); nars come from Cachix (#78)"
  ( cd "$CACHE" && find . -maxdepth 1 -type f \( -name pkgs.nix -o -name paths.nix \) -print0 | while IFS= read -r -d '' f; do
      REL="${f#./}"
      echo "  bunx $WRANGLER r2 object put \"$BUCKET/linux/$VERSION/nix-cache/$REL\" \\"
      echo "    --file \"$CACHE/$REL\" --content-type application/octet-stream --remote"
    done )
  echo ""
  echo "  # flip the pointer LAST (served no-cache → picked up immediately)"
  echo "  printf '%s' '<latest.json above>' | bunx $WRANGLER r2 object put \\"
  echo "    \"$BUCKET/linux/latest.json\" --file - --content-type application/json --remote"
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
WRANGLER_OUT="$(bunx "$WRANGLER" --version 2>&1)" || { echo "ERROR: wrangler failed to run:" >&2; echo "$WRANGLER_OUT" >&2; exit 1; }
case "$WRANGLER_OUT" in
  *"requires at least Node"*|*"Wrangler requires"*)
    echo "ERROR: wrangler cannot run in this environment:" >&2; echo "$WRANGLER_OUT" >&2; exit 1;;
esac
echo "    wrangler $WRANGLER_OUT"

echo "==> Uploading linux.iso → $BUCKET/linux/$VERSION/linux.iso …"
# rclone, NOT wrangler: `wrangler r2 object put` hard-caps at 300 MiB, and the
# channel image crossed that when the X11 stack (Xwayland/sommelier/GTK2/XChat)
# landed -- it is ~340 MiB now and only grows. rclone talks R2's S3 endpoint and
# does multipart automatically. Same remedy the big-disc workflows already use
# (see .claude/rules/disc-packages.md in pc). Needs an R2 API token's S3 keys
# (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) -- a DIFFERENT credential from
# CLOUDFLARE_API_TOKEN, which has no r2 scope.
#
# NOTE: keep apostrophes OUT of the ${var:?...} messages below -- bash does
# quote processing on that word, so a lone ' opens a quote and swallows the
# following line (it did exactly that on the first CI run).
#
# --no-check-dest is REQUIRED, not an optimisation: rclone HEADs the destination
# first, and R2 answers 403 (not 404) for a HeadObject on a MISSING key when the
# token cannot list the bucket -- so the FIRST publish of any new version dies
# with "operation error S3: HeadObject ... 403 Forbidden". Skipping the stat is
# correct anyway: the key is immutable and content-addressed.
: "${R2_ACCESS_KEY_ID:?rclone needs R2_ACCESS_KEY_ID -- the S3 access key of an R2 API token, NOT CLOUDFLARE_API_TOKEN}"
: "${R2_SECRET_ACCESS_KEY:?rclone needs R2_SECRET_ACCESS_KEY -- the S3 secret of an R2 API token, NOT CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?rclone needs CLOUDFLARE_ACCOUNT_ID for the S3 endpoint}"
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
rclone copyto "$ISO" "r2:$BUCKET/linux/$VERSION/linux.iso" \
  --header-upload "Content-Type: application/x-iso9660-image" \
  --s3-chunk-size 64M --no-check-dest

# Upload ONLY the nix-wasm catalogs (pkgs.nix + paths.nix) — the `nix-env -iA` /
# new-CLI indexes, which are nix-wasm artifacts NOT present in Cachix. The heavy
# nars + *.narinfo + nix-cache-info are deliberately NOT uploaded: the guest
# substitutes them from Cachix through the worker's /cachix/<v> proxy
# (nix-wasm#78, which nixCacheBaseUrl points at). Same split publish-to-r2.sh
# already does. Precondition: nix-wasm CI pushed the .#wasm-binary-cache closure
# to nix-wasm.cachix.org — the nix-wasm.yml artifacts job does, on this commit;
# this publish substitutes that same closure, so it is guaranteed present.
echo "==> Uploading nix-wasm catalogs (pkgs.nix + paths.nix) → $BUCKET/linux/$VERSION/nix-cache/ …"
( cd "$CACHE" && find . -maxdepth 1 -type f \( -name pkgs.nix -o -name paths.nix \) -print0 | while IFS= read -r -d '' f; do
    REL="${f#./}"
    echo "  uploading nix-cache/$REL …"
    bunx "$WRANGLER" r2 object put "$BUCKET/linux/$VERSION/nix-cache/$REL" \
      --file "$CACHE/$REL" --content-type application/octet-stream --remote
  done )

# Capture the CURRENTLY-live version first, so the verify can report the actual
# old→new transition. Drift visibility: if this equals $VERSION, the build
# produced bytes identical to what's already published (idempotent republish) —
# which is exactly the silent failure mode that shipped a stale, pre-gtk-demo
# image (a publish raced ahead of the artifacts landing in Cachix, rebuilt the
# OLD image, and the version-only verify passed against the already-live pointer).
PREV_LIVE="$(curl -fsS "$PUBLIC_BASE_URL/packages/linux/latest.json" 2>/dev/null || true)"
PREV_VERSION="$(printf '%s' "$PREV_LIVE" | sed -n 's/.*"version":"\([0-9a-f]*\)".*/\1/p')"

echo "==> Flipping pointer → $BUCKET/linux/latest.json …"
TMP_LATEST="$(mktemp)"
trap 'rm -f "$TMP_LATEST"' EXIT
printf '%s' "$LATEST_JSON" > "$TMP_LATEST"
bunx "$WRANGLER" r2 object put "$BUCKET/linux/latest.json" \
  --file "$TMP_LATEST" --content-type application/json --remote

# Verify the flip actually landed (latest.json is served no-cache). Belt-and-
# suspenders against a silent wrangler no-op: re-fetch the live pointer and assert
# it carries the FULL new pointer — BOTH the version AND the nixCacheBaseUrl we
# wrote, not just the version substring. The version-only check passed spuriously
# when a no-op flip left the OLD pointer live and that pointer already happened to
# carry $VERSION (the stale-image race). Requiring nixCacheBaseUrl too means a
# flip that didn't actually rewrite the object fails the job: an old R2-base
# pointer (or any other version) no longer satisfies the new /cachix-base assert.
echo "==> Verifying latest.json went live (version + nixCacheBaseUrl) …"
for attempt in 1 2 3 4 5; do
  LIVE="$(curl -fsS "$PUBLIC_BASE_URL/packages/linux/latest.json" 2>/dev/null || true)"
  ok=1
  [ -n "$LIVE" ] || ok=0
  case "$LIVE" in *"\"version\":\"$VERSION\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"nixCacheBaseUrl\":\"$NIX_CACHE_URL\""*) ;; *) ok=0 ;; esac
  if [ "$ok" = 1 ]; then
    echo "    verified: latest.json → version $VERSION"
    echo "    nixCacheBaseUrl       → $NIX_CACHE_URL"
    break
  fi
  if [ "$attempt" = 5 ]; then
    echo "ERROR: latest.json did not fully update after the flip." >&2
    echo "  expected version       : $VERSION" >&2
    echo "  expected nixCacheBaseUrl: $NIX_CACHE_URL" >&2
    echo "  live latest.json was   : $LIVE" >&2
    exit 1
  fi
  sleep 3
done

# Drift visibility: report the old→new transition. Identical version means we
# republished byte-identical bytes — fine for a deliberate re-flip, but a red flag
# if you EXPECTED a guest change to ship (the stale-image race looked exactly like
# this). Loud, non-fatal (the script can't know intent).
if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" = "$VERSION" ]; then
  echo "==> NOTICE: version UNCHANGED from the previously-live pointer ($VERSION)."
  echo "    The built image is byte-identical to what was already published. If you"
  echo "    expected a guest change to ship, the build resolved a STALE artifact —"
  echo "    confirm the artifacts are in Cachix and re-run (a republish of identical"
  echo "    bytes is otherwise a no-op)."
else
  echo "==> version changed: ${PREV_VERSION:-<none>} → $VERSION"
fi

echo ""
echo "==> PUBLISHED linux channel: version=$VERSION minEngine=$MIN_ENGINE"
echo "==> image: $IMG_URL"
echo "==> pc will resolve it on the next Linux-app open (latest.json is no-cache)."
