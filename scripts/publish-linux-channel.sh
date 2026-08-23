#!/usr/bin/env bash
# publish-linux-channel.sh — republish the versioned `linux` guest channel that
# pc resolves at runtime (`js/packages/linux-channel.js` → `packages/linux/latest.json`).
#
# This is the channel republish from `vendor/linux-wasm/SOURCE.md` §"Republish the
# guest", automated: build the MMU and NOMMU boot bundles plus the shared
# toolchain cache, upload them under immutable content hashes, then flip the
# `latest.json` pointer. A guest change reaches the live site with NO pc deploy —
# pc fetches latest.json (served no-cache) on the next Linux-app open.
#
# R2 layout — the DEDICATED `pc-packages` bucket (pc#416), served by
# infra/preview-worker with CORP+CORS. Keys are FLATTENED (no `packages/` prefix):
# the worker's `/packages/<id>/…` route drops the `/packages` segment and reads
# `<id>/…` from env.PACKAGES, so the R2 key for the linux channel is `linux/…`
# while the public URL pc fetches stays `…/packages/linux/…`.
#   linux/<mmu-v>/linux.iso    — legacy MMU squashfs image
#   linux/<nommu-v>/linux.iso  — legacy NOMMU squashfs image
#   linux/<v>/linux-installed.iso — preseeded ext2 image selected by current pc
#   linux/<v>/nix-cache/       — ONLY pkgs.nix + paths.nix (the nix-wasm `nix-env
#                                -iA` / new-CLI catalogs, NOT in Cachix). The heavy
#                                nars + *.narinfo + nix-cache-info are NOT uploaded
#                                — the guest gets them from Cachix through the
#                                worker's /cachix/<v> proxy (nix-wasm#78).
#   linux/latest.json          — the pointer pc reads (no-cache route);
#                                its nixCacheBaseUrl points at /cachix/<v>
#
# <*-v> = that linux.iso's sha256 (content-addressed → immutable, safe to cache
# forever; republishing identical bytes is idempotent, new bytes get a fresh key).
# `latest.json` retains the legacy top-level MMU fields for older yore-pc builds
# and adds `defaultVariant` + `variants.{mmu,nommu}` for dual-mode clients.
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
# PRECONDITION (nix-wasm#123): nix-wasm.yml's `artifacts` job must already have
# pushed this commit's .#linux-image + .#linux-image-nommu +
# .#wasm-binary-cache to Cachix. The
# artifact-provenance gate below asserts that in seconds and fails fast if not,
# so a publish raced against an in-flight (or cancelled) artifacts run can no
# longer quietly build and ship an image CI never vetted. ALLOW_UNPUBLISHED=true
# overrides, deliberately and loudly.
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
# The binary cache nix-wasm.yml pushes every built artifact to, and the one the
# artifact-provenance gate below queries. See CLAUDE.md §Caching.
CACHIX_URL="${CACHIX_URL:-https://nix-wasm.cachix.org}"
# Escape hatch for the gate (workflow input `allow_unpublished`). Only for a
# DELIBERATE publish of artifacts CI has not built — see the gate's own header.
ALLOW_UNPUBLISHED="${ALLOW_UNPUBLISHED:-false}"
# The dedicated disc-packages bucket (pc#416). The linux channel image + pointer
# live here, NOT in pc-previews (which now only holds the site preview overlay).
BUCKET="${PACKAGES_BUCKET:-pc-packages}"
# Public origin the worker serves R2 under (used to build the absolute URLs pc fetches).
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://pc-previews.eric-c6b.workers.dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# 1. Build the channel image + toolchain cache
# ---------------------------------------------------------------------------
# ---- PREFLIGHT (before the ~1 hour build) ---------------------------------
# Everything the upload needs is checked HERE, not after the build. Both of the
# failures that cost a full build cycle in this epic were discoverable in
# milliseconds: the workflow not passing R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY,
# and rclone simply not being installed on the runner ("rclone: command not
# found", exit 127) -- each surfaced only at the upload step, an hour in.
# Runs in DRY_RUN too: validating the release environment is precisely what a
# dry run is for.
echo "==> preflight (tools + credentials) …"
command -v rclone >/dev/null || {
  echo "ERROR: rclone is not installed. linux.iso is uploaded with rclone" >&2
  echo "       (it outgrew wrangler's 300 MiB single-file cap). In CI add:" >&2
  echo "         - run: curl -fsSL https://rclone.org/install.sh | sudo bash" >&2
  exit 1
}
_wr="$(bunx "$WRANGLER" --version 2>&1)" || {
  echo "ERROR: $WRANGLER failed to run:" >&2; echo "$_wr" >&2; exit 1; }
