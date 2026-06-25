# Design — one versioned `linux` channel (pc#315)

**Date:** 2026-06-24
**Issue:** codebutler/pc#315
**Repos:** `nix-wasm` (build + engine) and `pc` (consume + publish)

## Problem

The four guest data artifacts pc needs to boot the Linux app are split across two
delivery mechanisms, and republishing one of them is coupled to a pc code change +
deploy:

| Artifact | Today | Loaded by |
|---|---|---|
| `vmlinux.wasm` | git `vendor/linux-wasm/` (5.9M) | engine fetch from `baseUrl` |
| `initramfs.cpio.gz` | git `vendor/linux-wasm/` (30M) | engine fetch from `baseUrl` |
| `nix-cache/` | git `vendor/linux-wasm/` (29M) | engine lazy HTTP proxy over 9P |
| `base.squashfs` | R2 disc package `linux-base` (53M) | virtio-blk (bytes passed in) |
| runtime engine JS | git `vendor/linux-wasm/runtime/` | `import`ed app code |

Two consequences:

1. **Republishing the squashfs requires a pc deploy** — bumping `version` + `sha256`
   in `js/packages/registry.js` and shipping it. The other three only republish via a
   git commit (another deploy). So *any* guest change needs a pc deploy.
2. **The pieces can silently desync.** There is a real ABI between the kernel/guest
   and the engine JS (exec-ABI skew, loader stubs, the `futex` shim in
   `kernel-worker.js`, virtio/9P device models). Today desync is only prevented
   because three of the four co-deploy via git. Floating the squashfs alone already
   breaks that guarantee.

The motivating incident: wayland apps fail with `cannot connect to display` on the
live site because the deployed guest predates nix-wasm #31 (inittab auto-start of
`waylandproxyd`). The fix exists upstream; it just needs the guest republished — and
the friction of doing that is what this design removes.

## Decisions (settled during brainstorming)

1. **Bundle scope:** the **boot trio** (`vmlinux.wasm` + `initramfs.cpio.gz` +
   `base.squashfs`) is bundled into ONE versioned `.iso`. `nix-cache/` moves to R2
   under the same channel but is still **fetched lazily over HTTP** — so opening a
   shell or a Wayland app does not pull the ~29M compiler toolchain that only an
   in-guest `cc`/`nix-env -iA guest-cc` needs.
2. **Build location:** a reproducible nix-wasm derivation `.#linux-image`, built with
   nixpkgs' standard `nixos/lib/make-iso9660-image.nix`. Honors nix-wasm's "every
   artifact is a reproducible derivation" directive; pc carries no bundling logic.
3. **ABI marker:** a monotonic integer `WASM_GUEST_ABI` in nix-wasm. The engine
   exports it as `ENGINE_ABI`; `.#linux-image` stamps `minEngine` from it. pc checks
   `ENGINE_ABI >= minEngine` before boot. Bumped only on a real ABI break.
4. **Channel:** a mutable `latest.json` pointer (served `no-cache`) over immutable
   versioned objects. Republish = build → upload a new `<v>` → overwrite
   `latest.json`. No pc code change, no pc deploy.

## Channel layout (R2, served by the preview Worker)

```
packages/linux/<v>/linux.iso              immutable; the boot bundle, one whole download
packages/linux/<v>/nix-cache/             immutable; toolchain cache, fetched LAZILY (shape unchanged)
    manifest.json, *.narinfo, nar/, nix-cache-info, pkgs.nix
packages/linux/latest.json                MUTABLE pointer, Cache-Control: no-cache
```

`latest.json`:
```json
{
  "version": 2,
  "image": { "url": "https://…/packages/linux/2/linux.iso", "bytes": 93000000, "sha256": "…" },
  "nixCacheBaseUrl": "https://…/packages/linux/2/nix-cache",
  "minEngine": 1
}
```

