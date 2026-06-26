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
  store-path basenames), uploaded with `--ignore-existing`, so a guest-unchanged
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