: "${CLOUDFLARE_API_TOKEN:?wrangler needs CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?needed for the R2 S3 endpoint and wrangler}"
echo "    rclone   $(rclone version 2>/dev/null | head -1)"
echo "    wrangler $_wr"
echo "    credentials present"

# ---- ARTIFACT-PROVENANCE GATE (nix-wasm#123) ------------------------------
# The publish must ship the artifacts nix-wasm.yml BUILT AND PUSHED for this
# exact source -- never bytes this runner made up on its own.
#
# The hazard is real and recurring, not hypothetical. nix-wasm.yml's `artifacts`
# job pushes .#linux-image + .#wasm-binary-cache to Cachix, but it takes tens of
# minutes AND its concurrency group cancels it when a newer master commit lands.
# So at any given moment "the artifacts for HEAD are in Cachix" is simply not
# guaranteed. Dispatch a publish inside that window and `nix build` silently
# falls back to BUILDING locally: an hour+ on this runner, and it ships an image
# no CI job ever built or boot-smoked. That is the #121 incident, and it is
# still visible in the run history -- the publish at ef7e64dc (2026-08-14
# 20:53) was dispatched 6 min after its nix-wasm.yml started, that run was
# CANCELLED, and the publish built `wasm-binary-cache` itself, pushed it, and
# went green.
#
# So: evaluate the store paths (pure eval, no build, seconds) and assert both are
# already in the cache. Missing -> fail HERE, in seconds, with the remedy --
# instead of an hour into a build whose output nobody vetted. The build below
# then runs --max-jobs 0 (substitute-only), which turns any residual gap between
# this check and the build into an immediate hard failure rather than a silent
# local rebuild. Runs in DRY_RUN too: `dry_run: true` is exactly how you check
# whether a real publish would be safe right now.
#
# SCOPE, stated honestly: this proves the artifacts were BUILT BY CI, not that
# HEAD is the newest master. A publish from a genuinely STALE checkout finds its
# (older, CI-built) paths present and passes -- so the version-unchanged NOTICE
# after the flip remains the guard for that axis. Closing it properly means
# chaining the publish off a successful nix-wasm.yml run (#123 option 2).
echo "==> artifact-provenance gate ($CACHIX_URL) …"
echo "    commit: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo '<not a git checkout>')"
# Reachability first, so "cache says absent" and "cache unreachable" can never be
# reported as the same thing (they have completely different remedies).
if ! curl -fsS -o /dev/null --max-time 30 --retry 3 --retry-delay 2 "$CACHIX_URL/nix-cache-info"; then
  echo "ERROR: cannot reach the binary cache $CACHIX_URL." >&2
  echo "       This is a network/cache-availability problem, NOT a missing artifact." >&2
  exit 1
fi

# Probe ONE store path against the cache; sets CACHE_STATUS to present|absent.
# Called directly, never inside $(...) — an `exit` in a command substitution only
# kills the subshell, which would let an unanswered probe sail on as "".
CACHE_STATUS=""
_cache_probe() { # $1 = /nix/store/<hash>-name, $2 = label for messages
  # /nix/store/<32-char nixbase32 hash>-<name> → the narinfo key is the hash.
  local _base="${1#/nix/store/}"
  local _hash="${_base%%-*}"
  # No -f: a 404 is a real ANSWER (absent), not a transport failure, so let curl
  # exit 0 and branch on the status code.
  local _code
  _code=$(curl -sS -o /dev/null -w '%{http_code}' -I --max-time 30 --retry 3 --retry-delay 2 \
    "$CACHIX_URL/$_hash.narinfo" 2>/dev/null || true)
  case "$_code" in
    200) CACHE_STATUS=present ;;
    404) CACHE_STATUS=absent ;;
    "")
      echo "ERROR: the request for $CACHIX_URL/$_hash.narinfo ($2) failed outright" >&2
      echo "       (no HTTP status after retries). Transport problem, not a missing artifact." >&2
      exit 1
      ;;
    *)
      echo "ERROR: unexpected HTTP $_code for $CACHIX_URL/$_hash.narinfo ($2)." >&2
      echo "       Neither present nor absent — refusing to guess. Re-run once the cache is healthy." >&2
      exit 1
      ;;
  esac
}

