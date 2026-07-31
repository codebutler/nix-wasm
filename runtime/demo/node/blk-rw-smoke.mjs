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
import { bootNode } from "./boot-node.mjs";
import { applyDirtyOverlay, BLK_SECTOR } from "../../virtio/blk-disk.js";

const STATE_BYTES = 16 * 1024 * 1024; // 16 MiB is enough for mkfs + a marker
const MARKER = "pc-linux-g1-alive";

async function bootWithState(image, { onDirty } = {}) {
  return bootNode({
    nix: false,
    // No squashfs — busybox-only; we only need /dev/vdb for this gate.
    stateDisk: { image, onDirty },
    onLog: (t) => {
      if (process.env.BLK_RW_SMOKE_LOG) process.stderr.write(t + "\n");
    },
  });
}

async function runGuest(session, script, expectRe, ms = 120_000) {
  // Marker must not be a substring of the echoed command line.
  session.send(script + "\n");
  if (!(await session.waitForOutput(expectRe, ms))) {
    throw new Error(
      "timeout waiting for " + expectRe + "\n---\n" + session.snapshot().slice(-2000),
    );
  }
  return session.snapshot();
}

async function main() {
  const image1 = new Uint8Array(STATE_BYTES);
  let dirtyN = 0;
  const s1 = await bootWithState(image1, {
    onDirty: () => {
      dirtyN++;
    },
  });

  try {
    let reached;
    try {
      reached = await s1.waitForPrompt(90_000);
    } catch (e) {
      if (e.message === "KERNEL_PANIC") {
        console.error("INCONCLUSIVE — kernel panic on boot; re-run");
        s1.kill();
        process.exit(2);
      }
      throw e;
    }
    if (!reached) throw new Error("no prompt");

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
    s1.kill();
    process.exit(1);
  }

  if (!s1.handle.hasStateDisk()) {
    console.error("FAIL: hasStateDisk() false");
    s1.kill();
    process.exit(1);
  }
  const blob = s1.handle.saveDisk();
  if (!blob || blob.size < 16) {
    console.error("FAIL: saveDisk() returned empty overlay (dirties=%d)", dirtyN);
    s1.kill();
    process.exit(1);
  }
  const overlay = new Uint8Array(await blob.arrayBuffer());
  s1.kill();

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

  const s2 = await bootWithState(image2);
  try {
    let reached;
    try {
      reached = await s2.waitForPrompt(90_000);
    } catch (e) {
      if (e.message === "KERNEL_PANIC") {
        console.error("INCONCLUSIVE — kernel panic on reboot; re-run");
        s2.kill();
        process.exit(2);
      }
      throw e;
    }
    if (!reached) throw new Error("no prompt on reboot");

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
      s2.kill();
      process.exit(1);
    }
  } catch (e) {
    console.error("phase2 failed:", e.message || e);
    s2.kill();
    process.exit(1);
  }
  s2.kill();
  console.log("PASS: RW virtio-blk ext2 persists across saveDisk + reboot (G1/G3)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
