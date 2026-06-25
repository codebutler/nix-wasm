# Linux Bundle Channel (pc#315) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle the guest boot trio (vmlinux+initramfs+squashfs) into one reproducible, versioned `linux.iso`, move the lazy nix-cache to R2, and serve both through a `latest.json` channel guarded by an engine-ABI marker — so republishing a guest needs no pc code change or deploy.

**Architecture:** A nix-wasm derivation `.#linux-image` grafts the three artifacts + a `manifest.json` (carrying `minEngine`) into an iso9660 image via nixpkgs' standard `make-iso9660-image`. pc downloads that image once via the existing disc-installer machinery, mounts it, reads the three members out, and boots from the bytes via a new bytes-mode in the engine's `bootNixSystem`. A `latest.json` pointer (served `no-cache`) names the current immutable version + `minEngine` + the nix-cache base URL; pc refuses to boot when its vendored `ENGINE_ABI < minEngine`, showing a "reload pc" message instead of a silent crash.

**Tech Stack:** Nix (flakes), `nixos/lib/make-iso9660-image.nix` (xorriso), JS ES modules (the vendored `runtime/` engine, pc app code), bun test, Cloudflare Worker + R2 (`wrangler`).

## Global Constraints

- **Two repos.** nix-wasm at `/home/vbvntv/Code/nix-wasm` (branch `linux-channel-315`, already created off `master`); pc at `/home/vbvntv/Code/pc` (create branch `linux-channel-315` off `main` before any pc task).
- **The engine is upstream from nix-wasm.** Edit engine JS only under `nix-wasm/runtime/`, then run `runtime/sync-to-pc.sh <pc-path>` to vendor it into pc. Never hand-edit `pc/vendor/linux-wasm/runtime/`.
- **nix-wasm PRIME DIRECTIVE:** every artifact is a reproducible derivation; no stubs/shortcuts. Guard any overlay/derivation change so native packages stay cached.
- **`WASM_GUEST_ABI` single source of truth:** the integer lives ONCE in `runtime/abi.js` as `export const ENGINE_ABI = N;`. The image's `minEngine` is parsed from that same file. Bump only on a real engine↔guest ABI break.
- **nix build invocation:** `export NIX_CONFIG="experimental-features = nix-command flakes"` then `echo <pw> | sudo -S nix build …` (sudo password is in agent memory; `sudo -E` does not pass the inline config here — use `NIX_CONFIG` env or `--extra-experimental-features`). Run each `sudo nix` as its own command.
- **pc tests:** `bun test js/` (only discovers tests under `js/`). pc lint/format/type gates: `bun run lint` / `bun run format:check` / `bun run typecheck` — zero warnings.
- **nix-wasm runtime tests:** `cd runtime && bun run test`. Plus `bun run lint`, `bun run format:check`, `bun run typecheck` must stay green.
- **R2 host:** `https://pc-previews.eric-c6b.workers.dev`. `wrangler r2 object put` MUST pass `--remote` (without it writes to the local sim and the live URL 404s).
- **Channel path layout (R2):** `packages/linux/<v>/linux.iso`, `packages/linux/<v>/nix-cache/<relpath>`, mutable pointer `packages/linux/latest.json`.

---

## File Structure

**nix-wasm:**
- Create `runtime/abi.js` — the `ENGINE_ABI` constant (single source of truth).
- Create `runtime/abi.test.js` — asserts the export is a positive integer.
- Modify `runtime/index.js` — re-export `ENGINE_ABI`.
- Modify `runtime/boot-nix-system.js` — add artifacts-by-bytes mode + `nixCacheBaseUrl` + a `_bootLinux` test seam.
- Create `runtime/boot-nix-system.test.js` — bytes-mode + baseUrl-mode wiring.
- Modify `runtime/sync-to-pc.sh` — include `abi.js` in the synced file set.
- Create `userspace/linux-image.nix` — the `.#linux-image` derivation.
- Modify `flake.nix` — wire `linuxImage` + expose `linux-image`.
- Modify `CLAUDE.md` — runbook pointer + `init.nix → toplevel.nix → base.squashfs` mapping.

**pc:**
- Modify `infra/preview-worker/src/index.js` — `no-cache` for `*/latest.json`.
- Create `js/packages/linux-channel.js` — `resolveLinuxChannel` + `ensureLinuxImage` + `EngineTooOldError`.
- Create `js/packages/linux-channel.test.js` — resolve (online/offline) + ABI guard.
- Modify `js/linux/kernel-service.js` — boot from the channel image (bytes-mode); drop `ARTIFACTS_BASE`.
- Modify `js/packages/registry.js` — remove the static `linux-base` entry.
- Modify `vendor/linux-wasm/SOURCE.md` — the "Republish the guest" runbook.
- Modify `.claude/rules/disc-packages.md` — carve out `linux` as the cross-repo channel package.
- Delete `vendor/linux-wasm/{vmlinux.wasm, initramfs.cpio.gz, nix-cache/}`.

---

## Task 1: Engine ABI constant (`runtime/abi.js`)

**Files:**
- Create: `/home/vbvntv/Code/nix-wasm/runtime/abi.js`
- Create: `/home/vbvntv/Code/nix-wasm/runtime/abi.test.js`
- Modify: `/home/vbvntv/Code/nix-wasm/runtime/index.js`
- Modify: `/home/vbvntv/Code/nix-wasm/runtime/sync-to-pc.sh`

**Interfaces:**
- Produces: `export const ENGINE_ABI: number` from `runtime/abi.js` and re-exported from `runtime/index.js`. Consumed by Task 2 (`linux-image.nix` parses the file) and pc Task 5 (`linux-channel.js` imports it).

- [ ] **Step 1: Write the failing test**

Create `/home/vbvntv/Code/nix-wasm/runtime/abi.test.js` (match the import style of the existing `runtime/*.test.js`; they use `bun:test`):

```js
import { test, expect } from "bun:test";
import { ENGINE_ABI } from "./index.js";
import { ENGINE_ABI as DIRECT } from "./abi.js";

test("ENGINE_ABI is a positive integer, exported from index and abi", () => {
  expect(Number.isInteger(ENGINE_ABI)).toBe(true);
  expect(ENGINE_ABI).toBeGreaterThanOrEqual(1);
  expect(DIRECT).toBe(ENGINE_ABI);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd /home/vbvntv/Code/nix-wasm/runtime && bun test abi.test.js`
Expected: FAIL — `Cannot find module './abi.js'` (and `ENGINE_ABI` undefined from index).

- [ ] **Step 3: Create `runtime/abi.js`**