# --max-jobs 0 unless the gate is explicitly overridden (see below).
NIX_BUILD_MODE="--max-jobs 0"
GATE_MISSING=""
for _attr in \
  linux-image linux-image-nommu \
  linux-installed-image linux-installed-image-nommu \
  wasm-binary-cache; do
  # Pure evaluation: `.outPath` needs no build, so a missing artifact costs
  # seconds here rather than an hour of `nix build`.
  # shellcheck disable=SC2086
  _path=$(eval "$NIX eval --raw '.#$_attr.outPath'") || {
    echo "ERROR: could not evaluate .#$_attr — the flake does not evaluate here." >&2
    exit 1
  }
  _cache_probe "$_path" ".#$_attr"
  if [ "$CACHE_STATUS" = present ]; then
    echo "    PRESENT  .#$_attr → $_path"
  else
    echo "    MISSING  .#$_attr → $_path"
    GATE_MISSING="$GATE_MISSING
  .#$_attr → $_path"
  fi
done

# ---- the toolchain .drv closures --------------------------------------------
# The two outputs above are the BOOT bytes; they are not the whole channel. A
# complete channel also needs the wasm-tools .drv closures on Cachix, because
# in-guest `nix-env -iA wasm-tools.<tool>` substitutes the DERIVER first and
# cachix-action's post-build-hook pushes only built OUTPUTS — so nix-wasm.yml
# pushes them in a SEPARATE, LATER step of the artifacts job. Probing only the
# outputs therefore cannot see whether that step ran, finished, or failed: both
# outputs can read 200 while the drv push is still in flight, and the channel
# would go live with a cache where toolchain installs fail (boot fine, `nix-env
# -iA wasm-tools.guest-cc` broken). Read the drv list from
# .#wasm-cache-drv-roots — the SAME file that CI's push step reads, so the two
# can never drift — and probe every entry.
#
# NOT built with $NIX_BUILD_MODE: it is a trivial writeText whose realisation
# only INSTANTIATES the toolchain derivations (writing .drv files locally), it
# does not build them, so --max-jobs 0 would wrongly refuse it.
#
# REQUIRE_DRV_ROOTS mirrors that CI step's own `if: github.ref ==
# refs/heads/master` condition: off master CI deliberately never pushes them
# ("only the channel the live guest boots from needs a complete cache"), so
# requiring them there would make every branch publish unsatisfiable. Default
# true — the live-channel flow is the one that must be safe by default.
REQUIRE_DRV_ROOTS="${REQUIRE_DRV_ROOTS:-true}"
# shellcheck disable=SC2086
_drv_roots=$(eval "$NIX build .#wasm-cache-drv-roots --no-link --print-out-paths") || {
  echo "ERROR: could not build .#wasm-cache-drv-roots (the toolchain .drv list)." >&2
  exit 1
}
_drv_missing=""
while IFS= read -r _drv; do
  [ -n "$_drv" ] || continue
  _cache_probe "$_drv" "drv $_drv"
  if [ "$CACHE_STATUS" = present ]; then
    echo "    PRESENT  drv → $_drv"
  else
    echo "    MISSING  drv → $_drv"
    _drv_missing="$_drv_missing
  drv → $_drv"
  fi
done < "$_drv_roots"

if [ -n "$_drv_missing" ]; then
  if [ "$REQUIRE_DRV_ROOTS" = "true" ]; then
    GATE_MISSING="$GATE_MISSING$_drv_missing"
  else
    echo ""
    echo "==> NOTICE: toolchain .drv closures are not in $CACHIX_URL, and"
    echo "    REQUIRE_DRV_ROOTS=false (CI pushes them on master only). The published"
    echo "    channel will BOOT, but in-guest \`nix-env -iA wasm-tools.<tool>\` will not"
    echo "    resolve against it. Expected for a branch publish; wrong for a live flip."
    echo "    Missing:$_drv_missing"
    echo ""
  fi
