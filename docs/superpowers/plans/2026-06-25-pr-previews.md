# PR Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open/push a PR → a commented live URL → click → the `runtime/demo/web` demo boots *this PR's* freshly-built guest in the browser.

**Architecture:** A new `nix-wasm-previews` R2 bucket holds the PR's frontend (`pr-<N>/…`, rclone-synced) and content-addressed boot artifacts (`cas/<buildhash>/…`). A self-contained Cloudflare Worker (`infra/preview-worker/`) serves both with COOP/COEP/CORP. A `pull_request_target` workflow builds the 3 boot artifacts (substituting the toolchain from the Cachix cache #2 shipped), uploads them, syncs the frontend, and comments the link. One runtime change makes the demo page read a per-PR `preview.json` to locate its artifacts.

**Tech Stack:** Cloudflare Workers + R2, `wrangler`, `rclone` (S3→R2), GitHub Actions (`pull_request_target`), Nix + Cachix, `node:test`, bash.

**Spec:** `docs/superpowers/specs/2026-06-25-pr-previews-design.md`

## Global Constraints

- Boot artifacts only: `vmlinux.wasm`, `initramfs.cpio.gz`, `base.squashfs`. **Never** the guest `nix-cache/` (that is issue #2's substituter, out of scope).
- Artifact store-path layout (exact): `.#kernel`→`$out/vmlinux.wasm`, `.#wasm-initramfs`→`$out/initramfs.cpio.gz`, `.#wasm-base-squashfs`→`$out/base.squashfs`.
- Bucket name: `nix-wasm-previews`. Worker name: `nix-wasm-previews`. R2 binding: `PREVIEWS`.
- Cache backend already shipped by #2: Cachix `nix-wasm` (`nix-wasm.cachix.org`). CI wiring: `cachix/install-nix-action@v27` + `cachix/cachix-action@v15` (name `nix-wasm`), nix pin `nixpkgs=channel:nixos-26.05`, `experimental-features = nix-command flakes`.
- CI runner for substitution-only/non-Nix jobs: `runs-on: namespace-profile-default` (private repo; stays off GitHub-hosted minutes). NOT `ubuntu-latest`.
- Every Worker response carries `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin`.
- PR-comment marker string: `<!-- nix-wasm-preview -->`.
- Secrets: reuse `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CACHIX_AUTH_TOKEN`; add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; repo variable `PREVIEW_BASE_URL`.
- New Worker JS must stay clean (it is not wired into a CI gate; `oxlint`/`oxfmt` are knowingly red per `runtime-gates.yml`).
- Pin all GitHub Actions to a version tag (repo convention).

## File Structure

- `infra/preview-worker/src/index.js` — the Worker (route + serve + isolation headers). One responsibility: turn an R2 key request into an isolated HTTP response.
- `infra/preview-worker/src/index.test.js` — `node:test` unit tests with a fake R2 binding.
- `infra/preview-worker/wrangler.toml` — Worker config + R2 binding.
- `infra/preview-worker/package.json` — `wrangler` devDep + `deploy`/`dev`/`test` scripts.
- `infra/preview-worker/README.md` — provisioning runbook.
- `scripts/preview-publish.sh` — build + hash + upload + sync (the workflow's worker).
- `.github/workflows/deploy-preview-worker.yml` — deploy the Worker on master.
- `.github/workflows/pr-preview.yml` — per-PR deploy + teardown.
- `runtime/demo/web/main.js` — read optional `preview.json` for the artifacts base.

---

### Task 1: Preview Worker

**Files:**
- Create: `infra/preview-worker/src/index.js`
- Create: `infra/preview-worker/src/index.test.js`
- Create: `infra/preview-worker/wrangler.toml`
- Create: `infra/preview-worker/package.json`

**Interfaces:**
- Produces: a default-export module `{ async fetch(request, env) }` where `env.PREVIEWS` is an R2 bucket binding exposing `get(key) → { body, httpEtag } | null`. Serves keys `pr-<N>/<path>` and `cas/<hash>/<path>`.

- [ ] **Step 1: Write the failing test**

Create `infra/preview-worker/src/index.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

// A fake R2 bucket: keys → string bodies. get() returns an R2-object-like value.
function fakeEnv(objects) {
  return {
    PREVIEWS: {
      async get(key) {
        if (!(key in objects)) return null;
        return { body: objects[key], httpEtag: `"etag-${key}"` };
      },
    },
  };
}

const call = (env, path) =>
  worker.fetch(new Request(`https://preview.example${path}`), env);

test("stamps cross-origin-isolation headers on every response", async () => {
  const res = await call(fakeEnv({}), "/");
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
});

test("serves a pr-<N> asset with content-type + short cache", async () => {
  const env = fakeEnv({ "pr-7/demo/web/main.js": "export {}" });
  const res = await call(env, "/pr-7/demo/web/main.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(await res.text(), "export {}");
});

test("serves a cas artifact as immutable octet-stream", async () => {
  const env = fakeEnv({ "cas/abc123/base.squashfs": "SQSH" });
  const res = await call(env, "/cas/abc123/base.squashfs");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("serves wasm as application/wasm", async () => {
  const env = fakeEnv({ "cas/abc123/vmlinux.wasm": "\0asm" });
  const res = await call(env, "/cas/abc123/vmlinux.wasm");
  assert.equal(res.headers.get("content-type"), "application/wasm");
});

test("directory path falls back to index.html with no-store", async () => {
  const env = fakeEnv({ "pr-7/demo/web/index.html": "<html>" });
  const res = await call(env, "/pr-7/demo/web/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("preview.json is no-store", async () => {
  const env = fakeEnv({ "pr-7/demo/web/preview.json": "{}" });
  const res = await call(env, "/pr-7/demo/web/preview.json");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("unknown layer → 404 (still isolated)", async () => {
  const res = await call(fakeEnv({}), "/secrets/x");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
});

test("missing key under a valid layer → 404", async () => {
  const res = await call(fakeEnv({}), "/pr-7/demo/web/nope.js");
  assert.equal(res.status, 404);
});

test("bare /pr-<N> redirects to /pr-<N>/", async () => {
  const res = await call(fakeEnv({}), "/pr-7");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "https://preview.example/pr-7/");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra/preview-worker && node --test src/index.test.js`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Write the Worker**

Create `infra/preview-worker/src/index.js`:

```js
// nix-wasm PR-preview Worker. Serves the nix-wasm-previews R2 bucket:
//   pr-<N>/<path>      the PR's frontend bundle (runtime/ tree, rclone-synced)
//   cas/<hash>/<path>  content-addressed boot artifacts (vmlinux.wasm,
//                      initramfs.cpio.gz, base.squashfs), shared across PRs
//
// Every response is stamped COOP/COEP/CORP so the preview is cross-origin
// isolated (the wasm kernel needs SharedArrayBuffer) — a bare R2 URL cannot do
// this. No union-mount (unlike pc): the bucket holds full objects, served
// directly. Binding: env.PREVIEWS (R2 bucket), configured in wrangler.toml.

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  gz: "application/gzip",
  // base.squashfs, *.cpio.gz payloads, etc.
  squashfs: "application/octet-stream",
};

function contentType(path) {
  const ext = path.split(".").pop().toLowerCase();
  return TYPES[ext] || "application/octet-stream";
}

function withHeaders(body, init, path, extra) {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
  if (path && !headers.has("Content-Type")) headers.set("Content-Type", contentType(path));
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/" || pathname === "") {
      return withHeaders(
        "nix-wasm PR previews are served at /pr-<number>/demo/web/\n",
        { status: 404 },
        "x.txt",
      );
    }

    const segs = pathname.replace(/^\/+/, "").split("/");
    const layer = segs[0];
    if (!/^pr-\d+$/.test(layer) && layer !== "cas") {
      return withHeaders("Not found\n", { status: 404 }, "x.txt");
    }

    // Redirect /pr-<N> → /pr-<N>/ so relative asset paths resolve.
    if (/^pr-\d+$/.test(layer) && segs.length === 1) {
      return new Response(null, {
        status: 308,
        headers: { Location: `${url.origin}/${layer}/${url.search}` },
      });
    }

    let key = segs.join("/");
    if (key.endsWith("/")) key += "index.html";

    let obj = await env.PREVIEWS.get(key);
    // Extension-less directory request → try its index.html.
    if (!obj && !key.split("/").pop().includes(".")) {
      const idx = `${key}/index.html`;
      const alt = await env.PREVIEWS.get(idx);
      if (alt) {
        obj = alt;
        key = idx;
      }
    }
    if (!obj) return withHeaders(`Not found: ${key}\n`, { status: 404 }, "x.txt");

    const cache =
      layer === "cas"
        ? "public, max-age=31536000, immutable"
        : key.endsWith(".html") || key.endsWith("preview.json")
          ? "no-store"
          : "public, max-age=300";

    return withHeaders(obj.body, { status: 200 }, key, {
      "Cache-Control": cache,
      ETag: obj.httpEtag,
    });
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd infra/preview-worker && node --test src/index.test.js`
Expected: PASS — 9 tests, 0 fail.

- [ ] **Step 5: Add wrangler.toml and package.json**

Create `infra/preview-worker/wrangler.toml`:

```toml
# nix-wasm PR-preview Worker. Deploy once with `wrangler deploy` (see README.md).
# Serves the nix-wasm-previews R2 bucket with cross-origin-isolation headers.
name = "nix-wasm-previews"
main = "src/index.js"
compatibility_date = "2026-01-01"

# workers.dev subdomain is fine; preview URL is
# https://nix-wasm-previews.<subdomain>.workers.dev/pr-<N>/demo/web/
# (Must stay above the [[r2_buckets]] table — TOML tables capture every
# top-level key that follows them.)
workers_dev = true

[[r2_buckets]]
binding = "PREVIEWS"
bucket_name = "nix-wasm-previews"
```

Create `infra/preview-worker/package.json`:

```json
{
  "name": "nix-wasm-preview-worker",
  "private": true,
  "description": "Cloudflare Worker serving nix-wasm PR previews from R2",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "tail": "wrangler tail",
    "test": "node --test src/index.test.js"
  },
  "devDependencies": {
    "wrangler": "4.42.0"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add infra/preview-worker/src/index.js infra/preview-worker/src/index.test.js \
        infra/preview-worker/wrangler.toml infra/preview-worker/package.json
git commit -m "feat(preview-worker): R2 overlay Worker with COOP/COEP for PR previews"
```

---

### Task 2: Demo page reads `preview.json`

**Files:**
- Modify: `runtime/demo/web/main.js` (the `baseUrl` assignment, currently around line 39)

**Interfaces:**
- Consumes: nothing new. `bootNixSystem({ baseUrl })` already accepts `baseUrl` (`runtime/boot-nix-system.js`).
- Produces: the page now honours `./preview.json` `{ artifactsBase }` when present; falls back to `./artifacts/` (local dev unchanged).

- [ ] **Step 1: Make the edit**

In `runtime/demo/web/main.js`, replace:

```js
  const vfs = MemVfs.from({ Home: {} });
  // Artifacts served from the same origin as this page.
  const baseUrl = new URL("./artifacts/", document.baseURI).href;
```

with:

```js
  const vfs = MemVfs.from({ Home: {} });
  // Artifacts served from the same origin as this page. A PR preview ships a
  // ./preview.json that points at its content-addressed cas/<buildhash>/ prefix;
  // local dev has no preview.json and uses the ./artifacts/ symlink.
  let baseUrl = new URL("./artifacts/", document.baseURI).href;
  try {
    const r = await fetch("./preview.json", { cache: "no-store" });
    if (r.ok) {
      const { artifactsBase } = await r.json();
      if (artifactsBase) baseUrl = new URL(artifactsBase, document.baseURI).href;
    }
  } catch {
    // no preview.json (local dev) — keep ./artifacts/
  }
```

- [ ] **Step 2: Verify the engine typecheck still passes**

`main.js` lives under `demo/web/` which is tsc-excluded, but run the engine gate to confirm nothing else broke.

Run: `cd runtime && bun run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Verify local-dev fallback by static read**

Run: `cd runtime && node -e "const s=require('fs').readFileSync('demo/web/main.js','utf8'); if(!s.includes('preview.json')||!s.includes('./artifacts/')) {console.error('FAIL: missing fallback or preview.json read'); process.exit(1)} console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add runtime/demo/web/main.js
git commit -m "feat(demo): boot artifactsBase from optional preview.json (PR previews)"
```

---

### Task 3: `scripts/preview-publish.sh`

**Files:**
- Create: `scripts/preview-publish.sh`

**Interfaces:**
- Consumes: arg `$1` = PR number. Env: `NIX_CMD` (default `nix`), `PREVIEW_BUCKET` (default `nix-wasm-previews`), `PR_COMMIT` (default `git rev-parse HEAD`), rclone `RCLONE_CONFIG_R2_*` (set by the workflow). Builds `.#kernel .#wasm-initramfs .#wasm-base-squashfs`.
- Produces: in R2 — `cas/<buildhash>/{vmlinux.wasm,initramfs.cpio.gz,base.squashfs}`, `pr-<N>/…` (synced `runtime/`), `pr-<N>/demo/web/preview.json`. Dry-runs (prints commands, exits 0) when `R2_ACCESS_KEY_ID` is unset.

- [ ] **Step 1: Write the script**

Create `scripts/preview-publish.sh`:

```bash
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
echo "==> Building .#kernel …";            KERNEL_OUT=$(eval "$NIX build .#kernel --no-link --print-out-paths")            # noqa
echo "==> Building .#wasm-initramfs …";     INITRD_OUT=$(eval "$NIX build .#wasm-initramfs --no-link --print-out-paths")    # noqa
echo "==> Building .#wasm-base-squashfs …"; SQUASH_OUT=$(eval "$NIX build .#wasm-base-squashfs --no-link --print-out-paths") # noqa

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
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/preview-publish.sh`

- [ ] **Step 3: Syntax + shellcheck**

Run: `bash -n scripts/preview-publish.sh && nix run nixpkgs#shellcheck -- scripts/preview-publish.sh`
Expected: no output from `bash -n`; shellcheck clean (the `eval "$NIX …"` lines are the documented project pattern from `scripts/publish-to-r2.sh` — if shellcheck flags SC2086 there, it is acceptable and already disabled in that sibling script; add `# shellcheck disable=SC2086` above each `eval` line to match).

- [ ] **Step 4: Commit**

```bash
git add scripts/preview-publish.sh
git commit -m "feat(scripts): preview-publish.sh — build boot artifacts + sync preview to R2"
```

---

### Task 4: Deploy-Worker workflow

**Files:**
- Create: `.github/workflows/deploy-preview-worker.yml`

**Interfaces:**
- Consumes: secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- Produces: a deployed Worker; its `*.workers.dev` URL printed to the step summary (set as repo var `PREVIEW_BASE_URL`).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/deploy-preview-worker.yml`:

```yaml
name: Deploy preview Worker

# Deploys infra/preview-worker (the R2 preview server) to Cloudflare. Run once
# manually to obtain the *.workers.dev URL (set it as the PREVIEW_BASE_URL repo
# variable), then it re-deploys whenever the Worker source changes on master.
# Requires CLOUDFLARE_API_TOKEN (Edit Workers) + CLOUDFLARE_ACCOUNT_ID.
on:
  workflow_dispatch:
  push:
    branches: [master]
    paths:
      - "infra/preview-worker/**"
      - ".github/workflows/deploy-preview-worker.yml"

permissions:
  contents: read

concurrency:
  group: deploy-preview-worker
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: namespace-profile-default
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Run Worker unit tests
        working-directory: infra/preview-worker
        run: node --test src/index.test.js
      - name: Deploy Worker
        working-directory: infra/preview-worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -euo pipefail
          if [ -z "${CLOUDFLARE_API_TOKEN}" ]; then
            echo "::error::CLOUDFLARE_API_TOKEN is not set. Create an 'Edit Cloudflare Workers' token and add it as a repo secret."
            exit 1
          fi
          bunx wrangler deploy 2>&1 | tee deploy.log
          url="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' deploy.log | head -1)"
          {
            echo "## Preview Worker deployed"
            echo ""
            echo "**Base URL:** \`${url:-<url not found>}\`"
            echo ""
            echo "Set this as the repo variable **\`PREVIEW_BASE_URL\`** (Settings → Secrets and variables → Actions → Variables)."
          } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Lint the workflow**

Run: `nix run nixpkgs#actionlint -- .github/workflows/deploy-preview-worker.yml`
Expected: no findings.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-preview-worker.yml
git commit -m "ci: deploy-preview-worker workflow"
```

---

### Task 5: PR-preview workflow

**Files:**
- Create: `.github/workflows/pr-preview.yml`

**Interfaces:**
- Consumes: `scripts/preview-publish.sh`; secrets `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CACHIX_AUTH_TOKEN`; repo var `PREVIEW_BASE_URL`.
- Produces: per-PR preview at `${PREVIEW_BASE_URL}/pr-<N>/demo/web/`; teardown on close.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/pr-preview.yml`:

```yaml
name: Deploy PR preview

# Boots this PR's freshly-built guest in the browser. The deploy job builds the
# 3 boot artifacts (toolchain substituted from the nix-wasm Cachix cache),
# content-addresses them into cas/<buildhash>/, syncs the runtime/ frontend into
# pr-<N>/, and comments the URL. Teardown purges pr-<N>/ on close.
#
# pull_request_target (not pull_request) so the workflow runs from master's copy
# with secrets available. Unlike pc, this job EXECUTES PR build code (nix build),
# so the deploy job is fork-guarded to same-repo PRs (the repo is single-owner).
on:
  pull_request_target:
    types: [opened, reopened, synchronize, closed]

concurrency:
  group: pr-preview-${{ github.event.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

env:
  PR: ${{ github.event.number }}
  PREVIEW_BUCKET: nix-wasm-previews
  RCLONE_CONFIG_R2_TYPE: s3
  RCLONE_CONFIG_R2_PROVIDER: Cloudflare
  RCLONE_CONFIG_R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
  RCLONE_CONFIG_R2_ENDPOINT: https://${{ secrets.CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com
  RCLONE_CONFIG_R2_ACL: private

jobs:
  teardown:
    if: github.event.action == 'closed'
    runs-on: namespace-profile-default
    steps:
      - name: Check provisioning
        id: cfg
        env:
          KEY: ${{ secrets.R2_ACCESS_KEY_ID }}
        run: |
          if [ -n "$KEY" ]; then echo "configured=true" >> "$GITHUB_OUTPUT";
          else echo "configured=false" >> "$GITHUB_OUTPUT"; echo "::notice::R2 secrets unset — skipping teardown."; fi
      - name: Install rclone
        if: steps.cfg.outputs.configured == 'true'
        run: curl -fsSL https://rclone.org/install.sh | sudo bash
      - name: Purge pr-${{ env.PR }}/
        if: steps.cfg.outputs.configured == 'true'
        run: rclone purge "r2:${PREVIEW_BUCKET}/pr-${PR}" --s3-no-check-bucket --retries 1 --low-level-retries 1 --contimeout 15s || true
      - name: Comment teardown
        if: steps.cfg.outputs.configured == 'true'
        uses: actions/github-script@v7.0.1
        with:
          script: |
            const marker = '<!-- nix-wasm-preview -->';
            const body = `${marker}\n🧹 Preview for this PR was torn down.`;
            const { data: comments } = await github.rest.issues.listComments({ ...context.repo, issue_number: process.env.PR });
            const existing = comments.find(c => c.body.includes(marker));
            if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });

  deploy:
    # Skip on close; skip fork PRs (their build code must never run with secrets).
    if: >-
      github.event.action != 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: namespace-profile-default
    timeout-minutes: 180
    steps:
      - name: Check provisioning
        id: cfg
        env:
          KEY: ${{ secrets.R2_ACCESS_KEY_ID }}
        run: |
          if [ -n "$KEY" ]; then echo "configured=true" >> "$GITHUB_OUTPUT";
          else echo "configured=false" >> "$GITHUB_OUTPUT"; echo "::notice::R2 secrets unset — skipping preview deploy. See infra/preview-worker/README.md."; fi
      - uses: actions/checkout@v4
        if: steps.cfg.outputs.configured == 'true'
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - uses: cachix/install-nix-action@v27
        if: steps.cfg.outputs.configured == 'true'
        with:
          nix_path: nixpkgs=channel:nixos-26.05
          extra_nix_config: |
            experimental-features = nix-command flakes
      - uses: cachix/cachix-action@v15
        if: steps.cfg.outputs.configured == 'true'
        with:
          name: nix-wasm
          authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}'
      - name: Install rclone
        if: steps.cfg.outputs.configured == 'true'
        run: curl -fsSL https://rclone.org/install.sh | sudo bash
      - name: Build + publish preview
        if: steps.cfg.outputs.configured == 'true'
        env:
          PR_COMMIT: ${{ github.event.pull_request.head.sha }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
        run: bash scripts/preview-publish.sh "${PR}"
      - name: Comment preview link
        if: steps.cfg.outputs.configured == 'true'
        uses: actions/github-script@v7.0.1
        env:
          PREVIEW_BASE_URL: ${{ vars.PREVIEW_BASE_URL }}
        with:
          script: |
            const base = process.env.PREVIEW_BASE_URL;
            if (!base) { core.warning('PREVIEW_BASE_URL repo variable is unset'); return; }
            const url = `${base.replace(/\/+$/,'')}/pr-${process.env.PR}/demo/web/`;
            const marker = '<!-- nix-wasm-preview -->';
            const sha = (process.env.GITHUB_SHA || '').slice(0, 8);
            const body = `${marker}\n🚀 **Preview ready:** ${url}\n\n<sub>Boots this PR's guest (commit \`${sha}\`) in the browser · updated on every push.</sub>`;
            const { data: comments } = await github.rest.issues.listComments({ ...context.repo, issue_number: process.env.PR });
            const existing = comments.find(c => c.body.includes(marker));
            if (existing) await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
            else await github.rest.issues.createComment({ ...context.repo, issue_number: process.env.PR, body });
```

- [ ] **Step 2: Lint the workflow**

Run: `nix run nixpkgs#actionlint -- .github/workflows/pr-preview.yml`
Expected: no findings.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-preview.yml
git commit -m "ci: pr-preview workflow — build + publish + comment per-PR boot preview"
```

---

### Task 6: Provisioning runbook + docs

**Files:**
- Create: `infra/preview-worker/README.md`
- Modify: `CLAUDE.md` (the "Boot-test the built guest" / pc-facing delivery area — add a short PR-previews note)

**Interfaces:**
- Consumes/Produces: human-run provisioning steps; no code.

- [ ] **Step 1: Write the README**

Create `infra/preview-worker/README.md`:

```markdown
# nix-wasm PR-preview infrastructure (Cloudflare R2 + Worker)

A PR preview boots **this PR's** freshly-built guest in the browser. The
`nix-wasm-previews` R2 bucket holds two key spaces, served by the Worker in
`src/index.js`:

```
nix-wasm-previews
├── pr-<N>/<path>        the PR's frontend (runtime/ tree, rclone-synced)
└── cas/<buildhash>/…    content-addressed boot artifacts shared across PRs:
                           vmlinux.wasm, initramfs.cpio.gz, base.squashfs
```

- The Worker stamps `COOP/COEP/CORP` on every response → cross-origin isolated
  (SharedArrayBuffer, which the wasm kernel needs); a bare R2 URL can't.
- Boot artifacts are content-addressed (`buildhash` = sha256 of the three nix
  store-path hashes), uploaded with `--ignore-existing`, so a guest-unchanged
  push uploads ~zero artifact bytes and many PRs share one `cas/` prefix.
- The guest binary cache (`nix-cache/`, in-guest `nix-env -iA`) is **not** part
  of previews — that is issue #2's substituter.

## One-time provisioning

1. **Create the R2 bucket** (Cloudflare dashboard → R2): `nix-wasm-previews`.
2. **Create an R2 API token** (R2 → Manage API Tokens → *Object Read & Write*,
   scoped to `nix-wasm-previews`). Note the **Access Key ID**, **Secret Access
   Key**, and **Account ID**.
3. **Deploy the Worker** — run the **Deploy preview Worker** GitHub workflow
   (Actions → *Deploy preview Worker* → *Run workflow*), or locally:
   ```sh
   cd infra/preview-worker && bunx wrangler deploy
   ```
   Note the deployed URL, e.g. `https://nix-wasm-previews.<subdomain>.workers.dev`.
4. **Add repo secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CACHIX_AUTH_TOKEN`
     already exist for the artifact/cache workflows.)
5. **Add a repo variable** (same page → Variables):
   - `PREVIEW_BASE_URL` = the Worker URL from step 3 (no trailing slash).

After that, every same-repo PR gets a preview at
`${PREVIEW_BASE_URL}/pr-<N>/demo/web/`, updated on each push and torn down on
close. Until the secrets/variable are set, the workflows are no-ops (they log a
`::notice::` and skip).

## Local checks

```sh
node --test src/index.test.js     # Worker unit tests
bunx wrangler dev                 # local Worker; curl -I to inspect headers
# Dry-run the publish (builds, prints rclone commands, uploads nothing):
NIX_CMD="echo <pw> | sudo -S nix" bash ../../scripts/preview-publish.sh 999
```

## Cost

R2 free tier: 10 GB storage, 1M Class-A ops/mo. One guest build's artifacts
(~base.squashfs 127 MB + vmlinux + initramfs) live once per distinct build in
`cas/`; `pr-<N>/` frontends are ~9 MB and purged on close. `cas/` can be GC'd
periodically; it is bounded by the number of distinct guest builds.
```

- [ ] **Step 2: Add a CLAUDE.md note**

In `CLAUDE.md`, under the **pc-facing delivery** paragraph (right after the
`linux` channel description in the "Boot-test the built guest" section), add:

```markdown
**PR previews:** every same-repo PR gets a browser preview that boots *that PR's*
guest — `.github/workflows/pr-preview.yml` builds the 3 boot artifacts (toolchain
substituted from the `nix-wasm` Cachix cache), content-addresses them into the
`nix-wasm-previews` R2 bucket's `cas/<buildhash>/`, rclone-syncs the `runtime/`
frontend into `pr-<N>/`, and comments `${PREVIEW_BASE_URL}/pr-<N>/demo/web/`. The
served Worker (`infra/preview-worker/`) stamps COOP/COEP. Boot artifacts only —
the guest `nix-cache/` substituter stays #2's concern. Setup runbook:
`infra/preview-worker/README.md`.
```

- [ ] **Step 3: Verify docs reference real paths**

Run: `test -f infra/preview-worker/src/index.js && grep -q 'pr-preview.yml' CLAUDE.md && echo OK`
Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add infra/preview-worker/README.md CLAUDE.md
git commit -m "docs(preview): provisioning runbook + CLAUDE.md PR-previews note"
```

---

## Post-implementation (human-run, not a code task)

These are operational and cannot be done from the session:

1. Create the `nix-wasm-previews` R2 bucket + scoped API token (README step 1–2).
2. Add `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` repo secrets.
3. Run **Deploy preview Worker**; set `PREVIEW_BASE_URL` repo variable from its summary.
4. Open a throwaway PR; confirm the comment appears and the URL boots the guest.

## Self-Review notes

- **Spec coverage:** bucket+Worker (T1), runtime preview.json seam (T2), build+CAS+sync script (T3), worker deploy workflow (T4), pr-preview deploy+teardown with fork+provisioning guards (T5), secrets/vars + runbook (T6, post-impl). Cost, security divergence, scope boundary all carried into README/workflow comments.
- **Type/name consistency:** `artifactsBase` (T2 reads it, T3 writes it), bucket `nix-wasm-previews` and binding `PREVIEWS` (T1 wrangler.toml, T3/T5 env), marker `<!-- nix-wasm-preview -->` (T5 both jobs), buildhash definition identical in T3 and README.
```