```js
// abi.js — the SINGLE SOURCE OF TRUTH for the guest↔engine ABI version (pc#315).
//
// Bump ENGINE_ABI by 1 ONLY on a real, incompatible change to the
// kernel/guest ↔ engine-JS contract (exec ABI, syscall/loader stubs, the
// virtio/9P device models). The published guest image (`.#linux-image`) stamps
// THIS number as its `manifest.json` + `latest.json` `minEngine`. pc refuses to
// boot an image whose `minEngine` exceeds the vendored engine's ENGINE_ABI,
// surfacing a "reload pc" message instead of a silent boot crash.
//
// `userspace/linux-image.nix` parses this exact line, so keep the form
// `export const ENGINE_ABI = <int>;` on one line.
export const ENGINE_ABI = 1;
```

- [ ] **Step 4: Re-export from `runtime/index.js`**

Add this line to `/home/vbvntv/Code/nix-wasm/runtime/index.js` (after the existing `export … from "./boot-nix-system.js";` line):

```js
export { ENGINE_ABI } from "./abi.js";
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd /home/vbvntv/Code/nix-wasm/runtime && bun test abi.test.js`
Expected: PASS.

- [ ] **Step 6: Add `abi.js` to the engine sync set**

In `/home/vbvntv/Code/nix-wasm/runtime/sync-to-pc.sh`, the engine-files `cp` line currently reads:

```bash
cp "$SRC"/{index.js,boot.js,boot-nix-system.js,session.js,nix-cache.js,nix-store.js,kernel-host.js,kernel-worker.js,make-worker.js} "$DEST/"
```

Change it to include `abi.js`:

```bash
cp "$SRC"/{index.js,abi.js,boot.js,boot-nix-system.js,session.js,nix-cache.js,nix-store.js,kernel-host.js,kernel-worker.js,make-worker.js} "$DEST/"
```

- [ ] **Step 7: Lint/format/typecheck the runtime**

Run: `cd /home/vbvntv/Code/nix-wasm/runtime && bun run lint && bun run format:check && bun run typecheck`
Expected: all pass. (If `format:check` flags `abi.js`, run `bun run format` and re-stage.)

- [ ] **Step 8: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm
git add runtime/abi.js runtime/abi.test.js runtime/index.js runtime/sync-to-pc.sh
git commit -m "feat(runtime): ENGINE_ABI source-of-truth constant (pc#315)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014MS8ahGs6dekxerZDeqXPp"
```

---

## Task 2: `.#linux-image` derivation

**Files:**
- Create: `/home/vbvntv/Code/nix-wasm/userspace/linux-image.nix`
- Modify: `/home/vbvntv/Code/nix-wasm/flake.nix`

**Interfaces:**
- Consumes: `runtime/abi.js` `ENGINE_ABI` (parsed at eval time); the existing `kernel` (`$out/vmlinux.wasm`), `wasmInitramfs` (`$out/initramfs.cpio.gz`), `wasmBaseSquashfs` (`$out/base.squashfs`).
- Produces: `.#linux-image` → an output containing `linux.iso` (an iso9660 image holding `/vmlinux.wasm`, `/initramfs.cpio.gz`, `/base.squashfs`, `/manifest.json`). `manifest.json` = `{"version":N,"minEngine":M}`.

- [ ] **Step 1: Write the derivation**

Create `/home/vbvntv/Code/nix-wasm/userspace/linux-image.nix`:

```nix
# linux-image.nix — the single versioned `linux` boot bundle (pc#315). ONE
# iso9660 image grafting the three boot artifacts plus a manifest, built with
# nixpkgs' standard make-iso9660-image (xorriso → reproducible). pc downloads it
# once via the disc installer, mounts it, reads the members out, and boots from
# the bytes. The compiler toolchain (nix-cache) is NOT in here — it stays a
# lazily-fetched R2 cache so opening a shell/GUI app doesn't pull the ~29 MB
# toolchain. See docs/superpowers/specs/2026-06-24-linux-bundle-channel-design.md.
{ pkgs, nixpkgs, kernel, initramfs, squashfs, version ? 1 }:
let
  lib = pkgs.lib;

  # minEngine is parsed from runtime/abi.js so it can never drift from the engine
  # ENGINE_ABI the JS actually implements. Match on the single canonical line.
  abiLine = lib.findFirst (l: lib.hasInfix "ENGINE_ABI" l) null
    (lib.splitString "\n" (builtins.readFile ../runtime/abi.js));
  abiMatch = builtins.match ".*ENGINE_ABI = ([0-9]+);.*" abiLine;
  minEngine = lib.toInt (builtins.head (lib.throwIf (abiMatch == null)
    "linux-image.nix: could not parse ENGINE_ABI from runtime/abi.js" abiMatch));

  manifest = pkgs.writeText "manifest.json"
    (builtins.toJSON { inherit version minEngine; });

  makeIso = pkgs.callPackage "${nixpkgs}/nixos/lib/make-iso9660-image.nix" { };
in
makeIso {
  isoName = "linux.iso";
  volumeID = "LINUX";
  contents = [
    { source = "${kernel}/vmlinux.wasm";         target = "/vmlinux.wasm"; }
    { source = "${initramfs}/initramfs.cpio.gz";  target = "/initramfs.cpio.gz"; }
    { source = "${squashfs}/base.squashfs";       target = "/base.squashfs"; }
    { source = manifest;                           target = "/manifest.json"; }
  ];
}
```

- [ ] **Step 2: Wire it into `flake.nix`**

In the `let` block of `/home/vbvntv/Code/nix-wasm/flake.nix`, after the `wasmBinaryCache = …;` block (around line 367), add:

```nix
      # ---- the single versioned `linux` boot bundle (pc#315) ----------------
      # vmlinux + initramfs + squashfs + manifest(minEngine) as one iso9660
      # image. Downloaded once by pc via the disc installer, mounted, and booted
      # from the bytes. nix-cache stays a separate lazy R2 cache.
      linuxImage = import ./userspace/linux-image.nix {
        inherit pkgs nixpkgs kernel;
        initramfs = wasmInitramfs;
        squashfs = wasmBaseSquashfs;
      };
```

Then in `packages.${system}`, after the `wasm-binary-cache = wasmBinaryCache;` line (around line 511), add:

```nix
        # The single versioned `linux` boot bundle (pc#315): $out/iso/linux.iso.
        linux-image = linuxImage;
```

- [ ] **Step 3: Build it**

Run:
```bash
cd /home/vbvntv/Code/nix-wasm
export NIX_CONFIG="experimental-features = nix-command flakes"
echo <sudo-pw> | sudo -S nix build .#linux-image --print-out-paths
```
Expected: a store path prints (the `kernel`/`initramfs`/`squashfs` inputs should already be cached; only the small iso build runs).