fi

if [ -n "$GATE_MISSING" ]; then
  if [ "$ALLOW_UNPUBLISHED" = "true" ]; then
    echo ""
    echo "==> WARNING: artifacts are NOT in $CACHIX_URL, and ALLOW_UNPUBLISHED=true."
    echo "    This runner will BUILD them itself (expect hours) and publish bytes that"
    echo "    no CI job built or boot-smoked. Proceeding because you asked for it."
    echo "    Missing:$GATE_MISSING"
    echo ""
    NIX_BUILD_MODE=""
  else
    echo "" >&2
    echo "ERROR: this checkout's artifacts are not published yet — refusing to build them here." >&2
    echo "" >&2
    echo "  missing:$GATE_MISSING" >&2
    echo "" >&2
    echo "  Building them on this runner would take hours and would ship an image no CI" >&2
    echo "  job ever built or boot-smoked (nix-wasm#121 / #123)." >&2
    echo "" >&2
    echo "  FIX: let nix-wasm.yml's \`artifacts\` job COMPLETE on this exact commit — its" >&2
    echo "       build step publishes the two outputs and its LAST step pushes the" >&2
    echo "       toolchain .drv closures — then re-run this publish. If that run was" >&2
    echo "       cancelled (a newer master push cancels it) or skipped, re-run it first." >&2
    echo "       A run still in flight can already satisfy the outputs while the .drv" >&2
    echo "       push is pending; that is why the .drv roots are checked too." >&2
    echo "" >&2
    echo "  OVERRIDE (deliberate publish of un-CI'd artifacts): ALLOW_UNPUBLISHED=true," >&2
    echo "       or the workflow's \`allow_unpublished\` input." >&2
    exit 1
  fi
fi

echo "==> Building .#linux-image (MMU) …"
# --max-jobs 0 (unless overridden above): substitute-only. The gate just proved
# all outputs are in the cache, so nothing legitimately needs building — and if
# anything does, that means the premise changed under us and a hard failure is
# the correct outcome, not an unvetted local rebuild.
# shellcheck disable=SC2086
IMG_STORE_MMU=$(eval "$NIX build .#linux-image $NIX_BUILD_MODE --print-out-paths --no-link")
# make-iso9660-image emits the iso under $out/iso/; locate it robustly.
ISO_MMU=$(find "$IMG_STORE_MMU" -name linux.iso -type f | head -1)
[ -n "$ISO_MMU" ] && [ -f "$ISO_MMU" ] || {
  echo "ERROR: MMU linux.iso not found under $IMG_STORE_MMU" >&2; exit 1;
}

echo "==> Building .#linux-image-nommu …"
# shellcheck disable=SC2086
IMG_STORE_NOMMU=$(eval "$NIX build .#linux-image-nommu $NIX_BUILD_MODE --print-out-paths --no-link")
ISO_NOMMU=$(find "$IMG_STORE_NOMMU" -name linux.iso -type f | head -1)
[ -n "$ISO_NOMMU" ] && [ -f "$ISO_NOMMU" ] || {
  echo "ERROR: NOMMU linux.iso not found under $IMG_STORE_NOMMU" >&2; exit 1;
}

echo "==> Building .#linux-installed-image (MMU) …"
# shellcheck disable=SC2086
INST_STORE_MMU=$(eval "$NIX build .#linux-installed-image $NIX_BUILD_MODE --print-out-paths --no-link")
INST_ISO_MMU=$(find "$INST_STORE_MMU" -name linux.iso -type f | head -1)
[ -n "$INST_ISO_MMU" ] && [ -f "$INST_ISO_MMU" ] || {
  echo "ERROR: MMU preseeded linux.iso not found under $INST_STORE_MMU" >&2; exit 1;
}

echo "==> Building .#linux-installed-image-nommu …"
# shellcheck disable=SC2086
INST_STORE_NOMMU=$(eval "$NIX build .#linux-installed-image-nommu $NIX_BUILD_MODE --print-out-paths --no-link")
INST_ISO_NOMMU=$(find "$INST_STORE_NOMMU" -name linux.iso -type f | head -1)
[ -n "$INST_ISO_NOMMU" ] && [ -f "$INST_ISO_NOMMU" ] || {
  echo "ERROR: NOMMU preseeded linux.iso not found under $INST_STORE_NOMMU" >&2; exit 1;
}