The `<v>` is a single channel version covering both the `.iso` and the `nix-cache/`
tree (they are rebuilt together from one nix-wasm commit), so they can never desync
from each other. The `.iso` is downloaded whole and persisted offline; the
`nix-cache/` files are fetched on demand and are online-only (matches today's
behavior — compile already needs the cache).

## ABI guard

`WASM_GUEST_ABI` is one integer, the single source of truth, living in nix-wasm as a
small JSON file (e.g. `runtime/abi.json`, `{"abi": 1}`) — JSON so both sides read the
exact same bytes with no duplication: nix via `builtins.fromJSON (builtins.readFile …)`
and the engine JS via `import`/`fetch`. From it:

- the engine (`runtime/`) exports it as `ENGINE_ABI` (vendored into pc with the rest
  of `runtime/` via `sync-to-pc.sh`);
- `.#linux-image` stamps `minEngine = WASM_GUEST_ABI` into the in-`.iso`
  `manifest.json` AND mirrors it into `latest.json` (so pc can guard *before*
  downloading the image).

Because both are built from the same commit, `ENGINE_ABI == minEngine` for a
co-published pair. The guard only fires when a user's **cached/stale pc** (older
vendored engine) meets a **freshly published newer image** — exactly the
silent-desync failure we want to convert into a clear message:

> "A newer Linux system is available — reload pc to update."

Bumped only on a genuine engine↔guest ABI break; backward-compatible engine changes
need no republish.

## nix-wasm changes

- **`WASM_GUEST_ABI`** — a single-source-of-truth JSON file (`runtime/abi.json`,
  `{"abi": 1}`) consumed by both `runtime/` (re-exported as `ENGINE_ABI`) and
  `.#linux-image` (as `minEngine`, via `builtins.fromJSON`). Start at `1`.
- **`.#linux-image`** — a derivation calling
  `pkgs.callPackage "${nixpkgs}/nixos/lib/make-iso9660-image.nix" { … }` with:
  - `contents = [ {source=<kernel>/vmlinux.wasm; target="/vmlinux.wasm";}
                  {source=<initramfs>; target="/initramfs.cpio.gz";}
                  {source=<squashfs>; target="/base.squashfs";}
                  {source=<generated manifest.json>; target="/manifest.json";} ]`
  - `volumeID = "LINUX"`, `bootable = false`, no iso-level compression (the squashfs
    is already zstd).
  - The generated `/manifest.json` carries `{ version, minEngine }`. (Image `version`
    here is informational/traceability; the authoritative channel version is the R2
    path `<v>` + `latest.json`.)
  - Inputs: the existing `.#kernel`, `.#wasm-initramfs`, `.#wasm-base-squashfs`.
- **Engine bytes-mode** — `runtime/boot-nix-system.js` `bootNixSystem` gains an
  artifacts-by-bytes path: accept `vmlinux` and `initramfs` as `ArrayBuffer`/`Blob`
  and `nixCacheBaseUrl` as a string; when present, use them instead of deriving URLs
  from `baseUrl` (which becomes optional/legacy). `squashfs`-as-bytes already exists.
  Export `ENGINE_ABI`. This keeps pc on the engine's public front door rather than
  reaching into `bootLinux` internals. One engine bump → `runtime/sync-to-pc.sh`.
- **nix-cache** still comes from `.#wasm-binary-cache`; it is now uploaded to R2 under
  the channel rather than committed to pc git.

## pc changes

- **`resolveLinuxChannel()`** (new, in `js/packages/`): fetch `latest.json`
  (`no-cache`) → a dynamic package entry `{ pkgId:"linux", isoName, url, bytes,
  sha256, version }` plus `{ minEngine, nixCacheBaseUrl }`. On fetch failure
  (offline), fall back to the last-persisted installed version so a previously
  installed guest still boots offline.
