# Deploy runbook: publish wasm artifacts to R2

This runbook covers the manual publish flow and the CI/CD pipeline that uploads
`base.squashfs` + the Nix binary cache to the `pc-previews` R2 bucket so pc can
consume them via the disc-package system.

---

## What gets published

| Artifact | Flake attr | R2 key |
|---|---|---|
| Base squashfs (the `/nix` closure, virtio-blk block device) | `.#wasm-base-squashfs` → `$out/base.squashfs` | `pc-previews/packages/nix-wasm-base/<version>` |
| On-demand toolchain binary cache | `.#wasm-binary-cache` → `$out/{nix-cache-info,*.narinfo,nar/*,pkgs.nix,manifest.json}` | `pc-previews/nix-cache/<relpath>` |

`<version>` is the sha256 of `base.squashfs` (content-addressed, safe to
immutable-cache forever — the same bytes always live at the same R2 key).

The base squashfs is consumed by pc's disc-package system with an **identity
mount** (not `mountIso`): Linux reads the raw `.squashfs` directly via
virtio-blk, the guest kernel mounts it as the `/nix` overlay lowerdir. See
pc's `.claude/rules/disc-packages.md` for the disc-package delivery contract.

---

## Prerequisites

- `bun` installed (provides `bunx wrangler`)
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` exported in the shell
- On aarch64 / machines where the nix daemon requires root: set `NIX_CMD`
  (see below)

---

## Manual publish flow

```sh
# On CI / x86_64 with install-nix-action (no sudo needed):
bash scripts/publish-to-r2.sh

# Locally where `nix` requires sudo (aarch64 dev machine):
NIX_CMD="echo <password> | sudo -S nix" bash scripts/publish-to-r2.sh

# Dry-run (no creds — prints wrangler commands and exits 0 without uploading):
bash scripts/publish-to-r2.sh    # (when CLOUDFLARE_API_TOKEN is unset)
```

The script:

1. Runs `nix build .#wasm-base-squashfs --print-out-paths --no-link` and
   `nix build .#wasm-binary-cache --print-out-paths --no-link`
2. Computes `sha256sum` + `stat -c%s` of `$out/base.squashfs`
3. Sets `VERSION="$SHA"` (content-addressed)
4. Uploads `base.squashfs` → `pc-previews/packages/nix-wasm-base/$VERSION`
5. Uploads the binary-cache tree file-by-file → `pc-previews/nix-cache/<relpath>`
6. Prints `bytes=... sha256=... version=...` for the registry update below

---

## --remote is mandatory

`wrangler r2 object put` in wrangler 4.x **defaults to the local simulator**
(writing to `.wrangler/state/...`) if `--remote` is omitted. The live R2 URL
returns 404. The script always passes `--remote` on the real upload path.

See also: pc `.claude/rules/disc-packages.md` — if a package 404s, the first
thing to check is whether the upload used `--remote`.

---

## Verify the upload

After publishing, confirm the squashfs is live:

```sh
curl -I https://pc-previews.eric-c6b.workers.dev/packages/nix-wasm-base/<version>
```

Expected response headers:

```
HTTP/2 200
content-type: application/octet-stream
access-control-allow-origin: *
cross-origin-resource-policy: cross-origin
cache-control: public, max-age=31536000, immutable
```

If the response is `404 Not Found`:

1. Check that `--remote` was passed to `wrangler r2 object put` (without it
   the object was written to the local sim, not the real bucket).
2. Check that the preview-worker deployed to the `pc-previews.eric-c6b.workers.dev`
   route has a `/packages/*` handler — see pc's `.claude/rules/disc-packages.md`.
3. Confirm `CLOUDFLARE_ACCOUNT_ID` pointed at the account that owns the
   `pc-previews` worker and bucket.

---

## Update pc registry.js

The publish script prints (and in CI appends to `$GITHUB_STEP_SUMMARY`):

```
bytes=<N> sha256=<sha256hex> version=<sha256hex>
```

Copy these values into `pc js/packages/registry.js`:

```js
{
  id: "nix-wasm-base",
  version: "<sha256hex>",   // ← content hash; also the R2 key suffix
  bytes: <N>,
  sha256: "<sha256hex>",
  url: "https://pc-previews.eric-c6b.workers.dev/packages/nix-wasm-base/<sha256hex>",
}
```

The `installCore` path in pc calls `bootNixSystem({ squashfs })` with this
URL; the disc-package system downloads, verifies (sha256 + byte length), and
presents the file as a virtio-blk device. The guest kernel mounts it as the
`/nix` overlay lowerdir (identity mount — no ISO 9660 involved).

---

## CI/CD

`.github/workflows/publish-wasm-artifacts.yml` runs automatically on push to
`master` and on `workflow_dispatch`. It:

1. Checks out the repo
2. Installs Nix via `cachix/install-nix-action@v27` with the `nixos-26.05`
   channel pin (fully cached on x86_64; avoids from-source LLVM rebuilds)
3. Installs `bun` via `oven-sh/setup-bun@v2`
4. Runs `bash scripts/publish-to-r2.sh` with `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` from GitHub secrets
5. Appends the `bytes`/`sha256`/`version` output to the step summary for easy
   copy-paste into the pc `registry.js` bump PR

**Required secrets** (set in the GitHub repo settings under Actions → Secrets):

- `CLOUDFLARE_API_TOKEN` — a token with R2 write permission on the
  `pc-previews` bucket
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account that owns the bucket

---

## Notes on the binary cache tree

The `.#wasm-binary-cache` output contains:

```
nix-cache-info          ← cache priority / substituter info
<hash>.narinfo          ← one per store path; no Deriver: field (known gap — nix profile
                           install rejects these; nix-env -iA works fine)
nar/<hash>.nar.zst      ← the actual NAR archives
pkgs.nix                ← fake-derivation index for nix-env -iA dev-tools / clang / cc / c++
manifest.json           ← file list consumed by runtime/nix-cache.js on first access
```

The guest's `bootstrap.nix` copies `/nix-cache/pkgs.nix` to
`~/.nix-defexpr/pkgs.nix` at boot; `nix-env -iA clang` then resolves through
the binary cache served by `runtime/nix-cache.js`.