echo "==> Building .#wasm-binary-cache …"
# shellcheck disable=SC2086
CACHE=$(eval "$NIX build .#wasm-binary-cache $NIX_BUILD_MODE --print-out-paths --no-link")

# ---------------------------------------------------------------------------
# 2. Versions (= per-image content hashes) + minEngine (from runtime/abi.js)
# ---------------------------------------------------------------------------
SHA_MMU=$(sha256sum "$ISO_MMU" | cut -d' ' -f1)
BYTES_MMU=$(stat -c%s "$ISO_MMU")
VERSION="$SHA_MMU"
SHA_NOMMU=$(sha256sum "$ISO_NOMMU" | cut -d' ' -f1)
BYTES_NOMMU=$(stat -c%s "$ISO_NOMMU")
VERSION_NOMMU="$SHA_NOMMU"
INST_SHA_MMU=$(sha256sum "$INST_ISO_MMU" | cut -d' ' -f1)
INST_BYTES_MMU=$(stat -c%s "$INST_ISO_MMU")
INST_VERSION_MMU="$INST_SHA_MMU"
INST_SHA_NOMMU=$(sha256sum "$INST_ISO_NOMMU" | cut -d' ' -f1)
INST_BYTES_NOMMU=$(stat -c%s "$INST_ISO_NOMMU")
INST_VERSION_NOMMU="$INST_SHA_NOMMU"

# Parse the ACTUAL `export const ENGINE_ABI = N;` line (not the comment lines that
# also mention ENGINE_ABI) — matches linux-image.nix's parse exactly.
MIN_ENGINE=$(grep -oE '^[[:space:]]*export const ENGINE_ABI = [0-9]+;' "$ROOT/runtime/abi.js" \
  | grep -oE '[0-9]+' | head -1)
[ -n "$MIN_ENGINE" ] || { echo "ERROR: could not parse ENGINE_ABI from runtime/abi.js" >&2; exit 1; }

IMG_URL_MMU="$PUBLIC_BASE_URL/packages/linux/$VERSION/linux.iso"
IMG_URL_NOMMU="$PUBLIC_BASE_URL/packages/linux/$VERSION_NOMMU/linux.iso"
INST_URL_MMU="$PUBLIC_BASE_URL/packages/linux/$INST_VERSION_MMU/linux-installed.iso"
INST_URL_NOMMU="$PUBLIC_BASE_URL/packages/linux/$INST_VERSION_NOMMU/linux-installed.iso"
# The guest's nix-cache.js uses ONE baseUrl for nix-cache-info / *.narinfo / nar/*
# AND pkgs.nix / paths.nix. The worker's /cachix/<v> route unifies them: catalogs
# from R2 (packages/linux/<v>/nix-cache/), everything else proxied from
# nix-wasm.cachix.org (nix-wasm#78). Point at it, NOT the raw R2 nix-cache path.
NIX_CACHE_URL="$PUBLIC_BASE_URL/cachix/$VERSION"