- [ ] **Step 4: Verify the image contents + the stamped minEngine**

Run (substitute the printed `<out>`):
```bash
ISO=$(ls <out>/iso/*.iso 2>/dev/null || ls <out>/*.iso)
echo "iso: $ISO"
xorriso -indev "$ISO" -find / 2>/dev/null    # lists /vmlinux.wasm /initramfs.cpio.gz /base.squashfs /manifest.json
xorriso -osirrox on -indev "$ISO" -extract /manifest.json /tmp/manifest.json 2>/dev/null && cat /tmp/manifest.json
```
Expected: all four members listed (note the exact `$out` path of the `.iso` — likely `$out/iso/linux.iso`; record it for the publish runbook), and `manifest.json` = `{"minEngine":1,"version":1}`.

- [ ] **Step 5: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm
git add userspace/linux-image.nix flake.nix
git commit -m "feat: .#linux-image — single versioned linux boot bundle (pc#315)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014MS8ahGs6dekxerZDeqXPp"
```

---

## Task 3: Engine `bootNixSystem` bytes-mode

**Files:**
- Modify: `/home/vbvntv/Code/nix-wasm/runtime/boot-nix-system.js`
- Create: `/home/vbvntv/Code/nix-wasm/runtime/boot-nix-system.test.js`

**Interfaces:**
- Consumes: existing `bootLinux` (from `./boot.js`) and `createNixCacheExport` (from `./nix-cache.js`).
- Produces: `bootNixSystem(opts)` additionally accepts `opts.vmlinux` / `opts.initramfs` (`ArrayBuffer | Blob`), `opts.nixCacheBaseUrl` (`string`), and `opts._bootLinux` (test seam). When `vmlinux`/`initramfs` are given they become `blob:` URLs; when `nixCacheBaseUrl` is given it overrides the baseUrl-derived nix-cache. `baseUrl` becomes optional. Consumed by pc Task 6.

- [ ] **Step 1: Write the failing test**

Create `/home/vbvntv/Code/nix-wasm/runtime/boot-nix-system.test.js`:

```js
import { test, expect } from "bun:test";
import { bootNixSystem } from "./boot-nix-system.js";

test("bytes-mode: vmlinux/initramfs become blob URLs; nixCacheBaseUrl drives the cache", async () => {
  let captured;
  const _bootLinux = async (args) => {
    captured = args;
    return { ok: true };
  };
  await bootNixSystem({
    vfs: {},
    vmlinux: new Uint8Array([0, 1, 2]),
    initramfs: new Uint8Array([3, 4, 5]),
    squashfs: new ArrayBuffer(8),
    nixCacheBaseUrl: "https://example.test/nc",
    _bootLinux,
  });
  expect(captured.vmlinuxUrl.startsWith("blob:")).toBe(true);
  expect(captured.initrdUrl.startsWith("blob:")).toBe(true);
  expect(captured.squashfs.byteLength).toBe(8);
  expect(typeof captured.nixCache.readBlob).toBe("function");
});

test("baseUrl-mode still derives artifact URLs from baseUrl", async () => {
  let captured;
  const _bootLinux = async (args) => {
    captured = args;
    return {};
  };
  await bootNixSystem({
    vfs: {},
    baseUrl: "https://x.test/art",
    squashfs: new ArrayBuffer(1),
    _bootLinux,
  });
  expect(captured.vmlinuxUrl).toBe("https://x.test/art/vmlinux.wasm");
  expect(captured.initrdUrl).toBe("https://x.test/art/initramfs.cpio.gz");
});

