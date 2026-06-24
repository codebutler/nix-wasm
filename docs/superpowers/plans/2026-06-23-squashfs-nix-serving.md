# squashfs base + NAR binary-cache `/nix` serving — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke `store.json` `/nix` closure manifest with a squashfs image of the base store (mounted over a new read-only virtio-blk device) and move the compiler toolchain out of the base into a NAR binary cache substituted on demand.

**Architecture:** The base system closure becomes a compressed squashfs image (the NixOS live-ISO design), fetched host-side and exposed to the guest as a read-only virtio-blk device; the guest mounts it as the overlay lowerdir → `/nix`. The compiler toolchain (clang/wasm-ld/cc/c++/make) leaves `systemPackages` and is published to a standard Nix binary cache (`nix copy`), substituted on first `nix-env -iA`. `nix` and `ash` stay in the base.

**Tech Stack:** Nix (flakes, `wasm32-linux-musl` crossSystem), Linux NOMMU wasm kernel (squashfs + virtio-blk), JS runtime engine (virtio device models, 9P), `mksquashfs` (zstd), `nix copy` binary cache.

## Global Constraints

- **PRIME DIRECTIVE:** maximally correct, no shortcuts/stubs. Every wasm fix is a SHARED crossSystem/overlay/kernel-source fix, never a package-private workaround.
- **Nix builds run as root via the daemon.** Prefix each build with the sudo invocation documented in agent memory (`echo <pw> | sudo -S …`; `sudo -E` is ignored here) and enable flakes via `NIX_CONFIG="experimental-features = nix-command flakes"`. **Never inline the password in committed files.** Run each `sudo nix` as its own command (piped passwords are lost into `$(…)` subshells).
- **Do not kill a running build to restart.** First aarch64 build may compile LLVM (~1–2 h); builds notify on completion.
- **If disk runs out (ENOSPC): STOP and ask for more disk — do NOT `nix store gc`.**
- **Pin:** `nixos-unstable` @ `9ae611a` (LLVM 21.1.8). aarch64 cache lags; first kernel build may be from source.
- **Runtime CI gates (all four must pass before pushing, run from `runtime/`):** `bun run test`, `bun run lint` (zero warnings), `bun run format:check`, `bun run typecheck`.
- **Kernel sector size:** virtio-blk uses 512-byte logical sectors throughout.
- **squashfs compressor:** zstd. **Block device transport:** virtio-blk over the existing `virtio_wasm` transport. **Device id:** `VW_DEV_BLK = 3`, `VIRTIO_ID_BLOCK = 2`, `irq = VIRTIO_WASM_IRQ_BASE(8) + 3`.
- **Hosting / download (Option X):** the base squashfs is delivered by **pc's disc-package system** (`codebutler/pc` commit `24780b14`, #288) — its R2 hosting + Setup wizard + sha256 verify + update checking + offline persistence are reused, but the squashfs is **NOT** mounted into pc's VFS: pc injects an identity mount into `installCore` and hands the raw `.squashfs` bytes to `bootNixSystem`, which feeds virtio-blk so Linux mounts it directly. The **nix-wasm seam** this plan owns: `bootNixSystem` accepts injected bytes (`opts.squashfs` = `ArrayBuffer | () => Promise<ArrayBuffer>`); **when absent it falls back to fetching `base.squashfs` from `baseUrl`** (the standalone-harness/dev/CI path). The pc-side consumer (registry entry, build/upload script, identity-mount shim) lives in **pc** as a follow-up.
- **Publishing:** CI on `x86_64-linux` builds the wasm outputs and writes them to R2 via `wrangler r2 object put --remote` (Task 9). R2 creds live in CI secrets, never in the repo.

---

## File Structure

**Create:**
- `runtime/virtio/blk-device.js` — read-only virtio-blk device model (serves sector reads from an in-memory image buffer).
- `runtime/virtio/blk-device.test.js` — engine unit tests for the block device.
- `userspace/base-squashfs.nix` — builds the base store squashfs (zstd) + profile symlink.
- `flake.nix` output `wasm-binary-cache` builder (inline or `userspace/binary-cache.nix`).
- `patches/kernel/0017-wasm-virtio-blk-device.patch` — adds `VW_DEV_BLK` id + registration to the `virtio_wasm` transport.
- `docs/superpowers/notes/squashfs-nommu-spike.md` — spike findings (chosen block size, gotchas).
- `scripts/publish-to-r2.sh` — build → hash → upload the wasm artifacts to R2 (manual + CI).
- `.github/workflows/publish-wasm-artifacts.yml` — CI: build on x86_64, publish to R2.
- `docs/superpowers/notes/deploy-r2.md` — deploy runbook (upload + verify + pc registry bump).

**Modify:**
- `kernel.nix` — enable `CONFIG_BLOCK`, `CONFIG_VIRTIO_BLK`, `CONFIG_SQUASHFS`, `CONFIG_SQUASHFS_ZSTD`, `CONFIG_ZSTD_DECOMPRESS`; apply patch 0017.
- `runtime/kernel-worker.js` — add `VW_DEV_BLK` to the device factory; accept the squashfs buffer from the boot message.
- `runtime/boot.js` — accept `squashfs` ArrayBuffer opt, transfer it to the worker; remove the `nix` 9P export (`nixStore`).
- `runtime/boot-nix-system.js` — fetch `base.squashfs` via the seam, pass it to `bootLinux`; drop `createNixClosureStore`.
- `runtime/index.js` — drop the `createNixClosureStore` re-export.
- `userspace/bootstrap.nix` — replace the `aname=nix` 9P mount with `mount -t squashfs /dev/vdX`.
- `userspace/system.nix` — drop the compiler toolchain from `systemPackages` (keep `nix` + `ash`); add cache trust config.
- `flake.nix` — add `wasm-base-squashfs` + `wasm-binary-cache`; remove `wasm-store-manifest`/`wasmStoreManifest`; change the `toolchain` list passed to `system.nix`.
- `runtime/sync-to-pc.sh` — add `virtio/blk-device.js`; remove `nix-closure-store.js`.
- `CLAUDE.md` — update Architecture + Current state + learnings.

**Delete:**
- `runtime/nix-closure-store.js`, `runtime/nix-closure-store.test.js`
- `userspace/store-manifest.nix`, `userspace/store-manifest.py`

---