# latest.json keeps the original top-level MMU pointer byte-for-field compatible
# with old yore-pc builds, then adds an explicit dual-mode map for new clients.
# Both modes use the same catalog/Cachix endpoint; the ISO bytes themselves are
# independently content-addressed.
LATEST_JSON=$(python3 - \
  "$VERSION" "$MIN_ENGINE" "$NIX_CACHE_URL" "$IMG_URL_MMU" "$BYTES_MMU" "$SHA_MMU" \
  "$VERSION_NOMMU" "$IMG_URL_NOMMU" "$BYTES_NOMMU" "$SHA_NOMMU" \
  "$INST_VERSION_MMU" "$INST_URL_MMU" "$INST_BYTES_MMU" "$INST_SHA_MMU" \
  "$INST_VERSION_NOMMU" "$INST_URL_NOMMU" "$INST_BYTES_NOMMU" "$INST_SHA_NOMMU" <<'PY'
import json
import sys

(
    mmu_version,
    min_engine,
    cache_url,
    mmu_url,
    mmu_bytes,
    mmu_sha,
    nommu_version,
    nommu_url,
    nommu_bytes,
    nommu_sha,
    installed_mmu_version,
    installed_mmu_url,
    installed_mmu_bytes,
    installed_mmu_sha,
    installed_nommu_version,
    installed_nommu_url,
    installed_nommu_bytes,
    installed_nommu_sha,
) = sys.argv[1:]

def variant(version, url, size, sha):
    return {
        "version": version,
        "minEngine": int(min_engine),
        "nixCacheBaseUrl": cache_url,
        "image": {"url": url, "bytes": int(size), "sha256": sha},
    }

mmu = variant(mmu_version, mmu_url, mmu_bytes, mmu_sha)
nommu = variant(nommu_version, nommu_url, nommu_bytes, nommu_sha)
installed_mmu = variant(installed_mmu_version, installed_mmu_url,
                        installed_mmu_bytes, installed_mmu_sha)
installed_nommu = variant(installed_nommu_version, installed_nommu_url,
                          installed_nommu_bytes, installed_nommu_sha)
pointer = {
    "schemaVersion": 3,
    "defaultVariant": "mmu",
    **mmu,
    "variants": {"mmu": mmu, "nommu": nommu},
    "installedVariants": {"mmu": installed_mmu, "nommu": installed_nommu},
}
print(json.dumps(pointer, separators=(",", ":")))
PY
)

echo ""
echo "MMU linux.iso path    : $ISO_MMU"
echo "MMU bytes / sha256    : $BYTES_MMU / $SHA_MMU"
echo "NOMMU linux.iso path  : $ISO_NOMMU"
echo "NOMMU bytes / sha256  : $BYTES_NOMMU / $SHA_NOMMU"
echo "MMU preseeded image   : $INST_ISO_MMU"
echo "MMU preseed bytes/sha : $INST_BYTES_MMU / $INST_SHA_MMU"
echo "NOMMU preseeded image : $INST_ISO_NOMMU"
echo "NOMMU preseed bytes/sha: $INST_BYTES_NOMMU / $INST_SHA_NOMMU"
echo "default version <v>   : $VERSION"
echo "minEngine            : $MIN_ENGINE"
echo "nix-cache path       : $CACHE"
echo "latest.json          : $LATEST_JSON"
echo ""

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## linux channel republished"
    echo "| field | value |"
    echo "|-------|-------|"
    echo "| default mode | \`mmu\` |"
    echo "| MMU version | \`$VERSION\` |"
    echo "| NOMMU version | \`$VERSION_NOMMU\` |"
    echo "| minEngine | \`$MIN_ENGINE\` |"
    echo "| MMU bytes | \`$BYTES_MMU\` |"
    echo "| NOMMU bytes | \`$BYTES_NOMMU\` |"
    echo "| MMU image | \`$IMG_URL_MMU\` |"
    echo "| NOMMU image | \`$IMG_URL_NOMMU\` |"
    echo "| MMU preseeded image | \`$INST_URL_MMU\` |"
    echo "| NOMMU preseeded image | \`$INST_URL_NOMMU\` |"
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
  echo "  # rclone (not wrangler): the images exceed wrangler's 300 MiB hard cap"
  echo "  rclone copyto \"$ISO_MMU\" \"r2:$BUCKET/linux/$VERSION/linux.iso\" \\"
  echo "    --header-upload \"Content-Type: application/x-iso9660-image\" \\"
  echo "    --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest"
  echo "  rclone copyto \"$ISO_NOMMU\" \"r2:$BUCKET/linux/$VERSION_NOMMU/linux.iso\" \\"
  echo "    --header-upload \"Content-Type: application/x-iso9660-image\" \\"
  echo "    --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest"
  echo "  rclone copyto \"$INST_ISO_MMU\" \"r2:$BUCKET/linux/$INST_VERSION_MMU/linux-installed.iso\" \\"
  echo "    --header-upload \"Content-Type: application/x-iso9660-image\" \\"
  echo "    --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest"
  echo "  rclone copyto \"$INST_ISO_NOMMU\" \"r2:$BUCKET/linux/$INST_VERSION_NOMMU/linux-installed.iso\" \\"
  echo "    --header-upload \"Content-Type: application/x-iso9660-image\" \\"
  echo "    --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest"
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
  echo "==> mmu=$VERSION nommu=$VERSION_NOMMU minEngine=$MIN_ENGINE"
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

