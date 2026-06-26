# PR previews — design

**Status:** approved, ready for implementation plan
**Date:** 2026-06-25
**Depends on:** #2 (Phase 5 CI + Cachix binary cache) — **landed** (PR #69)

## Goal

Open or push a pull request → get a comment with a live URL → click it → the
`runtime/demo/web` browser demo boots **this PR's** freshly-built guest in the
browser (kernel + userspace + squashfs as the PR changed them). The reviewer can
exercise kernel/userspace/GTK changes live, the same way `../pc`'s PR previews let
a reviewer click into a running build.

This mirrors pc's PR-preview system (R2 bucket + Cloudflare Worker + a
`pull_request` workflow that comments a link), adapted to the fact that nix-wasm
is a **build** repo: the previewed page needs heavy `nix build` artifacts, not
just static files.

## Non-goals / scope boundary

- **No guest binary cache in the preview.** `nix-cache/` (`.#wasm-binary-cache`,
  the in-guest `nix-env -iA` substituter) is issue #2's concern, not the
  preview's. A preview boots and runs everything baked into `base.squashfs`
  (shell, GTK apps in `environment.systemPackages`, …); in-guest install of a
  **non-baked** package is explicitly out of scope for a preview. If that's ever
  wanted, the seam is to point the boot's `nixCacheBaseUrl` at whatever cache #2
  publishes — not to build a per-PR copy.
- **No host build-cache work.** That was #2 and it landed (Cachix). The preview
  consumes it.
- **No base/diff overlay for the frontend.** pc needs that for its ~400 MB of
  vendored blobs; nix-wasm's frontend is ~9.3 MB (8.6 of it vendored
  ghostty/greenfield), so a plain `rclone sync` of the whole tree is simpler and
  sufficient.

## Background — what the previewed page actually fetches

`runtime/demo/web/main.js` boots via `bootNixSystem({ baseUrl, nix: true,
wayland })`. In baseUrl-mode (`runtime/boot-nix-system.js`) the runtime fetches,
relative to `baseUrl`:

- `vmlinux.wasm` — the kernel (`.#kernel`)
- `initramfs.cpio.gz` — the initramfs (`.#wasm-initramfs`)
- `base.squashfs` — the served `/nix` base closure (`.#wasm-base-squashfs`)
- `nix-cache/` — the substituter (`.#wasm-binary-cache`) — **lazy, only hit on
  in-guest substitution; out of scope here.**

Today `main.js` hardcodes `baseUrl = new URL("./artifacts/", document.baseURI)`,
which local dev satisfies with `ln -sfn /path/to/artifacts demo/web/artifacts`.
The single change to that file (below) makes `baseUrl` per-PR-aware while keeping
local dev identical.

## What #2 gives us (the build-cache backend, already shipped)