# Phase 0 — Spike (GATING): prove kernel + virtio-blk + squashfs + NOMMU-mmap

The spike must pass before any production work. It validates the riskiest chain end-to-end with throwaway-minimal pieces.

## Task 1: Kernel gains block + squashfs + virtio-blk

**Files:**
- Modify: `kernel.nix` (the `scripts/config` toggle block, ~lines 131–166; the `patches` list, ~lines 44–70)
- Create: `patches/kernel/0017-wasm-virtio-blk-device.patch`

**Interfaces:**
- Produces: a `vmlinux.wasm` whose `.config` has `CONFIG_SQUASHFS=y`, `CONFIG_SQUASHFS_ZSTD=y`, `CONFIG_BLOCK=y`, `CONFIG_VIRTIO_BLK=y`, and a `virtio_wasm` transport registering device index `3` (`VW_DEV_BLK`) as `VIRTIO_ID_BLOCK` (2), irq `11`.

- [ ] **Step 1: Inspect the transport patch's device-registration block**

Run: `grep -n "VW_DEV_NET\|virtio_wasm_register\|VW_DEV_COUNT\|VIRTIO_ID_NET" patches/kernel/0013-wasm-virtio-wasm-transport.patch`
Expected: shows the `enum { VW_DEV_WL=0, VW_DEV_ECHO, VW_DEV_NET, VW_DEV_COUNT }` and the `virtio_wasm_register(VW_DEV_NET, VIRTIO_ID_NET)` init lines. Note the exact file (`drivers/virtio/virtio_wasm.c`) and surrounding context so patch 0017 applies cleanly *after* 0013.

- [ ] **Step 2: Write patch 0017 (add VW_DEV_BLK)**

Create `patches/kernel/0017-wasm-virtio-blk-device.patch` as a unified diff against the post-0013 `drivers/virtio/virtio_wasm.c` that:
1. Inserts `VW_DEV_BLK,` into the `enum` immediately before `VW_DEV_COUNT` (so it becomes index 3).
2. Adds, in the transport init (next to the `VW_DEV_NET` registration), guarded by `IS_ENABLED(CONFIG_VIRTIO_BLK)`:

```c
#if IS_ENABLED(CONFIG_VIRTIO_BLK)
	vw = virtio_wasm_register(VW_DEV_BLK, VIRTIO_ID_BLOCK);
	if (IS_ERR(vw))
		pr_warn("virtio_wasm: blk register failed: %ld\n", PTR_ERR(vw));
#endif
```

(`VIRTIO_ID_BLOCK` is defined in `include/uapi/linux/virtio_ids.h` as 2 — no new define needed. Mirror the exact error-handling idiom used by the `VW_DEV_NET` block.)

- [ ] **Step 3: Add patch 0017 to kernel.nix `patches`**

In `kernel.nix`, append to the `patches` list (after `0016-wasm-nommu-ro-shared-mmap-copy.patch`):

```nix
    ./patches/kernel/0017-wasm-virtio-blk-device.patch
```

- [ ] **Step 4: Enable the configs in kernel.nix**

In the `scripts/config` invocation, add these flags (append to the existing `--enable …` chain, before the final `make $makeFlags olddefconfig`):

```sh
      --enable CONFIG_BLOCK \
      --enable CONFIG_VIRTIO_BLK \
      --enable CONFIG_SQUASHFS \
      --enable CONFIG_SQUASHFS_ZSTD \
      --enable CONFIG_ZSTD_DECOMPRESS \
```

- [ ] **Step 5: Build the kernel**

Run (as documented sudo invocation): `sudo nix build .#vmlinux --no-link --print-out-paths`
Expected: a store path. If it fails to compile, fix patch 0017 / config and rebuild (do NOT kill a long LLVM build).

- [ ] **Step 6: Verify the configs survived `olddefconfig`**

Some NOMMU configs are silently dropped without a gate (cf. SHMEM/TMPFS). Confirm they're present in the built `.config`. Build the config-bearing intermediate or grep the build log; the reliable check:

Run: `sudo nix build .#vmlinux --print-out-paths` then inspect the derivation's `.config` (or add a temporary `grep -E 'SQUASHFS|VIRTIO_BLK|CONFIG_BLOCK=' build/.config` echo into `configurePhase` during the spike).
Expected: `CONFIG_SQUASHFS=y`, `CONFIG_SQUASHFS_ZSTD=y`, `CONFIG_VIRTIO_BLK=y`, `CONFIG_BLOCK=y` all present. If any is `# … is not set`, find its gating symbol (as `NETDEVICES` gates `VIRTIO_NET`) and enable it too.

- [ ] **Step 7: Commit**

```bash
git add kernel.nix patches/kernel/0017-wasm-virtio-blk-device.patch
git commit -m "kernel: enable squashfs + virtio-blk over virtio_wasm (#43 spike)"
```

## Task 2: Minimal read-only virtio-blk device model

**Files:**
- Create: `runtime/virtio/blk-device.js`
- Test: `runtime/virtio/blk-device.test.js`
- Modify: `runtime/kernel-worker.js` (device factory ~lines 226–317; boot-message handling for the image buffer)

**Interfaces:**
- Consumes: `VirtioWasmDevice` base (`runtime/virtio/device.js`) — `setupQueue`, `vring(q)`, `raiseIrq()`, `memView(buf,len)`, `configRead/Write`, `getFeatures`, `onNotify(q)`.
- Produces: `class BlkDevice extends VirtioWasmDevice` with `constructor({ ...common, image: Uint8Array })`; serves `VIRTIO_BLK_T_IN` (read) requests from `image`, reports `capacity = image.length / 512` in config space, advertises read-only.

- [ ] **Step 1: Write the failing test**

Create `runtime/virtio/blk-device.test.js`. Use the same harness style as `runtime/virtio/net-device.test.js` (inspect it first for `Vring`/`SharedQueues`/`memory` setup helpers). Cover: (a) config-space `capacity` = sectors; (b) a single `VIRTIO_BLK_T_IN` request copies the right `image` bytes into the data buffer and writes status `0` (VIRTIO_BLK_S_OK); (c) a read past EOF writes status `1` (VIRTIO_BLK_S_IOERR) and raises the irq.