echo "==> Uploading MMU linux.iso → $BUCKET/linux/$VERSION/linux.iso …"
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
# WHICH credential can write $BUCKET is the crux here, and it is not obvious.
# Everything this script writes to pc-packages had always gone through wrangler
# + CLOUDFLARE_API_TOKEN; master publishes fine because master's linux.iso is
# under wrangler's 300 MiB cap. Moving the ISO to rclone introduced a NEW
# requirement -- S3 credentials with write access to pc-packages -- that nobody
# had ever needed. This repo's R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY belong to
# nix-wasm-previews (pr-preview.yml's own sync), so against pc-packages they
# 403: first on the bucket check (CreateBucket), then on CreateMultipartUpload.
#
# So prefer credentials that are actually scoped to the PACKAGES bucket, and
# otherwise derive S3 creds from CLOUDFLARE_API_TOKEN -- the credential that
# demonstrably can write this bucket, since wrangler uses it for the catalogs
# and the pointer. R2's documented derivation (same one pc's
# scripts/screenshot-upload.sh uses): access key id = the token's ID, secret
# access key = SHA-256 hex of the token value.
: "${CLOUDFLARE_ACCOUNT_ID:?rclone needs CLOUDFLARE_ACCOUNT_ID for the S3 endpoint}"
if [ -n "${R2_PACKAGES_ACCESS_KEY_ID:-}" ] && [ -n "${R2_PACKAGES_SECRET_ACCESS_KEY:-}" ]; then
  echo "    S3 creds: R2_PACKAGES_* (explicitly scoped to $BUCKET)"
  _s3_id="$R2_PACKAGES_ACCESS_KEY_ID"; _s3_secret="$R2_PACKAGES_SECRET_ACCESS_KEY"
else
  echo "    S3 creds: derived from CLOUDFLARE_API_TOKEN (R2 documented derivation)"
  _tok_id="$(curl -fsS -m 30 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",{}).get("id",""))' 2>/dev/null || true)"
  if [ -z "$_tok_id" ]; then
    echo "ERROR: could not resolve the CLOUDFLARE_API_TOKEN id from /user/tokens/verify," >&2
    echo "       so S3 credentials for $BUCKET cannot be derived." >&2
    echo "       Fix: mint an R2 API token with Object Read & Write on $BUCKET and set" >&2
    echo "       R2_PACKAGES_ACCESS_KEY_ID / R2_PACKAGES_SECRET_ACCESS_KEY as repo secrets." >&2
    echo "       (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are scoped to the PREVIEW bucket" >&2
    echo "        and cannot write $BUCKET -- that is what the 403s were.)" >&2
    exit 1
  fi
  _s3_id="$_tok_id"
  _s3_secret="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | sha256sum | cut -d' ' -f1)"
fi
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$_s3_id"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$_s3_secret"
export RCLONE_CONFIG_R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
# --s3-no-check-bucket AND --no-check-dest are BOTH required, and they cover
# DIFFERENT probes; either one alone still 403s on a bucket-scoped R2 token:
#   --s3-no-check-bucket : skip the bucket check, which rclone escalates to
#                          CreateBucket -> "operation error S3: CreateBucket,
#                          StatusCode: 403, AccessDenied" (the token may write
#                          objects in one bucket, not create buckets).
#   --no-check-dest      : skip the destination HeadObject. R2 returns 403, not
#                          404, for a HEAD on a MISSING key when the token
#                          cannot list the bucket -- so the first upload of any
#                          new version would fail. Skipping it is right anyway:
#                          the key is immutable and content-addressed.
rclone copyto "$ISO_MMU" "r2:$BUCKET/linux/$VERSION/linux.iso" \
  --header-upload "Content-Type: application/x-iso9660-image" \
  --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest

echo "==> Uploading NOMMU linux.iso → $BUCKET/linux/$VERSION_NOMMU/linux.iso …"
rclone copyto "$ISO_NOMMU" "r2:$BUCKET/linux/$VERSION_NOMMU/linux.iso" \
  --header-upload "Content-Type: application/x-iso9660-image" \
  --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest

echo "==> Uploading MMU preseeded image → $BUCKET/linux/$INST_VERSION_MMU/linux-installed.iso …"
rclone copyto "$INST_ISO_MMU" "r2:$BUCKET/linux/$INST_VERSION_MMU/linux-installed.iso" \
  --header-upload "Content-Type: application/x-iso9660-image" \
  --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest

echo "==> Uploading NOMMU preseeded image → $BUCKET/linux/$INST_VERSION_NOMMU/linux-installed.iso …"
rclone copyto "$INST_ISO_NOMMU" "r2:$BUCKET/linux/$INST_VERSION_NOMMU/linux-installed.iso" \
  --header-upload "Content-Type: application/x-iso9660-image" \
  --s3-chunk-size 64M --s3-no-check-bucket --no-check-dest

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
PREV_VERSION=$(python3 - "$PREV_LIVE" <<'PY'
import json
import sys

try:
    print(json.loads(sys.argv[1]).get("version", ""))
except (IndexError, json.JSONDecodeError, TypeError):
    print("")
PY
)

echo "==> Flipping pointer → $BUCKET/linux/latest.json …"
TMP_LATEST="$(mktemp)"
trap 'rm -f "$TMP_LATEST"' EXIT
printf '%s' "$LATEST_JSON" > "$TMP_LATEST"
bunx "$WRANGLER" r2 object put "$BUCKET/linux/latest.json" \
  --file "$TMP_LATEST" --content-type application/json --remote

# Verify the flip actually landed (latest.json is served no-cache). Belt-and-
# suspenders against a silent wrangler no-op: re-fetch the live pointer and assert
# it carries the FULL new pointer — both mode versions, the default-mode marker,
# and the shared nixCacheBaseUrl we wrote, not just one version substring. The
# version-only check passed spuriously
# when a no-op flip left the OLD pointer live and that pointer already happened to
# carry $VERSION (the stale-image race). Requiring nixCacheBaseUrl too means a
# flip that didn't actually rewrite the object fails the job: an old R2-base
# pointer (or any other version) no longer satisfies the new /cachix-base assert.
echo "==> Verifying latest.json went live (MMU + NOMMU + nixCacheBaseUrl) …"
for attempt in 1 2 3 4 5; do
  LIVE="$(curl -fsS "$PUBLIC_BASE_URL/packages/linux/latest.json" 2>/dev/null || true)"
  ok=1
  [ -n "$LIVE" ] || ok=0
  case "$LIVE" in *"\"version\":\"$VERSION\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"defaultVariant\":\"mmu\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"nommu\":{\"version\":\"$VERSION_NOMMU\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"url\":\"$IMG_URL_NOMMU\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"mmu\":{\"version\":\"$INST_VERSION_MMU\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"url\":\"$INST_URL_MMU\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"nommu\":{\"version\":\"$INST_VERSION_NOMMU\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"url\":\"$INST_URL_NOMMU\""*) ;; *) ok=0 ;; esac
  case "$LIVE" in *"\"nixCacheBaseUrl\":\"$NIX_CACHE_URL\""*) ;; *) ok=0 ;; esac
  if [ "$ok" = 1 ]; then
    echo "    verified: MMU version   → $VERSION"
    echo "              NOMMU version → $VERSION_NOMMU"
    echo "              MMU baseline  → $INST_VERSION_MMU"
    echo "              NOMMU baseline→ $INST_VERSION_NOMMU"
    echo "              nix cache     → $NIX_CACHE_URL"
    break
  fi
  if [ "$attempt" = 5 ]; then
    echo "ERROR: latest.json did not fully update after the flip." >&2
    echo "  expected MMU version   : $VERSION" >&2
    echo "  expected NOMMU version : $VERSION_NOMMU" >&2
    echo "  expected MMU baseline   : $INST_VERSION_MMU" >&2
    echo "  expected NOMMU baseline : $INST_VERSION_NOMMU" >&2
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
echo "==> PUBLISHED dual-mode linux channel: mmu=$VERSION nommu=$VERSION_NOMMU minEngine=$MIN_ENGINE"
echo "==> MMU image: $IMG_URL_MMU"
echo "==> NOMMU image: $IMG_URL_NOMMU"
echo "==> MMU preseeded image: $INST_URL_MMU"
echo "==> NOMMU preseeded image: $INST_URL_NOMMU"
echo "==> pc will resolve it on the next Linux-app open (latest.json is no-cache)."
