# Rethinking `/nix` serving: squashfs base + NAR binary cache

**Issue:** codebutler/nix-wasm#43 (folds in #2 and #1)
**Date:** 2026-06-23
**Status:** Design approved (brainstorming); pending spec review → implementation plan

## Problem

The guest's `/nix` is served from a single bespoke **`store.json`** manifest
(`userspace/store-manifest.{nix,py}` → `runtime/nix-closure-store.js`): a
serialized filesystem image of the *entire* wasm-system closure, where files
≥ 512 KiB become lazy `store-content/<sha256>` blobs and everything < 512 KiB is
inlined as base64 directly in the JSON, then `JSON.parse`'d wholesale at boot
into a `MemVfs` and 9P-served as an overlay lowerdir.

This is now a **hard blocker**, not just a scaling worry: even a clean, minimal
closure for a single GTK app produces a **127 MB `store.json`**, which exceeds
GitHub's 100 MB file-size limit, so it cannot be vendored to the `pc` repo. The
GTK-on-pc work is blocked. The format also: scales with file *count* (every small
file carries full base64 inline), parses a giant JSON into memory at boot, and is
catastrophically fragile to closure bloat (a single dead ref dragged the manifest
to 345 MB / 22.5k entries). Critically, the size **cannot** be fixed by stripping
references — over-stripping removed a real runtime dep (xkeyboard-config) and
broke every GTK app (#45). The size must come down via the **format**, not by
removing content.

## Root-cause reframe

The real problem is not "pick a better serialization for one 350 MB blob." It is
that **the compiler toolchain (~89 MB: clang ~57 MB, wasm-ld ~32 MB) is baked into
the served base closure** (`system.nix`: `environment.systemPackages = [ … ] ++
toolchain`, where `toolchain = [ nixWasmClean guestClang guestCc guestCxx makeWasm
wasmAsh ]`). The *compiler* tools (clang/wasm-ld/cc/c++/make) should not ship in
the base — they should be **installed on demand exactly the way real Nix does it:
substituted from a binary cache**. (`nix` itself — `nixWasmClean` — and `ash`
— `wasmAsh`, the guest `/bin/sh` — **stay in the base**: nix is required to perform
the substitution, and ash is the shell.)

That substitution path **already exists and works**: `runtime/nix-cache.js` serves
a standard Nix binary cache (`nix-cache-info` + `<hash>.narinfo` + `nar/<hash>.nar`),
the guest's `nix.conf` already has `substituters = file:///nix-cache`, and
`nix-env -iA sl` already substitutes from it. What is missing is only (a) a flake
output that *publishes* the toolchain closure to that cache, and (b) removing the
toolchain from the base.

## Conceptual grounding (why two formats, each in its NixOS-native role)

- **NAR** serializes exactly **one store path** (one package output). It is *never*
  a whole root filesystem; a system is a **closure = many NARs + reference
  metadata**. NAR is the on-demand, one-package-at-a-time transfer unit. Using it
  to "bundle the rootfs" would be misusing it (rejected during brainstorming).
- **squashfs** is the standard way NixOS ships an entire store as one bootable
  read-only filesystem image — it is literally how every **NixOS live ISO** works
  (`nixos/modules/installer/cd-dvd/iso-image.nix` builds a squashfs of the store,
  mounts it read-only, and puts a writable overlay on top). This is the
  whole-store-as-one-artifact role.

So the design uses each format for exactly what NixOS uses it for:

| Role | Granularity | Format | Used for |
|---|---|---|---|
| Whole store as one bootable artifact | entire closure | **squashfs** | the base system |
| One package installed on demand | single store path | **NAR** + narinfo | toolchain / `nix-env -iA` |

## Architecture

```
BASE SYSTEM (present at boot)                   ON-DEMAND (installed like real Nix)
─────────────────────────────                   ────────────────────────────────────
slimmed closure: busybox/init/getty/            compiler toolchain
GTK app/fonts/ash/nix itself                    (clang/wasm-ld/cc/c++/make)
                                                + user packages
        │                                               │
   make-squashfs.nix (zstd)                       nix copy --to file://…?compression=zstd
        │                                               │
  base.squashfs (one file, compressed)           binary cache: nix-cache-info +
        │                                         narinfo + nar/   (FORMAT UNCHANGED)
  host runtime fetches blob via the                      │
  fetch/URL seam (hosted on R2, Option X);        served from R2 via nix-cache.js
  exposes as read-only virtio-blk device          (baseUrl → R2; FORMAT/PROXY UNCHANGED)
        │                                               │
  guest: mount -t squashfs /dev/vdX ─┐           guest: nix-env -iA <pkg> | nix profile
  ramfs upper ── overlay ──→ /nix   ←┘           install <pkg>  (substitute on demand)
```

### Hosting (Option X) and the download seam

The download/hosting layer is realized by **pc's disc-package system**
(`codebutler/pc` commit `24780b14`, issue #288) — we **reuse its delivery layer
but NOT its mount step**:

- **Reused (for free):** R2 hosting via `infra/preview-worker`
  (`GET /packages/<id>/<version>` with `Cross-Origin-Resource-Policy:
  cross-origin` + `Access-Control-Allow-Origin: *` + immutable cache), the in-repo
  registry entry (`bytes` + `sha256` + `version` + `url`), the **retro Setup
  wizard** UI, **sha256 verification**, **version/update checking** (prompt on a
  newer registry version), local persistence under `/Home/Library/Discs/` so it is
  **offline after first install**, and the in-flight dedup of concurrent installs.
  pc drives this through `installCore` (its pure, dependency-injected state
  machine).
- **NOT reused — the mount:** the squashfs is **not** mounted into pc's VFS as a
  `/Discs/<vol>` disc. pc injects an **identity "mount" shim** into `installCore`
  that returns the verified, persisted bytes instead of calling `mountIso`. The
  payload is the **raw `.squashfs`** image (no ISO wrapper), because **Linux
  consumes it directly**: pc hands the bytes to the nix-wasm runtime, which feeds
  them to the **virtio-blk** device, and the **guest kernel mounts squashfs** (the
  design above).
- **Cross-origin isolation:** already satisfied by the preview-worker (CORP + CORS
  on the `/packages` route); the app runs under `COEP: require-corp`.

**The seam this spec owns (nix-wasm side):** `bootNixSystem` accepts the base
squashfs as **injected bytes (an `ArrayBuffer`) or a provider** — it does NOT
hardcode a fetch. pc supplies the bytes from the disc-package system above.
For nix-wasm's **own standalone harnesses** (`runtime/demo/node/*.mjs`,
`LINUX_WASM_ARTIFACTS=…`) and local dev, `bootNixSystem` **falls back to fetching
`base.squashfs` from `baseUrl`** when no bytes are injected. So the same seam
serves both the production disc-system path (pc) and the dev/CI path (direct
fetch). The **binary cache** stays on the existing `nix-cache.js` → `baseUrl`(R2)
path (not routed through the disc system).

**Deploying a built image** (manual, until CI — see "CI publishing" below):

1. Build the reproducible image: `nix build .#wasm-base-squashfs` → a store path
   containing `base.squashfs`.
2. Compute its size + hash: `sha256sum …/base.squashfs` and `stat -c%s …`.
3. Upload to R2 via the preview-worker bucket (`--remote` is MANDATORY — without
   it wrangler 4.x writes the local simulator and the live URL 404s):
   ```sh
   bunx wrangler r2 object put \
     pc-previews/packages/nix-wasm-base/<version> \
     --file …/base.squashfs --content-type application/octet-stream --remote
   ```
4. Verify the live object:
   `curl -I https://pc-previews.eric-c6b.workers.dev/packages/nix-wasm-base/<version>`
   → expect `200`, `access-control-allow-origin: *`,
   `cross-origin-resource-policy: cross-origin`.
5. In **pc**, add/bump the `js/packages/registry.js` entry (`bytes`, `sha256`,
   `version`, `url`) and ship it; installed clients on the old version get the
   "Update Available" prompt on next launch. (The build script + registry entry +
   the `bootNixSystem` wiring live in **pc**; this spec defines the byte/seam
   contract they consume.)

The same applies to the toolchain `nix-cache/` (uploaded as a directory of
`narinfo`/`nar` objects under its own R2 prefix); `nix-cache.js`'s `baseUrl` points
at that prefix.

### CI publishing (folds in #2, Phase 5)

CI on **x86_64-linux** (fully cached nixpkgs) builds the wasm outputs and
**writes them to R2** so the guest substitutes pre-built artifacts (the caching
design goal). The publish job:

- Builds `.#wasm-base-squashfs`, `.#wasm-binary-cache`, `.#vmlinux`,
  `.#wasm-initramfs` on `x86_64-linux`.
- Uploads `base.squashfs` to `pc-previews/packages/nix-wasm-base/<version>` and
  the binary-cache tree (`nix-cache-info` + `*.narinfo` + `nar/*`) under its R2
  prefix, all via `wrangler r2 object put --remote` with the same content
  types/headers as the manual flow.
- Emits the computed `bytes` + `sha256` + `version` so the pc `registry.js` entry
  can be updated (a PR/bot or a manual copy step — the registry stays in pc, the
  source of truth for what clients fetch).
- **`version`** is the image's content hash (or a monotonic build number) so the
  immutable-cached, path-versioned R2 object is safe to cache forever and updates
  are explicit.

R2 credentials live in **CI secrets** (never in the repo). This is also where
any production **NAR signing** would happen (sign with a CI-held secret key,
publish the public key) — see the signing note under "toolchain → binary cache".

## Component changes

### 1. Build — base squashfs (`flake.nix` + a new `userspace/base-squashfs.nix`)

- New flake output `wasm-base-squashfs`, built with nixpkgs' own
  `nixos/lib/make-squashfs.nix` (the NixOS-ISO builder — maximally standard) over
  `closureInfo { rootPaths = [ wasmToplevel ]; }`, `comp = "zstd"`.
- Image lays the store at `/nix/store/...`; include the
  `var/nix/profiles/system → <toplevel>` symlink the bootstrap reads (added
  explicitly if make-squashfs does not emit it).
- **NOMMU tuning:** small squashfs block size (candidate 16–64 KiB, not the
  128 KiB default) so decompression buffers avoid large contiguous order-N
  allocations on the fragmented NOMMU heap (same allocation class as the order-11
  window-buffer saga). Final value chosen during the spike by measuring boot.
- Reproducible (make-squashfs already builds deterministically for the ISO).

### 2. Build — toolchain → binary cache (`flake.nix`; folds in #2 + #1)

- New flake output `wasm-binary-cache`: `nix copy --to
  "file://$out?compression=zstd"` of the **compiler-toolchain** closure
  `[ guestClang guestCc guestCxx makeWasm ]` (plus existing demo pkgs e.g. `sl`).
  Produces standard `nix-cache-info` + `narinfo` + `nar/`. (`nixWasmClean`/`nix`
  and `wasmAsh`/`ash` are NOT published here — they remain in the base squashfs.)
- **#1 fold-in:** include real `.drv`s in the published closure so
  `nix profile install` works, not just `nix-env -iA` (the cache must not be an
  `outPath`-only "fake derivation" index).
- **Signing:** production signing happens in **CI** (sign with a CI-held secret
  key, publish the public key, add it to the guest's `trusted-public-keys` in
  `nix.conf`) — a reproducible in-derivation key isn't feasible. For local dev/CI
  fixtures the file cache is trusted via `require-sigs = false`. See "CI
  publishing".
- Ship a `pkgs.nix` in the cache exposing the toolchain attrs (and a `dev-tools`
  meta-attr) so `nix-env -iA dev-tools` / `nix-env -iA clang` resolves to
  substitutable paths. (`bootstrap.nix` already copies `/nix-cache/pkgs.nix` to
  `~/.nix-defexpr`.)

### 3. Kernel (`kernel.nix`; possibly `patches/kernel/0013` transport tweak)

- Add to the `scripts/config` toggle list: `CONFIG_BLOCK`, `CONFIG_VIRTIO_BLK`,
  `CONFIG_SQUASHFS`, `CONFIG_SQUASHFS_ZSTD`, `CONFIG_ZSTD_DECOMPRESS` (verify each
  survives `olddefconfig` on NOMMU — some are silently dropped without a gate, per
  the SHMEM/TMPFS precedent).
- Likely a new `VW_DEV_BLK` device id in the `virtio_wasm` transport patch (0013),
  mirroring `VW_DEV_NET`.
- **mmap-for-exec is already covered** by `patches/kernel/0016-wasm-nommu-ro-shared-
  mmap-copy.patch` (fs-agnostic read-only file mmap satisfied via a private RAM
  copy through the page cache). Verify squashfs uses the generic filemap mmap path.
  This was the principal risk and is de-risked. vmlinux-only rebuild.

### 4. Runtime (`runtime/`)

- New `runtime/virtio/blk-device.js`: a **read-only virtio-blk** device model over
  the existing `virtio_wasm` transport, backed by the fetched squashfs
  `ArrayBuffer` (serves sector reads as buffer slices). Mirrors `net-device.js` /
  `wl-device.js` structure (`vring.js`, `shared-queues.js`).
- Wire into `boot.js` (register the blk device) and `boot-nix-system.js` (obtain
  the base squashfs via the **injected-bytes-or-fallback-fetch seam** above and
  construct the device). `bootNixSystem` accepts `opts.squashfs` (an `ArrayBuffer`
  or a `() => Promise<ArrayBuffer>` provider, supplied by pc's disc-package
  system); when absent it falls back to fetching `base.squashfs` from `baseUrl`
  (the standalone-harness/dev/CI path).
- **Delete** `runtime/nix-closure-store.js` + `runtime/nix-closure-store.test.js`;
  remove the `nix` 9P export and its `boot.js` wiring.
- `runtime/nix-cache.js` is **unchanged**; its `baseUrl` is pointed at the R2
  cache.
- Host holds the compressed image (~tens of MB) in JS memory; the guest reads
  blocks on demand → page cache (decompressed pages are evictable guest RAM, not a
  permanent copy of the whole image). HTTP-range lazy block fetch is noted as a
  **future optimization**, not in scope (Option X + the download system may also
  address this below the seam).

### 5. Boot (`userspace/bootstrap.nix`)

- Swap the lowerdir source: replace the `aname=nix` 9P mount with
  `mount -t squashfs -o ro /dev/vdX /mnt/nix-ro`; keep the identical ramfs-upper
  overlay → `/nix`. Keep the `/nix-cache` (substituter) and `/mnt/pc` 9P mounts
  as-is. Resolve the exact `/dev/vdX` node from virtio-blk enumeration (devtmpfs).

### 6. Vendoring / pc

- The base squashfs is delivered via the **disc-package system** (R2, downloaded
  on demand, persisted in `/Home/Library/Discs/`) → pc **no longer vendors**
  `store.json`/`store-content` into git. The GitHub 100 MB limit no longer applies.
  The pc-side consumer (registry entry + a build/upload step + the `installCore`
  identity-mount shim feeding `bootNixSystem`) lives in **pc** as a follow-up; this
  spec defines the byte/seam contract it consumes.
- The toolchain `nix-cache/` lives on R2 (its own prefix); `nix-cache.js` `baseUrl`
  points at it. Not git-vendored.
- Update `runtime/sync-to-pc.sh`: add `virtio/blk-device.js` to the engine file
  list; drop `nix-closure-store.js`.
- Update artifact-layout docs; the `store-content/` blob-dir naming note becomes
  obsolete (the lazy-blob mechanism is replaced by squashfs blocks + the NAR cache).

## Testing & acceptance

- **Engine unit test** for `blk-device.js`: sector reads return the right buffer
  slices; out-of-range / write attempts behave correctly.
- **Boot smoke** (`runtime/demo/node/smoke.mjs`): boot → mount squashfs → overlay
  `/nix` → `nix-env -iA sl` substitutes from the (R2 or local) cache and renders
  (Phase A + B still PASS).
- **New end-to-end proof of the goal:** in the base, `which clang` *fails*; then
  `nix-env -iA dev-tools` (or `nix profile install`) substitutes the toolchain from
  the cache; then `cc hello.c && ./hello` works in-guest. This validates "install
  dev tools exactly like real Nix" and exercises the #1 (`nix profile install`)
  fix.
- **Size assertion:** `base.squashfs` is materially smaller than the old 348 MB
  set, and the base no longer contains the toolchain closure.
- All four runtime CI gates pass (`bun run test`, `lint`, `format:check`,
  `typecheck`).

### Acceptance mapping to #43

- *Host artifact scales with real content, robust to bloat* — squashfs (content-
  scaled, compressed) replaces the count-scaling base64 manifest; a stray dead ref
  inflates the image by its real compressed size, not by N inline base64 entries.
- *No giant JSON parsed into memory at boot* — `store.json` is deleted; the guest
  mounts a real filesystem.
- *Keep the lazy-fetch property (never compile → never download clang)* — preserved
  by **construction**: the toolchain is not in the base at all; it is substituted
  only on first `nix-env -iA`.

## Sequencing (spike first)

PRIME DIRECTIVE: prove the risky chain before building the pipeline.

1. **Spike (gating):** enable `CONFIG_BLOCK`/`VIRTIO_BLK`/`SQUASHFS`/
   `SQUASHFS_ZSTD`; write a minimal `blk-device.js`; `mksquashfs` a *tiny* test
   closure; boot → `mount -t squashfs` → `cat` a file → **mmap-exec a binary off
   it**. Proves kernel + runtime + NOMMU-mmap end-to-end. Tune squashfs block size
   here. Any squashfs-on-NOMMU surprise surfaces before further investment.
2. Base squashfs build (`make-squashfs`, block-size tuning, profile symlink).
3. Production `blk-device.js` + boot wiring; delete `nix-closure-store.js`.
4. `bootstrap.nix` mount swap.
5. Toolchain → binary cache (publish output, real `.drv`s, signing, `pkgs.nix`);
   remove the **compiler** toolchain (`guestClang`/`guestCc`/`guestCxx`/`makeWasm`)
   from `systemPackages` while keeping `nix` + `ash`; point cache `baseUrl` at R2.
6. Vendoring (`sync-to-pc.sh`, docs, pc consumption of R2-pinned artifacts).
7. Tests + acceptance gates + CLAUDE.md update.

## Resolved decisions

- **Decompressor:** zstd (fast, good ratio, well-supported in squashfs).
- **Block device transport:** virtio-blk over the existing `virtio_wasm` transport
  (reuse the established device-model pattern), not a bespoke device.
- **Cache signing:** in CI (CI-held secret key + published public key in
  `trusted-public-keys`); `require-sigs = false` for local dev/CI fixtures.
- **Base hosting / download:** Option X via **pc's disc-package system** (commit
  `24780b14`, #288) — reuse its R2 hosting, Setup wizard, sha256 verify, update
  checking, and offline persistence, but **inject an identity mount** so the raw
  `.squashfs` is consumed directly by Linux (virtio-blk), **not** mounted into pc's
  VFS. nix-wasm seam: `bootNixSystem` accepts injected bytes/provider, else
  fetches `base.squashfs` from `baseUrl`.
- **Publishing:** CI on x86_64-linux builds the wasm outputs and writes them to R2
  (`wrangler r2 object put --remote`), versioned by content hash; the pc
  `registry.js` entry is updated with the emitted `bytes`/`sha256`/`version`.

## Out of scope

- The pc-side consumer wiring (the `registry.js` entry, the build/upload script,
  and the `installCore` identity-mount shim that feeds `bootNixSystem`) — lives in
  **pc** as a follow-up; this spec defines the byte/seam contract it consumes.
- HTTP-range lazy block fetch for the base image (future optimization).
- Migrating the toolchain `nix-cache/` itself into the disc-package system (it
  stays on the `nix-cache.js` → R2 `baseUrl` path for now).