```js
import { describe, it, expect } from "bun:test";
import { BlkDevice } from "./blk-device.js";
import { makeSharedQueues } from "./shared-queues.js";
// (mirror net-device.test.js for memory + a helper that builds a 3-descriptor
// virtio-blk request chain: [16-byte header][data buf][1-byte status] and pushes
// it on the avail ring, then asserts on used + memory after onNotify.)

describe("BlkDevice", () => {
  it("reports capacity in 512-byte sectors via config space", () => {
    const image = new Uint8Array(512 * 4); // 4 sectors
    const dev = makeBlk(image);
    const cfg = new Uint8Array(8);
    dev.configRead(0, cfg);
    const capacity = new DataView(cfg.buffer).getBigUint64(0, true);
    expect(capacity).toBe(4n);
  });

  it("serves a VIRTIO_BLK_T_IN read from the image", () => {
    const image = new Uint8Array(512 * 2);
    image[512] = 0xab; // first byte of sector 1
    const { dev, readSector, statusOf } = makeBlkWithRing(image);
    const { status, data } = readSector(1);
    expect(statusOf(status)).toBe(0); // VIRTIO_BLK_S_OK
    expect(data[0]).toBe(0xab);
  });

  it("fails a read past end-of-image with S_IOERR", () => {
    const image = new Uint8Array(512 * 1);
    const { readSector, statusOf, irqCount } = makeBlkWithRing(image);
    const { status } = readSector(99);
    expect(statusOf(status)).toBe(1); // VIRTIO_BLK_S_IOERR
    expect(irqCount()).toBeGreaterThan(0);
  });
});
```