From `.github/workflows/nix-wasm.yml` (PR #69):

- **Backend = Cachix** — `nix-wasm.cachix.org`, public read; push gated on the
  `CACHIX_AUTH_TOKEN` repo secret. Content-addressed by store-path hash, so it is
  both substituter and push target with no manual cache-key bookkeeping.
- `nix-wasm.yml` runs on `pull_request` (paths: `**/*.nix`, `patches/**`, …): it
  builds `.#kernel`, `.#wasm-initramfs`, `.#wasm-base-squashfs`,
  `.#linux-image`, … and **pushes them to Cachix**. So by the time/if a preview
  builds, the boot artifacts substitute in minutes; only PR-changed leaves
  rebuild.
- **Runners = Namespace.** `namespace-profile-nix-heavy` for the from-source LLVM
  poles; `namespace-profile-default` for substitution-only jobs. Stock
  `ubuntu-latest` times out on cold toolchain builds. The standard wiring is
  `cachix/install-nix-action@v27` + `cachix/cachix-action@v15` (name: `nix-wasm`).

The preview's build job follows these conventions exactly.

## Architecture

### R2 bucket — `nix-wasm-previews` (new)

Same Cloudflare account as `pc-previews`, separate bucket (own infra, pc's Worker
stays pc-only). Two key spaces:

```
pr-<N>/<path>            the PR's frontend bundle (runtime/ JS tree + vendored
                         ghostty/greenfield), rclone-synced — only changed files
                         upload on each push
cas/<buildhash>/...      content-addressed boot artifacts for one build:
                           vmlinux.wasm
                           initramfs.cpio.gz
                           base.squashfs
                         uploaded once with --ignore-existing; a guest-unchanged
                         push re-uses an existing prefix → uploads ~zero artifact
                         bytes; multiple PRs on the same build share one prefix
```

`buildhash` = sha256 of the three nix store-path basenames (which encode each
output's content hash) concatenated. Cheap (no re-hashing 127 MB) and changes iff
any artifact changes.

### Cloudflare Worker — `infra/preview-worker/`

Self-contained in this repo, copied/simplified from pc's
`infra/preview-worker/src/index.js`. **No union-mount** (Approach A has no shared
`base/` layer): it serves any bucket key directly.

- Routes: `/pr-<N>/<path>` and `/cas/<hash>/<path>` → the same bucket key.
- Stamps every response with `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Resource-Policy: cross-origin` (SharedArrayBuffer — the kernel
  needs it; a bare R2 URL can't set these). Page and artifacts are same-origin,
  so no CORS needed.
- Content-type table for `.wasm`, `.js`/`.mjs`, `.gz`, `.squashfs`→
  `application/octet-stream`, `.json`, fonts, images, etc. (R2 object metadata
  may not carry one).
- Directory-style paths → `index.html`. `/` → a small 404 pointing at
  `/pr-<N>/demo/web/`.
- Cache-Control: `cas/*` → `public, max-age=31536000, immutable`; `*.html` and
  `preview.json` → `no-store`; other `pr-<N>/*` assets → short cache.
- Files: `src/index.js`, `wrangler.toml` (binding `PREVIEWS` →
  `nix-wasm-previews`, `workers_dev = true`, `compatibility_date`),
  `package.json` (`wrangler` devDep), `README.md` (provisioning runbook).

### Runtime change — `runtime/demo/web/main.js`

Before boot:

```js
let artifactsBase = new URL("./artifacts/", document.baseURI).href; // local dev default
try {
  const r = await fetch("./preview.json", { cache: "no-store" });
  if (r.ok) artifactsBase = new URL((await r.json()).artifactsBase, document.baseURI).href;
} catch { /* no preview.json → local dev path */ }
```

then pass `baseUrl: artifactsBase` to `bootNixSystem`. Backwards-compatible: local
dev ships no `preview.json`, so the `./artifacts/` symlink path is unchanged.

### Publish script — `scripts/preview-publish.sh`

Mirrors the existing `scripts/publish-to-r2.sh` conventions (`NIX_CMD` override
for local sudo; dry-run that prints the exact rclone commands when creds are
absent). Takes the PR number. Steps:

1. `nix build .#kernel .#wasm-initramfs .#wasm-base-squashfs --print-out-paths
   --no-link` (substitutes from Cachix).
2. Assemble a temp `artifacts/` dir with `vmlinux.wasm`, `initramfs.cpio.gz`,
   `base.squashfs` (copies/symlinks of the three outputs, named as the runtime
   expects).
3. `buildhash` = sha256 of the three store-path basenames.
4. `rclone copy artifacts/ r2:nix-wasm-previews/cas/<buildhash>/ --ignore-existing`.
5. Write `demo/web/preview.json` =
   `{ "artifactsBase": "/cas/<buildhash>/", "pr": N, "commit": "<sha>",
   "builtAt": "<iso8601>" }` into the synced tree.
6. `rclone sync runtime/ r2:nix-wasm-previews/pr-<N>/ --delete
   --exclude 'node_modules/**' --exclude 'demo/node/**' --exclude '*.test.js'`
   (plus `.git`, scratch).

rclone is used over `wrangler r2 object put` because it does whole-tree sync,
skip-existing, and `--delete` in one pass; per-file `wrangler put` is unworkable
for a tree.

### Workflows

**`.github/workflows/pr-preview.yml`** — `pull_request_target`
(opened/reopened/synchronize/closed), per-PR `concurrency` with
cancel-in-progress.

- **deploy job** (`action != 'closed'`):
  - Provisioning guard: skip with a `::notice::` if the R2/CF secrets are unset
    (like pc), so the workflow is a no-op until provisioned.
  - **Fork guard:** `github.event.pull_request.head.repo.full_name ==
    github.repository`. nix-wasm must *execute* PR build code (`nix build`), which
    under `pull_request_target` would otherwise run untrusted code with secrets in
    scope. The repo is private/single-owner, so all real PRs satisfy this.
  - `runs-on: namespace-profile-default`.
  - `actions/checkout@v4` (PR head) → `cachix/install-nix-action@v27` +
    `cachix/cachix-action@v15` (name `nix-wasm`) → install bun + rclone →
    `bash scripts/preview-publish.sh ${{ github.event.number }}` →
    comment/update the link via `actions/github-script` (marker
    `<!-- nix-wasm-preview -->`).
- **teardown job** (`action == 'closed'`): `rclone purge
  r2:nix-wasm-previews/pr-<N>` and update the comment.

**`.github/workflows/deploy-preview-worker.yml`** — verbatim pc pattern: deploy
the Worker on master push to `infra/preview-worker/**` (or `workflow_dispatch`),
print the `*.workers.dev` URL to the step summary so it can be set as
`PREVIEW_BASE_URL`. `runs-on: namespace-profile-default`.

No base-sync workflow (Approach A has no shared `base/` layer).

### Secrets & variables

- **Existing (reused):** `CLOUDFLARE_API_TOKEN` (Worker deploy),
  `CLOUDFLARE_ACCOUNT_ID` (R2 endpoint), `CACHIX_AUTH_TOKEN` (optional push;
  substitution works without it).
- **New:** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — an R2 API token scoped to
  `nix-wasm-previews`, for rclone's S3 endpoint.
- **New repo variable:** `PREVIEW_BASE_URL` — the deployed Worker URL (no trailing
  slash).

## Data flow (a PR push)

1. PR opened/synchronized → `pr-preview.yml` deploy job (fork+provisioning guards
   pass).
2. `nix build .#kernel .#wasm-initramfs .#wasm-base-squashfs` — boot artifacts
   substitute from Cachix; PR-changed leaves rebuild.
3. Assemble `artifacts/`; compute `buildhash`.
4. `rclone copy → cas/<buildhash>/ --ignore-existing` (no-op if already built).
5. Write `demo/web/preview.json`; `rclone sync runtime/ → pr-<N>/ --delete`.
6. Comment `${PREVIEW_BASE_URL}/pr-<N>/demo/web/`.
7. Click → page loads → `main.js` reads `preview.json` → boots with
   `baseUrl=/cas/<buildhash>/` → `bootNixSystem` fetches the artifacts same-origin
   (COOP/COEP satisfied) → guest boots in the browser.
8. On PR close → teardown purges `pr-<N>/`.

## Security note (the one real divergence from pc)

pc's preview only *copies files*; nix-wasm must `nix build` PR code. Under
`pull_request_target` that build runs with secrets in scope. Mitigation: the
**fork guard** restricts the deploy job to same-repo PRs. The repo is
private/single-owner, so this is sufficient today. **Future hardening if forks are
ever opened up:** split into a `pull_request` build job (no secrets, untrusted)
that uploads an artifact, plus a `workflow_run` job (trusted, secrets) that
downloads and publishes it. Documented, not built (YAGNI for a single-owner repo).

## Cost

R2 free tier: 10 GB storage, 1 M Class-A ops/mo. Per distinct guest build the
`cas/` prefix holds `base.squashfs` (~127 MB) + `vmlinux.wasm` + `initramfs`
(~a few hundred MB total); content-addressing dedupes across PRs and pushes, and
the ~9 MB frontend per PR is negligible. `cas/` is GC'd separately (or left —
bounded by the number of distinct guest builds); `pr-<N>/` is purged on PR close.

## Testing / verification

- Worker JS stays clean under the repo's `oxlint`/`oxfmt` (not wired into a CI
  gate — those gates are knowingly red on pre-existing debt per
  `runtime-gates.yml`).
- `scripts/preview-publish.sh` dry-run (no creds) prints the exact `nix build` +
  rclone commands — runnable locally to validate logic without uploading.
- Local Worker check: `wrangler dev` → `curl -I` asserts COOP/COEP/CORP +
  content-type on a `cas/*` and a `pr-*` key.
- End-to-end: after the first `deploy-preview-worker.yml` run sets
  `PREVIEW_BASE_URL`, open a real PR preview and confirm the guest boots; the
  existing `runtime/demo/web/smoke.mjs` Playwright smoke can be pointed at the
  preview URL.

## Files touched / added

- **add** `infra/preview-worker/{src/index.js,wrangler.toml,package.json,README.md}`
- **add** `.github/workflows/pr-preview.yml`
- **add** `.github/workflows/deploy-preview-worker.yml`
- **add** `scripts/preview-publish.sh`
- **edit** `runtime/demo/web/main.js` (read optional `preview.json`)
- **add** docs pointer (this spec; a short note in `CLAUDE.md`'s runtime/delivery
  section is optional follow-up)
- **out of repo:** create the `nix-wasm-previews` R2 bucket + R2 API token; add
  the new secrets/variable.
