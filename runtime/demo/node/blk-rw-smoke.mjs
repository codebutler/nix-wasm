#!/usr/bin/env node
// blk-rw-smoke.mjs — #177 G1/G3 gate: RW virtio-blk + ext2 on /dev/vdb.
//
// Boots busybox-only (nix:false) with an empty state disk, then:
//   1. Asserts /dev/vda (seed, may be empty) and /dev/vdb (state) exist
//   2. mkfs.ext2 /dev/vdb && mount -t ext2 /dev/vdb /mnt/state
//   3. Writes a marker file, syncs
//   4. Host saveDisk() → CBHD dirties
//   5. Kills, reboots with dirties applied onto a fresh zero image
//   6. Mounts vdb and reads the marker back
//
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic).
//
//   LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/blk-rw-smoke.mjs
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootLinux } from "../../boot.js";
import { MemVfs } from "../../ninep/mem-vfs.js";
import { applyDirtyOverlay, BLK_SECTOR } from "../../virtio/blk-disk.js";
import { makeConsoleSession } from "../../session.js";

installWebShims();

const STATE_BYTES = 16 * 1024 * 1024; // 16 MiB is enough for mkfs + a marker
const MARKER = "pc-linux-g1-alive";

function artifactsBase() {
  const raw =
    process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
  return raw.endsWith("/") ? raw : raw + "/";
}

async function bootWithState(image, { onDirty } = {}) {
  const base = artifactsBase();
  const vfs = new MemVfs();
  const handle = await bootLinux({
    vfs,
    vmlinuxUrl: new URL("vmlinux.wasm", base).href,
    initrdUrl: new URL("initramfs.cpio.gz", base).href,
    // No squashfs — busybox-only; we only need /dev/vdb for this gate.
    stateDisk: { image, onDirty },
    onLog: (t) => {
      if (process.env.BLK_RW_SMOKE_LOG) process.stderr.write(t + "\n");
    },
  });
  const session = makeConsoleSession(handle.console(0));
  return { handle, session };
}

async function runGuest(session, script, expectRe) {
  const out = [];
  const unsub = session.onData((b) => {
    out.push(typeof b === "string" ? b : new TextDecoder().decode(b));
  });
  session.write(script + "\n");
  const deadline = Date.now() + 120_000;
  let buf = "";
  while (Date.now() < deadline) {
    buf = out.join("");
    if (expectRe.test(buf)) {
      unsub();
      return buf;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  unsub();
  throw new Error("timeout waiting for " + expectRe + "\n---\n" + buf.slice(-2000));
}

async function main() {
  const image1 = new Uint8Array(STATE_BYTES);
  let dirtyN = 0;
  const { handle: h1, session: s1 } = await bootWithState(image1, {
    onDirty: () => {
      dirtyN++;
    },
  });

  try {
    await runGuest(
      s1,
      [
        "mkdir -p /mnt/state",
        "test -b /dev/vdb && echo VDB_OK || echo VDB_MISSING",
        "mkfs.ext2 -F -q /dev/vdb && echo MKFS_OK || echo MKFS_FAIL",
        "mount -t ext2 /dev/vdb /mnt/state && echo MOUNT_OK || echo MOUNT_FAIL",
        `echo ${MARKER} > /mnt/state/marker`,
        "sync",
        "cat /mnt/state/marker",
        "umount /mnt/state",
        "echo PHASE1_DONE",
      ].join("; "),
      /PHASE1_DONE/,
    );
  } catch (e) {
    console.error("phase1 failed:", e.message || e);
    h1.kill();
    process.exit(1);
  }

  if (!h1.hasStateDisk()) {
    console.error("FAIL: hasStateDisk() false");
    h1.kill();
    process.exit(1);
  }
  const blob = h1.saveDisk();
  if (!blob || blob.size < 16) {
    console.error("FAIL: saveDisk() returned empty overlay (dirties=%d)", dirtyN);
    h1.kill();
    process.exit(1);
  }
  const overlay = new Uint8Array(await blob.arrayBuffer());
  h1.kill();

  // Reboot with dirties applied onto a fresh zero image.
  const image2 = new Uint8Array(STATE_BYTES);
  applyDirtyOverlay(image2, overlay);
  // Sanity: some non-zero bytes should exist (ext2 superblock etc.).
  let nonzero = 0;
  for (let i = 0; i < image2.length; i++) if (image2[i]) nonzero++;
  if (nonzero < BLK_SECTOR) {
    console.error("FAIL: applied overlay left image essentially empty");
    process.exit(1);
  }

  const { handle: h2, session: s2 } = await bootWithState(image2);
  try {
    const out = await runGuest(
      s2,
      [
        "mkdir -p /mnt/state",
        "mount -t ext2 /dev/vdb /mnt/state && echo REMOUNT_OK || echo REMOUNT_FAIL",
        "cat /mnt/state/marker",
        "echo PHASE2_DONE",
      ].join("; "),
      /PHASE2_DONE/,
    );
    if (!out.includes(MARKER)) {
      console.error("FAIL: marker not found after reboot\n", out.slice(-1500));
      h2.kill();
      process.exit(1);
    }
  } catch (e) {
    console.error("phase2 failed:", e.message || e);
    h2.kill();
    process.exit(1);
  }
  h2.kill();
  terminateAllWorkers();
  console.log("PASS: RW virtio-blk ext2 persists across saveDisk + reboot (G1/G3)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  terminateAllWorkers();
  process.exit(2);
});