test("nix:false skips squashfs + nixCache", async () => {
  let captured;
  const _bootLinux = async (args) => {
    captured = args;
    return {};
  };
  await bootNixSystem({
    vfs: {},
    vmlinux: new Uint8Array([1]),
    initramfs: new Uint8Array([2]),
    nix: false,
    _bootLinux,
  });
  expect(captured.squashfs).toBeUndefined();
  expect(captured.nixCache).toBeUndefined();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd /home/vbvntv/Code/nix-wasm/runtime && bun test boot-nix-system.test.js`
Expected: FAIL (bytes-mode not implemented; `vmlinuxUrl` would be derived from a missing baseUrl → throws or wrong value).

- [ ] **Step 3: Rewrite `boot-nix-system.js`**

Replace the whole body of `/home/vbvntv/Code/nix-wasm/runtime/boot-nix-system.js` with:

```js
// boot-nix-system.js — the high-level boot every consumer uses. Two artifact
// sources:
//   • bytes-mode (pc#315): the caller passes vmlinux/initramfs/squashfs bytes
//     (read out of the mounted `linux` image — offline-capable) and a
//     `nixCacheBaseUrl` (the lazy R2 toolchain cache).
//   • baseUrl-mode (standalone harnesses/dev/CI): everything is fetched from a
//     single baseUrl holding vmlinux.wasm / initramfs.cpio.gz / base.squashfs /
//     nix-cache/.
// Returns the same handle as bootLinux.
//
// NOTE: bytes-mode uses URL.createObjectURL + fetch(blob:) — available in the
// browser/worker (where pc runs) and in bun; not in plain Node. Node harnesses
// use baseUrl-mode.
import { bootLinux } from "./boot.js";
import { createNixCacheExport } from "./nix-cache.js";

/**
 * @param {{
 *   vfs: any,
 *   baseUrl?: string|URL,             // baseUrl-mode: dir holding the artifacts
 *   vmlinux?: ArrayBuffer|Blob,       // bytes-mode: kernel wasm bytes
 *   initramfs?: ArrayBuffer|Blob,     // bytes-mode: initramfs.cpio.gz bytes
 *   squashfs?: ArrayBuffer | (() => Promise<ArrayBuffer>),
 *   nixCacheBaseUrl?: string,         // bytes-mode: the lazy nix-cache base URL
 *   onModuleCached?: () => void,
 *   consoleCount?: number,
 *   cmdline?: string,
 *   onLog?: (text: string) => void,
 *   nix?: boolean,                    // default true; false → busybox-only, no /nix
 *   wayland?: { sendOut: (clientId:number, buffer:Uint8Array, fds:Uint8Array[])=>void, onClose?: (clientId:number)=>void },
 *   _bootLinux?: typeof bootLinux,    // test seam
 * }} opts
 * @returns {ReturnType<import('./boot.js').bootLinux>}
 */
export async function bootNixSystem(opts) {
  const bl = opts._bootLinux || bootLinux;
  const useNix = opts.nix !== false;

  const hasBaseUrl = opts.baseUrl != null;
  const base = hasBaseUrl
    ? new URL(
        String(opts.baseUrl).endsWith("/") ? String(opts.baseUrl) : String(opts.baseUrl) + "/",
        "file:///",
      )
    : null;
  const u = (p) => new URL(p, base).href;

  const toUrl = (bytesOrBlob) =>
    URL.createObjectURL(bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob]));

  const vmlinuxUrl = opts.vmlinux != null ? toUrl(opts.vmlinux) : u("vmlinux.wasm");
  const initrdUrl = opts.initramfs != null ? toUrl(opts.initramfs) : u("initramfs.cpio.gz");

  // The base store squashfs: caller-provided bytes (pc) or fetched from baseUrl.
  let squashfs;
  if (useNix) {
    if (typeof opts.squashfs === "function") squashfs = await opts.squashfs();
    else if (opts.squashfs) squashfs = opts.squashfs;
    else squashfs = await (await fetch(u("base.squashfs"))).arrayBuffer();
  }

  const nixCacheBase =
    opts.nixCacheBaseUrl != null ? opts.nixCacheBaseUrl : hasBaseUrl ? u("nix-cache") : null;

  return bl({
    vfs: opts.vfs,
    vmlinuxUrl,
    initrdUrl,
    consoleCount: opts.consoleCount,
    cmdline: opts.cmdline,
    onLog: opts.onLog,
    onModuleCached: opts.onModuleCached,
    wayland: opts.wayland,
    squashfs,
    nixCache: useNix && nixCacheBase ? createNixCacheExport(nixCacheBase) : undefined,
  });
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/vbvntv/Code/nix-wasm/runtime && bun test boot-nix-system.test.js`
Expected: PASS (all three tests).

- [ ] **Step 5: Run the full runtime suite + static gates**

Run: `cd /home/vbvntv/Code/nix-wasm/runtime && bun run test && bun run lint && bun run format:check && bun run typecheck`
Expected: all green (the existing 72+ tests unaffected; baseUrl-mode is preserved).

- [ ] **Step 6: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm
git add runtime/boot-nix-system.js runtime/boot-nix-system.test.js
git commit -m "feat(runtime): bootNixSystem bytes-mode + nixCacheBaseUrl (pc#315)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014MS8ahGs6dekxerZDeqXPp"
```

---

## Task 4: preview-worker `no-cache` for `latest.json`

**Files:**
- Modify: `/home/vbvntv/Code/pc/infra/preview-worker/src/index.js`

**Interfaces:**
- Produces: the `packages/` route serves any key ending `/latest.json` with `Cache-Control: no-cache`; all other `packages/*` objects keep `…immutable`.

> First create the pc branch: `cd /home/vbvntv/Code/pc && git checkout main && git pull --rebase && git checkout -b linux-channel-315`.

- [ ] **Step 1: Edit the packages route**

In `/home/vbvntv/Code/pc/infra/preview-worker/src/index.js`, the `if (layer === "packages") { … }` block currently returns:

```js
      return withHeaders(obj.body, { status: 200 }, key, {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        ETag: obj.httpEtag,
      });
```

Replace it with a pointer-aware Cache-Control:

```js
      // The channel pointer (packages/<id>/latest.json) is MUTABLE — overwritten
      // on every republish — so it must not be cached; the versioned .iso / nar
      // objects under it stay immutable.
      const isPointer = key.endsWith("/latest.json");
      return withHeaders(obj.body, { status: 200 }, key, {
        "Cache-Control": isPointer
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        ETag: obj.httpEtag,
      });
```

- [ ] **Step 2: Verify the change is self-consistent (review)**

Run: `cd /home/vbvntv/Code/pc && git diff infra/preview-worker/src/index.js`
Expected: only the Cache-Control block changed; `isPointer` true ⇒ `no-cache`, else immutable. (The Worker has no `bun test js/` coverage; it is verified live via `curl -I` after deploy in Task 9.)

- [ ] **Step 3: Commit**

```bash
cd /home/vbvntv/Code/pc
git add infra/preview-worker/src/index.js
git commit -m "feat(preview-worker): no-cache for channel latest.json pointers (#315)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Task 5: pc channel resolver (`js/packages/linux-channel.js`)

**Files:**
- Create: `/home/vbvntv/Code/pc/js/packages/linux-channel.js`
- Create: `/home/vbvntv/Code/pc/js/packages/linux-channel.test.js`

**Interfaces:**
- Consumes: `ENGINE_ABI` from `../../vendor/linux-wasm/runtime/index.js`; `installCore` from `./install.js`; VFS (`stat`/`readBlob`/`write`/`mkdir` via `../vfs/index.js`); `mountIso`/`ejectBySourceId` from `../vfs/iso-mount.js`; `verifyBytes` from `./verify.js`; the installer UI from the `installer` app module.
- Produces:
  - `resolveLinuxChannel({ fetchImpl?, stat? }) → Promise<{ entry, minEngine, nixCacheBaseUrl, offline }>` — `entry` is a disc-installer `PackageEntry` (`{pkgId:"linux", isoName:"linux.iso", url, bytes, sha256, version, volumeName}`).
  - `ensureLinuxImage(deps?) → Promise<{ vmlinux: Blob, initramfs: Blob, squashfs: ArrayBuffer, nixCacheBaseUrl: string|null }>` — runs the ABI guard, installs+mounts the image, returns the three members + cache URL.
  - `class EngineTooOldError extends Error` (`.have`, `.need`).
- Consumed by pc Task 6 (`kernel-service.js`).

- [ ] **Step 1: Write the failing tests**

Create `/home/vbvntv/Code/pc/js/packages/linux-channel.test.js`:

```js
import { test, expect } from "bun:test";
import { resolveLinuxChannel, ensureLinuxImage, EngineTooOldError } from "./linux-channel.js";

const LATEST = {
  version: 2,
  image: { url: "https://h/packages/linux/2/linux.iso", bytes: 123, sha256: "ab" },
  nixCacheBaseUrl: "https://h/packages/linux/2/nix-cache",
  minEngine: 1,
};

function jsonResp(obj) {
  return { ok: true, json: async () => obj };
}

test("resolveLinuxChannel (online) builds a disc entry from latest.json", async () => {
  const fetchImpl = async () => jsonResp(LATEST);
  const r = await resolveLinuxChannel({ fetchImpl, stat: async () => null });
  expect(r.offline).toBe(false);
  expect(r.entry.pkgId).toBe("linux");
  expect(r.entry.isoName).toBe("linux.iso");
  expect(r.entry.url).toBe(LATEST.image.url);
  expect(r.entry.version).toBe(2);
  expect(r.entry.sha256).toBe("ab");
  expect(r.minEngine).toBe(1);
  expect(r.nixCacheBaseUrl).toBe(LATEST.nixCacheBaseUrl);
});

test("resolveLinuxChannel (offline) falls back to the installed version", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const stat = async (p) =>
    p.endsWith("linux.iso") ? { id: "x", pkgVersion: 7, size: 999 } : null;
  const r = await resolveLinuxChannel({ fetchImpl, stat });
  expect(r.offline).toBe(true);
  expect(r.entry.version).toBe(7);
});