- **Disc install reuse** — the dynamic entry flows through the *existing* installer
  machinery (`installCore`: download → `verifyBytes` → persist under
  `/Home/Library/Discs/` → version/update/staleness prompt → offline re-use). Unlike
  `linux-base` (which used the identity-mount `ensurePackageBytes`), the `linux`
  package is **mounted as a real `.iso`** (`mountIso`) so the three members can be
  read out of the volume.
- **`kernel-service.js`** — boot flow becomes: resolve channel → **ABI guard**
  (`ENGINE_ABI >= minEngine`, else show the reload message and abort) → ensure+mount
  the `.iso` → read `/vmlinux.wasm`, `/initramfs.cpio.gz`, `/base.squashfs` from the
  mount → `bootNixSystem({ vmlinux, initramfs, squashfs, nixCacheBaseUrl, … })`. Drop
  `ARTIFACTS_BASE`.
- **`registry.js`** — remove the static `linux-base` entry (the `linux` channel is
  resolved dynamically, not a static registry row). Other disc packages
  (sample/omnia/omnia-images) are unchanged.
- **Remove from pc git** — `vendor/linux-wasm/{vmlinux.wasm, initramfs.cpio.gz,
  nix-cache/}`. The engine JS (`vendor/linux-wasm/runtime/`) stays vendored.

## preview-worker change

The existing `packages/` route stamps `Cache-Control: …immutable`. Special-case the
channel pointer (`packages/linux/latest.json`, or any `*/latest.json`) to
`Cache-Control: no-cache` so the pointer is always fresh while the versioned `.iso`
and nar objects stay immutable. The Worker deploys **separately** from the app
(already documented in `disc-packages.md`).

## Verification to do during implementation

- **Rock Ridge long names:** confirm pc's `iso-mount.js` reads the long filename
  `initramfs.cpio.gz` from a `make-iso9660-image` output (it uses xorriso with Rock
  Ridge; the existing omnia `.iso` is also xorriso, so very likely fine — but verify
  by mounting and reading all three members).
- **Engine bytes-mode parity:** booting from passed-in bytes + `nixCacheBaseUrl` must
  reach a shell and substitute a package, identical to the `baseUrl` path.

## Docs (acceptance criteria)

- `pc vendor/linux-wasm/SOURCE.md` — a single end-to-end **"Republish the guest"**
  runbook: `nix build .#linux-image` → upload `linux.iso` + `nix-cache/` under a new
  `<v>` → overwrite `latest.json`. Note when to bump `WASM_GUEST_ABI`.
- `pc .claude/rules/disc-packages.md` — carve out `linux` as the **cross-repo,
  non-`.iso`-script, channel** package (distinct from the xorriso/`build-<pkg>-iso`
  pattern); point at the runbook.
- `nix-wasm CLAUDE.md` — a pointer to the runbook + the **`init.nix` → `toplevel.nix`
  → `base.squashfs`** mapping (the inittab lives in the squashfs, not the initramfs —
  the non-obvious "which artifact do I republish?" answer).

## Out of scope / non-goals

- The runtime engine JS stays in git and deploys with pc (it is app code, not data
  the guest reads). The `minEngine` guard handles the resulting kernel↔engine
  coupling.
- No separate one-off wayland redeploy: shipping this — the first `.iso` built from
  nix-wasm HEAD (with #31) — *is* the wayland fix.
- Bundling `nix-cache` into the `.iso` (rejected: forces the ~29M toolchain on every
  first launch even for users who never compile).

## Sequencing

1. **nix-wasm:** `WASM_GUEST_ABI` + `.#linux-image` + engine bytes-mode (+ sync to pc).
2. **publish:** R2 upload of `linux.iso` + `nix-cache/` under `<v>`; worker `no-cache`
   for `latest.json`; write `latest.json`.
3. **pc:** `resolveLinuxChannel()` + `kernel-service.js` rewrite + `registry.js` +
   git removal.
4. **docs:** runbook + rules carve-out + CLAUDE pointer.