(Write the `makeBlk` / `makeBlkWithRing` helpers concretely, modeled on net-device.test.js's vring/memory scaffolding. The request chain layout: descriptor 0 = 16-byte `struct virtio_blk_outhdr` `{ le32 type; le32 reserved; le64 sector; }`, descriptor 1 = data (device-writable, `VRING_DESC_F_WRITE`), descriptor 2 = 1-byte status (device-writable).)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd runtime && bun test virtio/blk-device.test.js`
Expected: FAIL — `Cannot find module './blk-device.js'`.

- [ ] **Step 3: Implement `BlkDevice`**

Create `runtime/virtio/blk-device.js`:

```js
// blk-device.js — read-only virtio-blk device over the virtio_wasm transport.
// Serves the base-system squashfs image (an in-memory Uint8Array) to the guest
// as /dev/vdX; the guest mounts it -t squashfs as the /nix overlay lowerdir.
// Read-only by construction: VIRTIO_BLK_T_OUT (write) requests fail S_IOERR.
import { VirtioWasmDevice } from "./device.js";

const SECTOR = 512;
const VIRTIO_BLK_T_IN = 0;   // read
const VIRTIO_BLK_S_OK = 0;
const VIRTIO_BLK_S_IOERR = 1;
const VIRTIO_BLK_S_UNSUPP = 2;
// virtio_blk feature bits
const VIRTIO_BLK_F_RO = 5n;          // device is read-only
const VIRTIO_F_VERSION_1 = 32n;      // modern device

export class BlkDevice extends VirtioWasmDevice {
  /** @param {object} opts @param {Uint8Array} opts.image squashfs bytes */
  constructor(opts) {
    super(opts);
    this.image = opts.image;
    this.capacity = BigInt(Math.floor(this.image.length / SECTOR)); // in sectors
  }

  getFeatures() {
    return (1n << VIRTIO_F_VERSION_1) | (1n << VIRTIO_BLK_F_RO);
  }

  // virtio_blk config space: u64 capacity at offset 0 (little-endian, sectors).
  configRead(offset, bytes) {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, this.capacity, true);
    for (let i = 0; i < bytes.length; i++) {
      const src = offset + i;
      bytes[i] = src < buf.length ? buf[src] : 0;
    }
  }

  onNotify(q) {
    const ring = this.vring(q >>> 0);
    if (!ring) return;
    let serviced = 0;
    for (;;) {
      const head = ring.popAvail(); // returns the head desc index or null
      if (head === null || head === undefined) break;
      serviced += this._service(ring, head);
    }
    if (serviced) this.raiseIrq();
  }

  // Walk one request's descriptor chain: [outhdr][data...][status].
  _service(ring, head) {
    const chain = ring.chain(head); // array of {addr, len, write} in chain order
    const hdr = this.memView(chain[0].addr, 16);
    const dv = new DataView(hdr.buffer, hdr.byteOffset, 16);
    const type = dv.getUint32(0, true);
    const sector = dv.getBigUint64(8, true);
    const statusDesc = chain[chain.length - 1];
    const dataDescs = chain.slice(1, chain.length - 1);

    let status = VIRTIO_BLK_S_OK;
    let written = 1; // status byte always written
    if (type !== VIRTIO_BLK_T_IN) {
      status = VIRTIO_BLK_S_UNSUPP; // read-only device
    } else {
      let pos = Number(sector) * SECTOR;
      for (const d of dataDescs) {
        const out = this.memView(d.addr, d.len);
        if (pos + d.len > this.image.length) { status = VIRTIO_BLK_S_IOERR; break; }
        out.set(this.image.subarray(pos, pos + d.len));
        pos += d.len;
        written += d.len;
      }
    }
    this.memView(statusDesc.addr, 1)[0] = status;
    ring.pushUsed(head, written);
    return 1;
  }
}
```

(NOTE: `ring.popAvail()`, `ring.chain(head)`, `ring.pushUsed(head, len)` — verify the exact method names against `runtime/virtio/vring.js` in Step 1 of this task and adjust to match how `net-device.js`/`wl-device.js` consume the ring. If the existing API differs, use it verbatim rather than inventing names.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd runtime && bun test virtio/blk-device.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire BlkDevice into the worker device factory**

In `runtime/kernel-worker.js`:
1. Add the import near the other device imports (`~line 14`): `import { BlkDevice } from "./virtio/blk-device.js";`
2. Add `const VW_DEV_BLK = 3;` next to the other `VW_DEV_*` consts (`~line 228`).
3. In `get_virtio_device`, add a branch (after the `VW_DEV_NET` branch):

```js
      else if (id === VW_DEV_BLK) {
        // Read-only base-system squashfs, handed in via the boot message.
        d = new BlkDevice({ ...common, image: squashfsImage });
      }
```

4. Accept the image from the boot message: find where the worker reads the boot `postMessage` payload (the `{ vmlinux, initrd, … }` object) and add `const squashfsImage = msg.squashfs ? new Uint8Array(msg.squashfs) : new Uint8Array(0);` in the same scope `get_virtio_device` closes over. (If `msg.squashfs` is absent — e.g. `--no-nix` boots — `VW_DEV_BLK` simply serves a 0-capacity device; the guest mount then fails gracefully and bootstrap falls back, mirroring today's absent-`nix`-export behavior.)

- [ ] **Step 6: Run the engine unit suite + gates**

Run: `cd runtime && bun run test && bun run lint && bun run typecheck`
Expected: all pass (new blk tests included; no lint/type errors). Fix `format` with `bun run format` if `format:check` complains.

- [ ] **Step 7: Commit**

```bash
git add runtime/virtio/blk-device.js runtime/virtio/blk-device.test.js runtime/kernel-worker.js
git commit -m "runtime: read-only virtio-blk device model + worker wiring (#43 spike)"
```

## Task 3: End-to-end spike proof — mount a tiny squashfs and exec off it

**Files:**
- Create: `docs/superpowers/notes/squashfs-nommu-spike.md`
- Temporary: a throwaway boot harness under `runtime/demo/node/` (not committed unless useful)

**Interfaces:**
- Consumes: Task 1 kernel, Task 2 BlkDevice + worker wiring.
- Produces: documented proof that the guest can `mount -t squashfs` a virtio-blk image, read a file, **and mmap-exec a binary off it**; the chosen squashfs `-b` block size.

- [ ] **Step 1: Build a tiny test squashfs**

Build a tiny image from a dir containing a shell script and a small prebuilt guest binary (reuse any existing `.#…` wasm binary output, e.g. a small `extraBins` member). Using host `mksquashfs`:

```bash
mkdir -p /tmp/sqtest/nix/store/aaaa-test
cp <a small guest wasm binary> /tmp/sqtest/nix/store/aaaa-test/prog
echo hello > /tmp/sqtest/nix/store/aaaa-test/data.txt
nix shell nixpkgs#squashfsTools -c mksquashfs /tmp/sqtest/nix /tmp/sqtest/base.squashfs \
  -comp zstd -b 16384 -all-root -noappend -no-progress -reproducible -mkfs-time 0 -all-time 0
```

- [ ] **Step 2: Boot with the image on virtio-blk and mount it**

Write a throwaway node harness (copy `runtime/demo/node/attach.mjs`) that fetches `base.squashfs` into an ArrayBuffer and passes it as `squashfs` through `bootLinux` (you'll add the `boot.js` plumbing in Task 5; for the spike, pass it directly to the worker boot message). At the guest shell run:

```sh
ls -l /dev/vd*                 # expect a virtio-blk node, e.g. /dev/vda
mkdir -p /mnt/sq && mount -t squashfs -o ro /dev/vda /mnt/sq
cat /mnt/sq/store/aaaa-test/data.txt    # expect: hello
```

Expected: the mount succeeds and `data.txt` prints `hello`. If `mount` fails with `no such device`, recheck `CONFIG_SQUASHFS`/`CONFIG_SQUASHFS_ZSTD`; if `/dev/vda` is absent, recheck the patch-0017 registration + `CONFIG_VIRTIO_BLK`.

- [ ] **Step 3: Prove mmap-exec off squashfs (the key NOMMU risk)**

```sh
/mnt/sq/store/aaaa-test/prog    # a guest binary exec'd directly off squashfs
```

Expected: the program runs. This exercises the NOMMU read-only file-mmap-for-exec path (patch 0016) against squashfs's `readpage`. If it SIGILLs / fails, capture the dmesg and stop — this is the gating risk; investigate squashfs `address_space_operations` vs patch 0016 before proceeding.

- [ ] **Step 4: Tune the block size**

Repeat Steps 1–3 with `-b 16384`, `-b 65536`, and the default `-b 131072`, watching for NOMMU page-allocation-failure messages in dmesg during mount/read (the order-N contiguous-alloc risk). Record the largest block size that boots cleanly.

- [ ] **Step 5: Document findings + commit**

Write `docs/superpowers/notes/squashfs-nommu-spike.md`: kernel configs needed, the chosen `-b` block size and why, the `/dev/vdX` node name, and confirmation that mount + read + mmap-exec all work. Commit:

```bash
git add docs/superpowers/notes/squashfs-nommu-spike.md
git commit -m "docs: squashfs-on-NOMMU spike findings (#43)"
```

**GATE:** Do not proceed to Phase 1 until Task 3 Steps 2–3 pass.

---

# Phase 1 — Production base squashfs + boot integration

## Task 4: Build the base squashfs (`base-squashfs.nix` + flake output)

**Files:**
- Create: `userspace/base-squashfs.nix`
- Modify: `flake.nix` (add `wasmBaseSquashfs` let-binding + `packages.wasm-base-squashfs`; near `wasmStoreManifest` ~lines 322–326 and `packages` ~line 486)

**Interfaces:**
- Consumes: `wasmToplevel` (the assembled guest system closure, `flake.nix:304`), `pkgs` (native), the spike's chosen block size.
- Produces: flake output `.#wasm-base-squashfs` = a single `base.squashfs` file whose image root contains `store/<hash>…` and `var/nix/profiles/system → <toplevel>`.

- [ ] **Step 1: Write `userspace/base-squashfs.nix`**

```nix
# base-squashfs.nix — the base-system store closure as ONE read-only squashfs
# image (the NixOS live-ISO design). The runtime serves it over virtio-blk; the
# guest mounts it -t squashfs as the /nix overlay lowerdir. Replaces store.json
# (#43). The image root holds store/<hash>… + var/nix/profiles/system → toplevel
# (the symlink bootstrap reads), so mounting at /mnt/nix-ro and overlaying to
# /nix resolves /nix/store/* and /nix/var/nix/profiles/system in-guest.
{ pkgs, toplevel, blockSize ? 65536 }:
let
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "base-squashfs"
  { nativeBuildInputs = [ pkgs.squashfsTools ]; }
  ''
    mkdir -p root/nix/store root/nix/var/nix/profiles
    # Copy the closure's store paths to their real /nix/store locations.
    while read -r p; do
      cp -a "$p" "root$p"
    done < ${closure}/store-paths
    # The system profile symlink the bootstrap reads (absolute target so it
    # resolves against the /nix guest mount, like a real Nix profile symlink).
    ln -s ${toplevel} root/nix/var/nix/profiles/system

    mkdir -p $out
    mksquashfs root/nix $out/base.squashfs \
      -comp zstd -b ${toString blockSize} \
      -all-root -noappend -no-progress -reproducible -mkfs-time 0 -all-time 0
    echo "base.squashfs: $(du -h $out/base.squashfs | cut -f1)"
  ''
```

(Use the block size chosen in Task 3 as the default.)

- [ ] **Step 2: Wire the flake output**

In `flake.nix`, add a let-binding near `wasmStoreManifest`:

```nix
      wasmBaseSquashfs = import ./userspace/base-squashfs.nix {
        inherit pkgs; toplevel = wasmToplevel;
      };
```

and in `packages`, replace `wasm-store-manifest = wasmStoreManifest;` with:

```nix
        wasm-base-squashfs = wasmBaseSquashfs;
```

- [ ] **Step 3: Build it**

Run: `sudo nix build .#wasm-base-squashfs --print-out-paths`
Expected: a store path containing `base.squashfs`. Note its size — it must be materially smaller than the old 348 MB set (toolchain still present until Task 7, so expect ~300+ MB here; the big drop comes in Task 7).

- [ ] **Step 4: Verify the image layout**

```bash
nix shell nixpkgs#squashfsTools -c unsquashfs -ll $(sudo nix build .#wasm-base-squashfs --print-out-paths --no-link)/base.squashfs | grep -E 'var/nix/profiles/system|store$' | head
```
Expected: `store` dir present at image root; `var/nix/profiles/system` is a symlink to a `/nix/store/…` toplevel path.

- [ ] **Step 5: Commit**

```bash
git add userspace/base-squashfs.nix flake.nix
git commit -m "build: base-system store as a squashfs image (.#wasm-base-squashfs) (#43)"
```

## Task 5: Boot integration — serve squashfs, delete the manifest path, mount in bootstrap

**Files:**
- Modify: `runtime/boot.js`, `runtime/boot-nix-system.js`, `runtime/index.js`, `userspace/bootstrap.nix`
- Delete: `runtime/nix-closure-store.js`, `runtime/nix-closure-store.test.js`

**Interfaces:**
- Consumes: `BlkDevice` worker wiring (Task 2), `.#wasm-base-squashfs` (Task 4).
- Produces: `bootNixSystem` obtains `base.squashfs` via the **injected-bytes-or-fallback-fetch seam** (`opts.squashfs` = `ArrayBuffer | (() => Promise<ArrayBuffer>)`, supplied by pc's disc-package system; else fetched from `baseUrl`) and the guest overlays it to `/nix`. The `nixStore`/`nix` 9P export is gone; `nixCache` is unchanged.

- [ ] **Step 1: Thread the squashfs buffer through `boot.js`**

In `runtime/boot.js`:
1. Add to the opts JSDoc and accept `opts.squashfs` (an `ArrayBuffer`).
2. Remove the `nixStore` opt + `if (opts.nixStore) exports.nix = opts.nixStore;` line (and its JSDoc).
3. Include the buffer in the worker boot `postMessage` payload (the `{ vmlinux, boot_cmdline, initrd, … }` object ~line 156) as `squashfs: opts.squashfs` and add it to the transfer list `[…]` so it's moved, not copied. (If `opts.squashfs` is undefined, omit it / pass nothing.)

- [ ] **Step 2: Wire the squashfs seam in `boot-nix-system.js`**

In `runtime/boot-nix-system.js`:
1. Remove `import { createNixClosureStore } …` and the `nixStore: …` line.
2. Accept injected bytes/provider, falling back to a `baseUrl` fetch — so pc's disc-package system supplies the verified, persisted bytes in production, while the node harnesses/dev/CI fetch `base.squashfs` directly. Add `squashfs?` to the opts JSDoc (`ArrayBuffer | (() => Promise<ArrayBuffer>)`):

```js
  // The base store squashfs: pc's disc-package system passes the verified,
  // persisted bytes via opts.squashfs (ArrayBuffer or a provider fn); standalone
  // harnesses/dev/CI omit it and we fetch base.squashfs from baseUrl.
  let squashfs;
  if (useNix) {
    if (typeof opts.squashfs === "function") squashfs = await opts.squashfs();
    else if (opts.squashfs) squashfs = opts.squashfs;
    else squashfs = await (await fetch(u("base.squashfs"))).arrayBuffer();
  }
  return bootLinux({
    vfs: opts.vfs,
    vmlinuxUrl: u("vmlinux.wasm"),
    initrdUrl: u("initramfs.cpio.gz"),
    consoleCount: opts.consoleCount,
    cmdline: opts.cmdline,
    onLog: opts.onLog,
    onModuleCached: opts.onModuleCached,
    wayland: opts.wayland,
    squashfs,
    nixCache: useNix ? createNixCacheExport(u("nix-cache")) : undefined,
  });
```

3. Update the artifact-layout comment at the top: `vmlinux.wasm  initramfs.cpio.gz  base.squashfs  nix-cache/`.

- [ ] **Step 3: Drop the index re-export**

In `runtime/index.js`, remove the `export { createNixClosureStore } …` line.

- [ ] **Step 4: Delete the manifest serving code**

```bash
git rm runtime/nix-closure-store.js runtime/nix-closure-store.test.js
```

- [ ] **Step 5: Swap the lowerdir mount in `bootstrap.nix`**

In `userspace/bootstrap.nix`, replace the `aname=nix` 9P mount + overlay block (~lines 53–62) so the lower comes from squashfs. Keep the `/nix-cache` and `/mnt/pc` 9P mounts and the ramfs-upper overlay structure identical:

```sh
  # The served base-system closure: a read-only squashfs on virtio-blk ->
  # overlay lower; ramfs upper makes /nix writable for nix-env. NOMMU has no
  # block-backed writable fs, so the upper is ramfs (as before).
  mkdir -p /mnt/nix-ro
  if mount -t squashfs -o ro /dev/vda /mnt/nix-ro 2>/dev/null; then
    mount -t overlay overlay \
      -o lowerdir=/mnt/nix-ro,upperdir=/nix-upper/u,workdir=/nix-upper/w /nix \
      || { echo "pc: /nix overlay failed; falling back to ramfs /nix"; mkdir -p /nix/store; }
  else
    echo "pc: served store not mounted; booting empty ramfs /nix"
  fi
```

(Match the exact existing upperdir/workdir paths in the current file — copy them verbatim from the block you're replacing. Use the `/dev/vdX` node confirmed in the Task 3 spike.)

- [ ] **Step 6: Rebuild artifacts**

```bash
sudo nix build .#vmlinux .#wasm-initramfs .#wasm-base-squashfs --print-out-paths
```
Assemble an artifacts dir (`vmlinux.wasm`, `initramfs.cpio.gz`, `base.squashfs`, and the existing `nix-cache/`) for the smoke harness.

- [ ] **Step 7: Boot smoke — `/nix` overlay + substitute `sl`**

Run: `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/smoke.mjs`
Expected: exit 0 — boot → `/nix` overlay (now squashfs-backed) → `nix-env -iA sl` substitutes from the cache and renders (Phase A + B PASS). Exit 2 = boot panic, re-run; exit 1 = real failure, debug.

- [ ] **Step 8: Runtime gates**

Run: `cd runtime && bun run test && bun run lint && bun run format:check && bun run typecheck`
Expected: all pass (the deleted `nix-closure-store.test.js` is gone; no dangling imports).

- [ ] **Step 9: Commit**

```bash
git add runtime/boot.js runtime/boot-nix-system.js runtime/index.js userspace/bootstrap.nix
git commit -m "runtime+boot: serve base /nix from squashfs over virtio-blk; drop store.json path (#43)"
```

---

# Phase 2 — Toolchain → NAR binary cache, removed from base

## Task 6: Publish the compiler toolchain to a Nix binary cache

**Files:**
- Create: `userspace/binary-cache.nix`
- Modify: `flake.nix` (add `wasmBinaryCache` let-binding + `packages.wasm-binary-cache`)

**Interfaces:**
- Consumes: `guestClang`, `guestCc`, `guestCxx`, `makeWasm` (the compiler tools, `flake.nix:292`), plus existing demo pkgs (e.g. `sl`); `pkgs` (native, for `nix`).
- Produces: flake output `.#wasm-binary-cache` = a `file://` binary cache dir (`nix-cache-info` + `*.narinfo` + `nar/*.nar.zst` + the `.drv`s) + a `pkgs.nix` exposing the toolchain attrs.

- [ ] **Step 1: Write `userspace/binary-cache.nix`**

```nix
# binary-cache.nix — the on-demand packages (compiler toolchain + demo pkgs)
# published as a STANDARD Nix binary cache (nix-cache-info + narinfo + nar/),
# served by runtime/nix-cache.js and substituted in-guest via `nix-env -iA`
# exactly as real Nix does (#43 / folds in #2 + #1). The compiler tools are NOT
# in the base squashfs; they arrive here, on demand. Real .drvs are included so
# `nix profile install` works too (#1). Production signing + upload to R2 is the
# separate publish system's job (out of scope) — this derivation produces the
# cache content + a pkgs.nix index.
{ pkgs, devPaths, pkgsNix }:
pkgs.runCommand "wasm-binary-cache"
  { nativeBuildInputs = [ pkgs.nix ]; }
  ''
    mkdir -p $out
    export NIX_STATE_DIR=$TMPDIR/state NIX_STORE_DIR=/nix/store
    # Copy the closures (with .drvs) into a file:// binary cache, zstd-compressed.
    nix --extra-experimental-features nix-command copy \
      --no-check-sigs \
      --to "file://$out?compression=zstd" \
      ${pkgs.lib.concatStringsSep " " devPaths}
    # The guest's defexpr: `nix-env -iA <attr>` resolves these to substitutable
    # paths (bootstrap copies /nix-cache/pkgs.nix to ~/.nix-defexpr).
    cp ${pkgsNix} $out/pkgs.nix
  ''
```

(`devPaths` = the list of toolchain + demo store paths; `pkgsNix` = a `pkgs.nix` file mapping attrs → those paths. If a `pkgs.nix` already exists for the current `sl` cache, extend it; otherwise generate one with `pkgs.writeText` listing `{ clang = …; cc = …; "c++" = …; make = …; dev-tools = buildEnv[…]; sl = …; }`.)

- [ ] **Step 2: Add a `dev-tools` convenience attr**

In the `pkgs.nix` content, include a `dev-tools` attribute that is a `pkgs.buildEnv`/`symlinkJoin` of `[ guestClang guestCc guestCxx makeWasm ]` so `nix-env -iA dev-tools` installs the whole compiler set in one go.

- [ ] **Step 3: Wire the flake output**

In `flake.nix` add:

```nix
      wasmBinaryCache = import ./userspace/binary-cache.nix {
        inherit pkgs;
        devPaths = [ guestClang guestCc guestCxx makeWasm /* + sl etc. */ ];
        pkgsNix = <writeText pkgs.nix>;
      };
```

and `packages.wasm-binary-cache = wasmBinaryCache;`.

- [ ] **Step 4: Build it**

Run: `sudo nix build .#wasm-binary-cache --print-out-paths`
Expected: a store path containing `nix-cache-info`, `*.narinfo`, `nar/`, `pkgs.nix`. Verify: `ls $(…)/` shows those, and `cat $(…)/nix-cache-info` shows `StoreDir: /nix/store`.

- [ ] **Step 5: Verify a narinfo carries a Deriver (the #1 fix)**

```bash
grep -l Deriver $(sudo nix build .#wasm-binary-cache --print-out-paths --no-link)/*.narinfo | head
```
Expected: at least one `.narinfo` has a `Deriver:` line (real `.drv` present) — this is what lets `nix profile install` accept it.

- [ ] **Step 6: Commit**

```bash
git add userspace/binary-cache.nix flake.nix
git commit -m "build: publish compiler toolchain as a NAR binary cache (.#wasm-binary-cache) (#2/#1/#43)"
```

## Task 7: Remove the compiler toolchain from the base; prove on-demand install

**Files:**
- Modify: `userspace/system.nix` (`systemPackages` ~lines 99–109; `nix.settings` ~line 173), `flake.nix` (the `toolchain = [ … ]` list at `flake.nix:292`)

**Interfaces:**
- Consumes: `.#wasm-binary-cache` (Task 6), `.#wasm-base-squashfs` (now slim).
- Produces: a base squashfs WITHOUT the compiler toolchain; `nix-env -iA dev-tools` installs it from the cache; `cc hello.c` then works in-guest.

- [ ] **Step 1: Drop the compiler tools from the system `toolchain` list**

In `flake.nix:292`, change:

```nix
        toolchain = [ nixWasmClean guestClang guestCc guestCxx makeWasm wasmAsh ];
```
to keep only `nix` + `ash` in the base:

```nix
        toolchain = [ nixWasmClean wasmAsh ];
```

(The compiler tools now live only in `.#wasm-binary-cache`.)

- [ ] **Step 2: Configure cache trust in `system.nix`**

In `userspace/system.nix` near `nix.settings.substituters` (line 173), keep `substituters = [ "file:///nix-cache" ]` and ensure substitution from the file cache works without a signature gate (the cache is a trusted same-deploy artifact; production signing happens in CI — Task 9):

```nix
        nix.settings.require-sigs = lib.mkForce false;
```

(When CI signs the published cache, swap this for `trusted-public-keys = [ "<key>" ]` with the CI-published public key.)

- [ ] **Step 3: Rebuild the base squashfs + confirm the toolchain is gone**

```bash
sudo nix build .#wasm-base-squashfs --print-out-paths
nix shell nixpkgs#squashfsTools -c unsquashfs -ll $(…)/base.squashfs | grep -iE 'clang|wasm-ld|/cc$|/c\+\+$' | head
```
Expected: **no** clang/wasm-ld/cc/c++ paths in the image; `base.squashfs` size dropped substantially (toolchain ~89 MB gone). Record the new size.

- [ ] **Step 4: Assemble artifacts incl. the new cache**

Build `.#vmlinux .#wasm-initramfs .#wasm-base-squashfs .#wasm-binary-cache`; assemble an artifacts dir where `nix-cache/` is the `.#wasm-binary-cache` output.

- [ ] **Step 5: End-to-end — `clang` absent, then substituted, then compiles**

Boot the interactive shell:

```bash
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/attach.mjs
```
In-guest:

```sh
which clang || echo "ABSENT (expected)"        # expect ABSENT
nix-env -iA dev-tools                            # substitutes the toolchain from the cache
which clang                                       # now present
printf 'int main(){return 42;}' > /tmp/h.c
cc /tmp/h.c -o /tmp/h && /tmp/h; echo $?         # expect 42
```
Expected: `clang` absent in base → installs from cache → `cc` compiles and runs. This proves "install dev tools exactly like real Nix" end-to-end.

- [ ] **Step 6: Re-run the boot smoke (regression)**

Run: `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/smoke.mjs`
Expected: exit 0 (Phase A + B still PASS with the slim base).

- [ ] **Step 7: Commit**

```bash
git add flake.nix userspace/system.nix
git commit -m "system: remove compiler toolchain from base; install on demand from cache (#43)"
```

---

# Phase 3 — Cleanup, vendoring, docs

## Task 8: Delete the manifest builder, update sync + docs

**Files:**
- Delete: `userspace/store-manifest.nix`, `userspace/store-manifest.py`
- Modify: `flake.nix` (remove any remaining `wasmStoreManifest` references), `runtime/sync-to-pc.sh`, `CLAUDE.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: no remaining references to the old manifest path; `sync-to-pc.sh` ships the new engine file set.

- [ ] **Step 1: Delete the manifest builder**

```bash
git rm userspace/store-manifest.nix userspace/store-manifest.py
```

- [ ] **Step 2: Remove dangling flake references**

Run: `grep -n "store-manifest\|wasmStoreManifest\|wasm-store-manifest\|store.json\|store-content" flake.nix`
Expected: no matches. Remove any that remain.

- [ ] **Step 3: Update `sync-to-pc.sh`**

In `runtime/sync-to-pc.sh`, in the engine `cp` line, **remove** `nix-closure-store.js` and **add** the block device to the virtio `cp` list (`virtio/{…,blk-device.js}`). Verify no removed file is still listed:

Run: `grep -n "nix-closure-store\|blk-device" runtime/sync-to-pc.sh`
Expected: `blk-device.js` present, `nix-closure-store` absent.

- [ ] **Step 4: Update the artifact-layout note**

Update the memory/docs note that the lazy-blob dir is `store-content/` — that mechanism is gone. In any in-repo doc referencing `store.json`/`store-content/`, replace with the `base.squashfs` + `nix-cache/` contract. Run `grep -rn "store.json\|store-content" --include=*.md --include=*.mjs --include=*.js runtime docs` and fix stragglers (excluding this plan/spec).

- [ ] **Step 5: Update `CLAUDE.md`**

Edit `CLAUDE.md`: (a) Architecture — the guest userspace `/nix` is now a squashfs over virtio-blk + the on-demand NAR cache, not `store.json`; (b) Current state — note #43 done; (c) Hard-won learnings — add a squashfs/virtio-blk entry pointing to `docs/superpowers/notes/squashfs-nommu-spike.md` and the NOMMU block-size finding; (d) remove the now-false `store-manifest`/`store.json` references and the "store-manifest splits large files into store-content blobs" learning.

- [ ] **Step 6: Full build + smoke regression**

```bash
sudo nix build .#vmlinux .#wasm-initramfs .#wasm-base-squashfs .#wasm-binary-cache --print-out-paths
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/smoke.mjs
cd runtime && bun run test && bun run lint && bun run format:check && bun run typecheck
```
Expected: builds succeed; smoke exit 0; all four gates pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "cleanup: delete store.json manifest path; update sync + docs (#43)"
```

---

# Phase 4 — CI publishing to R2 (#2 / Phase 5)

## Task 9: CI builds the wasm outputs on x86_64 and writes them to R2

**Files:**
- Create: `.github/workflows/publish-wasm-artifacts.yml`
- Create: `scripts/publish-to-r2.sh` (the build → hash → upload step, reusable locally for the manual "deploy" flow)
- Modify: `docs/superpowers/notes/squashfs-nommu-spike.md` or a new `docs/superpowers/notes/deploy-r2.md` (the deploy runbook)

**Interfaces:**
- Consumes: `.#wasm-base-squashfs`, `.#wasm-binary-cache`, `.#vmlinux`, `.#wasm-initramfs`.
- Produces: R2 objects `packages/nix-wasm-base/<version>` (the squashfs) and the binary-cache tree under its R2 prefix, with CORP+CORS+immutable headers (via the preview-worker route); prints `bytes`/`sha256`/`version` for the pc `registry.js` entry.

> **Cross-repo note:** the **consumer** side (pc `js/packages/registry.js` entry, the `installCore` identity-mount shim, and the `bootNixSystem({ squashfs })` wiring) lives in **pc** and is a follow-up PR there. This task produces and publishes the bytes + emits the registry values; it does not edit pc.

- [ ] **Step 1: Write `scripts/publish-to-r2.sh` (build + hash + upload)**

```bash
#!/usr/bin/env bash
# publish-to-r2.sh — build the wasm artifacts and upload them to the pc-previews
# R2 bucket via wrangler (the preview-worker stamps CORP+CORS on /packages).
# VERSION = the squashfs content hash (immutable, path-versioned object).
# Requires: CLOUDFLARE_API_TOKEN + R2 creds in the env (CI secrets); never inline.
set -euo pipefail
NIX="nix --extra-experimental-features 'nix-command flakes'"
SQ=$($NIX build .#wasm-base-squashfs --print-out-paths --no-link)/base.squashfs
CACHE=$($NIX build .#wasm-binary-cache --print-out-paths --no-link)
SHA=$(sha256sum "$SQ" | cut -d' ' -f1)
BYTES=$(stat -c%s "$SQ")
VERSION="$SHA"  # content-addressed; safe to immutable-cache forever
echo "base.squashfs bytes=$BYTES sha256=$SHA version=$VERSION"

# Upload the base squashfs (raw octet-stream; Linux consumes it directly).
bunx wrangler r2 object put \
  "pc-previews/packages/nix-wasm-base/$VERSION" \
  --file "$SQ" --content-type application/octet-stream --remote

# Upload the binary-cache tree (nix-cache-info + *.narinfo + nar/*) under its prefix.
( cd "$CACHE" && find . -type f -print0 | while IFS= read -r -d '' f; do
    bunx wrangler r2 object put "pc-previews/nix-cache/${f#./}" \
      --file "$f" --content-type application/octet-stream --remote
  done )

echo "PUBLISHED nix-wasm-base version=$VERSION"
echo "→ update pc js/packages/registry.js: bytes=$BYTES sha256=$SHA version=$VERSION"
```

(`--remote` is MANDATORY — wrangler 4.x writes the local simulator otherwise and the live URL 404s.)

- [ ] **Step 2: Verify the live objects (manual deploy gate)**

```bash
curl -I https://pc-previews.eric-c6b.workers.dev/packages/nix-wasm-base/<version>
```
Expected: `200`, `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`. (If `Not found`, the preview-worker on the deployed branch lacks the route or `--remote` was omitted — see the pc disc-packages rule.)

- [ ] **Step 3: Write the GitHub Actions workflow**

Create `.github/workflows/publish-wasm-artifacts.yml`: run on `x86_64-linux` (fully cached nixpkgs — avoids from-source LLVM), install Nix + the `nixos-26.05` pin, install `bun`/`wrangler`, run `scripts/publish-to-r2.sh` with R2 creds from `secrets`. Trigger on push to `master` (and `workflow_dispatch`). Emit `bytes`/`sha256`/`version` as a job summary so the pc registry update is copy-paste.

```yaml
name: publish-wasm-artifacts
on:
  push: { branches: [ master ] }
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-latest        # x86_64-linux, cached cache.nixos.org
    steps:
      - uses: actions/checkout@v4
      - uses: cachix/install-nix-action@v27
        with: { nix_path: nixpkgs=channel:nixos-26.05 }
      - uses: oven-sh/setup-bun@v2
      - name: Build + publish to R2
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: bash scripts/publish-to-r2.sh | tee -a "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 4: Write the deploy runbook**

Create `docs/superpowers/notes/deploy-r2.md`: the manual `scripts/publish-to-r2.sh` flow, the `curl -I` verification, the `--remote` + preview-worker-route gotchas (cite the pc `.claude/rules/disc-packages.md`), and the "bump pc `registry.js` `version`/`sha256`/`bytes`" step that finalizes a release.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-wasm-artifacts.yml scripts/publish-to-r2.sh docs/superpowers/notes/deploy-r2.md
git commit -m "ci: build wasm artifacts on x86_64 and publish to R2 (#2/#43)"
```

> **Note on CI validation:** the workflow can't be fully green-verified without R2 secrets + a deployed preview-worker route; Step 2's `curl -I` is the real gate. Until secrets are wired, run `scripts/publish-to-r2.sh` locally (with creds) to publish, then verify with `curl -I`.

---

## Self-Review Notes (coverage against the spec)

- §1 base squashfs → Task 4 (build) + Task 1/3 (kernel+mount) + Task 5 (boot wiring). NOMMU block-size tuning → Task 3 Step 4.
- §2 toolchain → binary cache → Task 6 (publish, real `.drv`s #1) + Task 7 (remove from base, e2e). Signing: `require-sigs=false` locally; production signing in CI (Task 9 / Task 7 Step 2).
- §3 kernel → Task 1 (configs + patch 0017); mmap-for-exec de-risk validated in Task 3 Step 3.
- §4 runtime → Task 2 (BlkDevice + worker) + Task 5 (boot.js/boot-nix-system/index, delete nix-closure-store). The injected-bytes-or-fallback-fetch seam → Task 5 Step 2.
- §5 bootstrap mount swap → Task 5 Step 5.
- §6 vendoring/pc → Task 8 (sync-to-pc, docs). Disc-package delivery (download/verify/wizard/update/offline) reused via pc's `installCore` with an identity mount; the squashfs bytes reach `bootNixSystem` through the Task 5 Step 2 seam. pc-side consumer wiring is a follow-up in pc.
- §7 testing/acceptance → blk unit tests (Task 2), boot smoke (Task 5/7/8), the `which clang`→install→`cc` e2e (Task 7 Step 5), size assertion (Task 7 Step 3).
- "Deploy the built image" + CI → R2 → Task 9 (`scripts/publish-to-r2.sh` + workflow + `deploy-r2.md` runbook).
- Deletions (store.json/store-manifest/nix-closure-store) → Tasks 5 + 8.

**Open item carried to execution:** confirm `vring.js` method names (`popAvail`/`chain`/`pushUsed`) in Task 2 Step 1 and use the existing API verbatim.