test("resolveLinuxChannel (offline, nothing installed) rethrows", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  await expect(resolveLinuxChannel({ fetchImpl, stat: async () => null })).rejects.toThrow(
    "offline",
  );
});

test("ensureLinuxImage throws EngineTooOldError when minEngine > ENGINE_ABI", async () => {
  const resolve = async () => ({
    entry: { pkgId: "linux", isoName: "linux.iso", version: 9 },
    minEngine: 99999,
    nixCacheBaseUrl: "https://h/nc",
    offline: false,
  });
  await expect(ensureLinuxImage({ _resolve: resolve })).rejects.toBeInstanceOf(EngineTooOldError);
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `cd /home/vbvntv/Code/pc && bun test js/packages/linux-channel.test.js`
Expected: FAIL — `Cannot find module './linux-channel.js'`.

- [ ] **Step 3: Implement `linux-channel.js`**

Create `/home/vbvntv/Code/pc/js/packages/linux-channel.js`:

```js
// linux-channel.js — resolve + install the single versioned `linux` guest image
// (pc#315). Replaces the static `linux-base` registry row with a latest.json
// channel so republishing a guest needs no pc deploy. The image is ONE .iso
// (vmlinux + initramfs + squashfs + manifest); we install it via the existing
// disc machinery, mount it, and read the three members out for the engine's
// bytes-mode boot. The compiler toolchain (nix-cache) is fetched lazily from
// `nixCacheBaseUrl`, not bundled. See
// nix-wasm/docs/superpowers/specs/2026-06-24-linux-bundle-channel-design.md.

import { ENGINE_ABI } from "../../vendor/linux-wasm/runtime/index.js";
import { installCore } from "./install.js";

const CHANNEL_URL = "https://pc-previews.eric-c6b.workers.dev/packages/linux/latest.json";
const ISO_NAME = "linux.iso";
const DISCS_DIR = "/Home/Library/Discs";
// A tiny sidecar persisted next to the .iso so an OFFLINE boot still knows the
// nix-cache URL the image was published with (the .iso itself carries only the
// guest data, not the channel metadata).
const SIDECAR = `${DISCS_DIR}/linux.channel.json`;

export class EngineTooOldError extends Error {
  /** @param {number} have @param {number} need */
  constructor(have, need) {
    super(
      `A newer Linux system is available — reload pc to update. ` +
        `(engine ABI ${have}, image needs ${need})`,
    );
    this.name = "EngineTooOldError";
    this.have = have;
    this.need = need;
  }
}

/**
 * Resolve the channel pointer → a disc-installer entry + boot metadata. Online:
 * fetch latest.json. Offline (fetch fails): reuse the installed version so a
 * previously installed guest still boots; rethrow if nothing is installed.
 * @param {{ fetchImpl?: typeof fetch, stat?: (p:string)=>Promise<any> }} [opts]
 */
export async function resolveLinuxChannel({ fetchImpl = fetch, stat } = {}) {
  try {
    const resp = await fetchImpl(CHANNEL_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const m = await resp.json();
    return {
      entry: {
        pkgId: "linux",
        title: "Linux System",
        isoName: ISO_NAME,
        url: m.image.url,
        bytes: m.image.bytes,
        sha256: m.image.sha256,
        version: m.version,
        volumeName: "Linux System",
      },
      minEngine: m.minEngine,
      nixCacheBaseUrl: m.nixCacheBaseUrl,
      offline: false,
    };
  } catch (err) {
    const existing = stat ? await stat(`${DISCS_DIR}/${ISO_NAME}`) : null;
    if (!existing) throw err;
    // Offline: the installed image already passed the ABI guard when installed,
    // and the engine is the same cached app code — so it is still compatible.
    return {
      entry: {
        pkgId: "linux",
        title: "Linux System",
        isoName: ISO_NAME,
        url: "",
        bytes: existing.size || 0,
        sha256: existing.sha256 || "",
        version: existing.pkgVersion,
        volumeName: "Linux System",
      },
      minEngine: 0,
      nixCacheBaseUrl: null, // filled from the sidecar by ensureLinuxImage
      offline: true,
    };
  }
}

/**
 * Ensure the `linux` image is installed + mounted, then return the three boot
 * members + the nix-cache URL. Runs the ABI guard before any download.
 * @param {{
 *   _resolve?: typeof resolveLinuxChannel,
 *   vfs?: any, installer?: any,
 *   mountIso?: any, ejectBySourceId?: any, verify?: any,
 *   fetchImpl?: typeof fetch,
 * }} [deps]
 */
export async function ensureLinuxImage(deps = {}) {
  const resolve = deps._resolve || resolveLinuxChannel;
  const vfs = deps.vfs || (await import("../vfs/index.js"));
  const { mountIso = (await import("../vfs/iso-mount.js")).mountIso } = deps;
  const { ejectBySourceId = (await import("../vfs/iso-mount.js")).ejectBySourceId } = deps;
  const verify = deps.verify || (await import("./verify.js")).verifyBytes;
  const fetchImpl = deps.fetchImpl || fetch;

  const ch = await resolve({ fetchImpl, stat: vfs.stat });

  // ABI guard (online only; offline minEngine is 0 — see resolveLinuxChannel).
  if (ch.minEngine > ENGINE_ABI) throw new EngineTooOldError(ENGINE_ABI, ch.minEngine);

  // Install (or instant re-mount) via the existing disc wizard machinery, then
  // mount the .iso as a real volume so we can read its three members.
  const installer = deps.installer || (await import("../app-registry.js").then((m) => m.loadAppModule("installer")));
  const mkdirp = async (dir) => {
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur += "/" + p;
      if (!(await vfs.stat(cur))) await vfs.mkdir(cur);
    }
  };
  const mountPath = await installCore(ch.entry, {
    stat: vfs.stat,
    mkdirp,
    write: vfs.write,
    mountIso,
    verify,
    ui: installer.installerUI(),
    unmountExisting: ejectBySourceId,
    fetchImpl,
  });

  // Persist / read the channel sidecar for offline boots.
  let nixCacheBaseUrl = ch.nixCacheBaseUrl;
  if (!ch.offline) {
    await vfs.write(SIDECAR, {
      type: "file",
      blob: new Blob([JSON.stringify({ version: ch.entry.version, nixCacheBaseUrl })], {
        type: "application/json",
      }),
      mime: "application/json",
      versioning: false,
    });
  } else {
    try {
      const side = JSON.parse(await (await vfs.readBlob(SIDECAR)).text());
      nixCacheBaseUrl = side.nixCacheBaseUrl ?? null;
    } catch {
      nixCacheBaseUrl = null;
    }
  }

  const read = async (name) => vfs.readBlob(`${mountPath}/${name}`);
  const vmlinux = await read("vmlinux.wasm");
  const initramfs = await read("initramfs.cpio.gz");
  const squashfs = await (await read("base.squashfs")).arrayBuffer();
  return { vmlinux, initramfs, squashfs, nixCacheBaseUrl };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd /home/vbvntv/Code/pc && bun test js/packages/linux-channel.test.js`
Expected: PASS (all four tests; the `ensureLinuxImage` test exercises only the guard via `_resolve`, so it never touches the VFS).

- [ ] **Step 5: Static gates**

Run: `cd /home/vbvntv/Code/pc && bun run lint && bun run format:check && bun run typecheck`
Expected: all pass. (If typecheck flags the dynamic-import destructuring, mirror the pattern already used in `install.js` `wireDeps()`.)

- [ ] **Step 6: Commit**

```bash
cd /home/vbvntv/Code/pc
git add js/packages/linux-channel.js js/packages/linux-channel.test.js
git commit -m "feat(packages): linux channel resolver + ABI guard (#315)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Task 6: kernel-service boots from the channel image

**Files:**
- Modify: `/home/vbvntv/Code/pc/js/linux/kernel-service.js`
- Modify: `/home/vbvntv/Code/pc/js/packages/registry.js`

**Interfaces:**
- Consumes: `ensureLinuxImage` / `EngineTooOldError` from `../packages/linux-channel.js`; `bootNixSystem` bytes-mode (Task 3).
- Produces: a `createKernelService` whose `ensureBooted()` boots from the channel image. No `ARTIFACTS_BASE`, no `ensurePackageBytes("linux-base")`.

- [ ] **Step 1: Remove the `linux-base` registry entry**

In `/home/vbvntv/Code/pc/js/packages/registry.js`, delete the entire `"linux-base": { … }` property (lines ~63–77, the block ending `},` before the closing `};`). Update the file header comment's mention of `linux-base` if present. Leave `sample`/`omnia`/`omnia-images` untouched.

- [ ] **Step 2: Update the registry test if it asserts on `linux-base`**

Run: `cd /home/vbvntv/Code/pc && bun test js/packages/registry.test.js`
If it fails because it expected `linux-base`, edit `js/packages/registry.test.js` to drop that assertion (the `linux` channel is no longer a static registry row). Re-run; expected PASS.

- [ ] **Step 3: Rewrite the boot wiring in `kernel-service.js`**

In `/home/vbvntv/Code/pc/js/linux/kernel-service.js`:

(a) Replace the import:
```js
import { ensurePackageBytes } from "../packages/install.js";
```
with:
```js
import { ensureLinuxImage } from "../packages/linux-channel.js";
```

(b) Delete the `ARTIFACTS_BASE` constant (the `const ARTIFACTS_BASE = new URL(…)` line near line 26) and trim its now-stale comment to drop the `baseUrl`/`vmlinux`/`initramfs`/`nix-cache` description.

(c) In `ensureBooted`, replace the `bootPromise = (async () => { … })()` body. The current body fetches `const squashfs = await ensurePackageBytes("linux-base");` then calls `bootNixSystem({ squashfs, vfs: wrappedVfs, baseUrl: ARTIFACTS_BASE, onDownload, onModuleCached, … wayland })`. Change it to:

```js
    bootPromise = (async () => {
      // The single versioned `linux` image (vmlinux+initramfs+squashfs) is
      // downloaded once via the disc installer, verified, and persisted; we
      // mount it and read the three members out. The compiler toolchain is a
      // separate lazy R2 cache (nixCacheBaseUrl). An incompatible (stale-cached)
      // pc throws EngineTooOldError here instead of crashing mid-boot. (#315)
      const img = await ensureLinuxImage();
      return bootNixSystem({
        vmlinux: img.vmlinux,
        initramfs: img.initramfs,
        squashfs: img.squashfs,
        nixCacheBaseUrl: img.nixCacheBaseUrl,
        vfs: wrappedVfs,
        onLog:
          typeof window !== "undefined" && /** @type {any} */ (window).__linuxWlDebug
            ? (t) => console.debug(t)
            : undefined,
        onModuleCached: onCompiled,
        wayland: {
          sendOut: (clientId, buffer, fds) => {
            const c = compositorReady;
            if (!c) {
              console.warn("[linux] wayland OUT before compositor ready; dropping");
              return;
            }
            try {
              c.feedFromGuest(clientId, buffer, fds);
            } catch (e) {
              console.error("[linux] wayland feedFromGuest failed", e);
            }
          },
          onClose: (clientId) => {
            try {
              compositorReady?.destroyGuestClient(clientId);
            } catch (e) {
              console.error("[linux] wayland onClose failed", e);
            }
          },
        },
      }).then(async (h) => {
```

Keep the existing `.then(async (h) => { … })` handle-wiring body (handle assignment, pushIn wiring, vnet attach, `return h;`) exactly as-is.

(d) `onDownload` was only passed in baseUrl/closure-store mode and is now unused as a boot arg. Leave the `onDownload`/`activity` machinery in place (the tray tool-load indicator still uses `onDownload` via the closure store? — verify: it is referenced only in the removed `bootNixSystem` call). If `onDownload` becomes unreferenced, remove its definition to keep lint clean; if `typecheck`/`lint` reports it unused, delete the `const onDownload = …` block and its doc comment. Do NOT remove `onCompiled`/`onActivity` (still used).

- [ ] **Step 4: Run the full pc test suite + static gates**

Run: `cd /home/vbvntv/Code/pc && bun test js/ && bun run lint && bun run format:check && bun run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /home/vbvntv/Code/pc
git add js/linux/kernel-service.js js/packages/registry.js js/packages/registry.test.js
git commit -m "feat(linux): boot from the versioned linux channel image (#315)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Task 7: First publish (operational — makes the channel live)

**Files:** none (R2 objects + a Worker deploy). This task must run AFTER Tasks 2/3/4/6 and BEFORE Task 8's git removal so the live site never references missing artifacts.

**Interfaces:**
- Consumes: `.#linux-image` (Task 2), `.#wasm-binary-cache`, the `no-cache` Worker (Task 4).
- Produces: `packages/linux/1/linux.iso`, `packages/linux/1/nix-cache/**`, `packages/linux/latest.json` live on R2.

- [ ] **Step 1: Build the image + the toolchain cache**

```bash
cd /home/vbvntv/Code/nix-wasm
export NIX_CONFIG="experimental-features = nix-command flakes"
echo <pw> | sudo -S nix build .#linux-image --print-out-paths      # → IMG_OUT
echo <pw> | sudo -S nix build .#wasm-binary-cache --print-out-paths # → CACHE_OUT
ISO="$(ls IMG_OUT/iso/*.iso)"   # use the path confirmed in Task 2 Step 4
```

- [ ] **Step 2: Compute the image digest + size for latest.json**

```bash
sha256sum "$ISO"          # → IMG_SHA
stat -c%s "$ISO"          # → IMG_BYTES
```

- [ ] **Step 3: Upload the image + the nix-cache tree (from the pc repo, which has wrangler/R2 creds)**

```bash
cd /home/vbvntv/Code/pc
bunx wrangler r2 object put pc-previews/packages/linux/1/linux.iso \
  --file "$ISO" --content-type application/x-iso9660-image --remote

# nix-cache is a small tree (~13 files): upload each at its relative path.
( cd CACHE_OUT && find . -type f -printf '%P\n' ) | while read -r f; do
  bunx wrangler r2 object put "pc-previews/packages/linux/1/nix-cache/$f" \
    --file "CACHE_OUT/$f" --remote
done
```

- [ ] **Step 4: Write + upload `latest.json`**

```bash
cat > /tmp/latest.json <<JSON
{
  "version": 1,
  "image": {
    "url": "https://pc-previews.eric-c6b.workers.dev/packages/linux/1/linux.iso",
    "bytes": IMG_BYTES,
    "sha256": "IMG_SHA"
  },
  "nixCacheBaseUrl": "https://pc-previews.eric-c6b.workers.dev/packages/linux/1/nix-cache",
  "minEngine": 1
}
JSON
bunx wrangler r2 object put pc-previews/packages/linux/latest.json \
  --file /tmp/latest.json --content-type application/json --remote
```

- [ ] **Step 5: Deploy the Worker (the `no-cache` route from Task 4)**

```bash
cd /home/vbvntv/Code/pc/infra/preview-worker && bunx wrangler deploy
```

- [ ] **Step 6: Verify the live channel**

```bash
curl -I https://pc-previews.eric-c6b.workers.dev/packages/linux/latest.json
# expect: 200, content-type application/json, cache-control: no-cache,
#         access-control-allow-origin: *
curl -I https://pc-previews.eric-c6b.workers.dev/packages/linux/1/linux.iso
# expect: 200, application/x-iso9660-image, cache-control: …immutable, ACAO *
curl -s https://pc-previews.eric-c6b.workers.dev/packages/linux/1/nix-cache/manifest.json | head -c 200
# expect: the cache manifest JSON
```

- [ ] **Step 7: End-to-end boot check (manual, in the browser)**

Serve a pc PR preview (or local dev) on the `linux-channel-315` branch, open the Linux app: it should download `linux.iso` once (Setup wizard), boot to a shell, and a Wayland app (e.g. `wl-eyes`) should render (the new image is built from nix-wasm HEAD with the inittab proxy autostart). Driving tips: pc `CLAUDE.md` §"Visual regression & Playwright".

---

## Task 8: Remove vendored artifacts + write the docs

**Files:**
- Delete: `/home/vbvntv/Code/pc/vendor/linux-wasm/vmlinux.wasm`
- Delete: `/home/vbvntv/Code/pc/vendor/linux-wasm/initramfs.cpio.gz`
- Delete: `/home/vbvntv/Code/pc/vendor/linux-wasm/nix-cache/` (whole dir)
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/SOURCE.md`
- Modify: `/home/vbvntv/Code/pc/.claude/rules/disc-packages.md`
- Modify: `/home/vbvntv/Code/nix-wasm/CLAUDE.md`

- [ ] **Step 1: Remove the now-unused vendored data artifacts**

```bash
cd /home/vbvntv/Code/pc
git rm vendor/linux-wasm/vmlinux.wasm vendor/linux-wasm/initramfs.cpio.gz
git rm -r vendor/linux-wasm/nix-cache
grep -rn "ARTIFACTS_BASE\|vendor/linux-wasm/vmlinux\|vendor/linux-wasm/nix-cache" js/ || echo "no stale refs"
```
Expected: no stale references in `js/` (the engine JS under `vendor/linux-wasm/runtime/` stays).

- [ ] **Step 2: Rewrite the SOURCE.md artifact table + add the "Republish the guest" runbook**

In `/home/vbvntv/Code/pc/vendor/linux-wasm/SOURCE.md`:
- In the "nix-wasm target → vendored here as" table and the "Artifacts pc loads" table, replace the `vmlinux.wasm` / `initramfs.cpio.gz` / `nix-cache/` rows with a single note that they now ship inside the versioned `linux` channel image (`.#linux-image`) on R2, fetched at runtime — only `runtime/` (the engine JS) is vendored in git.
- Add a top-level section:

```markdown
## Republish the guest (end-to-end runbook)

A guest change reaches the live site WITHOUT a pc deploy — it republishes the
`linux` channel on R2:

1. **Build** (nix-wasm): `nix build .#linux-image` and `nix build .#wasm-binary-cache`.
2. **Upload** under a NEW immutable version `<v>` (bump from the current
   `latest.json`): `packages/linux/<v>/linux.iso` and the `nix-cache/` tree
   (`wrangler r2 object put … --remote`).
3. **Flip** the pointer: overwrite `packages/linux/latest.json` with the new
   `version`, image `url`/`bytes`/`sha256`, `nixCacheBaseUrl`, and `minEngine`
   (from `runtime/abi.js` `ENGINE_ABI`). Served `no-cache`, so clients pick it up
   immediately; installed clients see the Setup "Update" prompt on next open.
4. **Bump `WASM_GUEST_ABI`** (nix-wasm `runtime/abi.js` `ENGINE_ABI`) ONLY when
   the change is an incompatible engine↔guest ABI break — then the engine JS must
   also be synced (`runtime/sync-to-pc.sh`) and pc deployed, because `minEngine`
   will exceed older cached engines (which now show "reload pc").

No pc code change is needed for a normal guest republish (steps 1–3).

**Which artifact carries a guest change?** The inittab and guest `/etc` live in
`base.squashfs` (via `userspace/init.nix → toplevel.nix → base-squashfs.nix`),
NOT the initramfs — so an `init.nix` change republishes through `.#linux-image`'s
squashfs member.
```

- [ ] **Step 3: Carve out `linux` in the disc-packages rule**

In `/home/vbvntv/Code/pc/.claude/rules/disc-packages.md`, add a section noting that `linux` is special — NOT an `.iso` built by `scripts/build-<pkg>-iso-package.mjs` + xorriso, and NOT a static `registry.js` row. It is a **cross-repo channel**: the image is built in nix-wasm (`.#linux-image`), resolved at runtime via `js/packages/linux-channel.js` + `packages/linux/latest.json`, and republished per the SOURCE.md runbook (link it). The generic xorriso flow still applies to `sample`/`omnia`/`omnia-images`.

- [ ] **Step 4: Point nix-wasm CLAUDE.md at the runbook + the squashfs mapping**

In `/home/vbvntv/Code/nix-wasm/CLAUDE.md`, under the runtime/boot-test section (near the artifacts/`LINUX_WASM_ARTIFACTS` notes), add a short note: the pc-facing delivery is the versioned `linux` channel (`.#linux-image` → R2 `packages/linux/<v>/` + `latest.json`), with the end-to-end runbook in pc `vendor/linux-wasm/SOURCE.md`; and that the guest inittab/`/etc` live in `base.squashfs` (`init.nix → toplevel.nix → base-squashfs.nix`), not the initramfs — so an `init.nix` change republishes via the squashfs member.

- [ ] **Step 5: pc static gates (docs + deletions don't break tests)**

Run: `cd /home/vbvntv/Code/pc && bun test js/ && bun run lint && bun run typecheck`
Expected: green (no code references the deleted files).

- [ ] **Step 6: Commit (two repos)**

```bash
cd /home/vbvntv/Code/pc
git add -A vendor/linux-wasm/ .claude/rules/disc-packages.md
git commit -m "chore(linux): drop vendored guest data; channel publish runbook (#315)

Remove vmlinux.wasm/initramfs.cpio.gz/nix-cache from git — they now ship in the
versioned linux channel image on R2. Document the no-deploy republish flow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"

cd /home/vbvntv/Code/nix-wasm
git add CLAUDE.md
git commit -m "docs(CLAUDE): linux channel delivery + init.nix→squashfs mapping (pc#315)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014MS8ahGs6dekxerZDeqXPp"
```

---

## Task 9: Sync the engine to pc + open the PRs

**Files:** `pc/vendor/linux-wasm/runtime/*` (generated by the sync script).

- [ ] **Step 1: Sync the vendored engine (carries abi.js + bytes-mode)**

```bash
cd /home/vbvntv/Code/nix-wasm
runtime/sync-to-pc.sh /home/vbvntv/Code/pc
cd /home/vbvntv/Code/pc && git status vendor/linux-wasm/runtime/
```
Expected: `runtime/abi.js`, `boot-nix-system.js`, `index.js` updated under `vendor/linux-wasm/runtime/`, plus the SOURCE.md provenance stamp.

- [ ] **Step 2: Verify pc still builds/tests against the synced engine**

Run: `cd /home/vbvntv/Code/pc && bun test js/ && bun run lint && bun run typecheck`
Expected: green (the `ENGINE_ABI` import in `linux-channel.js` now resolves to the synced `abi.js`).

- [ ] **Step 3: Commit the sync**

```bash
cd /home/vbvntv/Code/pc
git add vendor/linux-wasm/runtime vendor/linux-wasm/SOURCE.md
git commit -m "chore(vendor): sync linux-wasm engine (abi.js + bootNixSystem bytes-mode) (#315)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: Push both branches + open PRs**

```bash
cd /home/vbvntv/Code/nix-wasm && git push -u origin linux-channel-315
gh pr create --repo codebutler/nix-wasm --fill --base master \
  --title "feat: .#linux-image + ENGINE_ABI + bootNixSystem bytes-mode (pc#315)"

cd /home/vbvntv/Code/pc && git push -u origin linux-channel-315
gh pr create --repo codebutler/pc --fill --base main \
  --title "feat(linux): one versioned linux channel, no deploy to republish (#315)"
```
Cross-link the two PRs and reference pc#315 in both bodies.

---

## Self-Review

**Spec coverage:**
- One versioned image (kernel+initramfs+squashfs) built deterministically → Task 2 (`.#linux-image` via `make-iso9660-image`). ✓
- nix-cache lazy from R2 → Task 3 (`nixCacheBaseUrl`) + Task 7 upload + Task 5 wiring. ✓
- `engineVersion`/`minEngine` baked + verified before boot, clear message on mismatch → Task 1 (`ENGINE_ABI`) + Task 2 (manifest stamp) + Task 5 (`EngineTooOldError`, guard before download) + Task 6 (guard on boot). ✓
- `latest.json` channel, no pc deploy to republish → Task 4 (`no-cache`) + Task 5 (`resolveLinuxChannel`) + Task 7 (publish) + Task 8 (runbook). ✓
- `kernel-service.js` boots entirely from the image → Task 6. ✓
- vmlinux/initramfs/nix-cache removed from pc git → Task 8. ✓
- Runbook linked from SOURCE.md, disc-packages.md, nix-wasm CLAUDE.md → Task 8. ✓
- `init.nix → squashfs` mapping documented → Task 8 (SOURCE.md + CLAUDE.md). ✓
- Verification items (Rock Ridge long names; bytes-mode parity) → resolved (pc `iso9660.js` documents Rock Ridge/Joliet incl. xorriso UTF-8 NM) + Task 7 Step 7 boot check; bytes-mode unit-tested in Task 3 and exercised end-to-end in Task 7. ✓

**Placeholder scan:** no TBD/TODO; all code blocks complete. Operational values in Task 7 (`IMG_SHA`/`IMG_BYTES`/`IMG_OUT`/`CACHE_OUT`) are runtime-computed shell captures, not unfilled placeholders.

**Type consistency:** `ENGINE_ABI` (number) exported from `abi.js`→`index.js`, parsed identically in `linux-image.nix`, imported in `linux-channel.js`. `resolveLinuxChannel` returns `{entry, minEngine, nixCacheBaseUrl, offline}` — consumed with those exact keys in `ensureLinuxImage`. `ensureLinuxImage` returns `{vmlinux, initramfs, squashfs, nixCacheBaseUrl}` — consumed with those exact keys in `kernel-service.js`'s `bootNixSystem({vmlinux, initramfs, squashfs, nixCacheBaseUrl, …})`, which match Task 3's new `bootNixSystem` opts. `installCore(entry, deps)` deps shape matches `install.js` `InstallDeps`. ✓

**Sequencing guard:** Task 7 (publish) precedes Task 8 (git removal) so the live site never references deleted artifacts; Task 9 (engine sync) makes pc's `ENGINE_ABI` import resolve — run before pushing pc. ✓
