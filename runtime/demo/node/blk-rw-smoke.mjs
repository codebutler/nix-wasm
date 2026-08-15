#!/usr/bin/env node
// blk-rw-smoke.mjs — #177 G1/G3 gate: RW virtio-blk + ext2 on /dev/vdb.
//
// Boots busybox-only (nix:false) with an empty state disk, then:
//   1. Asserts /dev/vdb exists
//   2. mkfs.ext2 /dev/vdb && mount -t ext2 /dev/vdb /mnt/state
//   3. Writes a marker file, syncs, umounts
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

/** Run a guest command; expectRe must not be a substring of the command text. */
async function runGuest(session, script, expectRe, ms = 120_000) {
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

    // Markers use KEY=value so the echoed command (which has KEY=$?) cannot
    // satisfy the regex — same rule as clock-smoke / exec-reject-smoke.
    await runGuest(s1, "test -b /dev/vdb; echo VDB_STAT=$?", /VDB_STAT=0/, 30_000);
    await runGuest(s1, "mkfs.ext2 -F -q /dev/vdb; echo MKFS_STAT=$?", /MKFS_STAT=0/, 60_000);
    await runGuest(
      s1,
      "mkdir -p /mnt/state && mount -t ext2 /dev/vdb /mnt/state; echo MOUNT_STAT=$?",
      /MOUNT_STAT=0/,
      30_000,
    );
    await runGuest(
      s1,
      `echo ${MARKER} > /mnt/state/marker && sync && cat /mnt/state/marker | sed 's/^/MARKER_OUT /'; echo MARKER_STAT=$?`,
      new RegExp(`MARKER_OUT ${MARKER}`),
      30_000,
    );
    await runGuest(s1, "umount /mnt/state; echo UMOUNT_STAT=$?", /UMOUNT_STAT=0/, 30_000);
  } catch (e) {
    console.error("phase1 failed:", e.message || e);
    console.error("── transcript ──\n" + s1.snapshot().slice(-2500));
    s1.kill();
    process.exit(1);
  }

  if (!s1.handle.hasStateDisk()) {
    console.error("FAIL: hasStateDisk() false");
    s1.kill();
    process.exit(1);
  }
  const blob = s1.handle.saveDisk();
  if (!blob || blob.size <= 16) {
    console.error(
      "FAIL: saveDisk() returned empty overlay (size=%s dirties=%d)",
      blob?.size,
      dirtyN,
    );
    s1.kill();
    process.exit(1);
  }
  const overlay = new Uint8Array(await blob.arrayBuffer());
  const overlayCount = new DataView(
    overlay.buffer,
    overlay.byteOffset,
    overlay.byteLength,
  ).getUint32(12, true);
  if (overlayCount < 1) {
    console.error("FAIL: saveDisk CBHD count=0 (size=%d dirties=%d)", overlay.byteLength, dirtyN);
    s1.kill();
    process.exit(1);
  }
  const secondBlob = s1.handle.saveDisk();
  if (!secondBlob || secondBlob.size !== 16) {
    console.error(
      "FAIL: second save re-emitted the populated baseline (size=%s, expected=16)",
      secondBlob?.size,
    );
    s1.kill();
    process.exit(1);
  }
  s1.kill();

  // Reboot with dirties applied onto a fresh zero image.
  const image2 = new Uint8Array(STATE_BYTES);
  applyDirtyOverlay(image2, overlay);
  let nonzero = 0;
  for (let i = 0; i < image2.length; i++) if (image2[i]) nonzero++;
  if (nonzero < BLK_SECTOR) {
    console.error(
      "FAIL: applied overlay left image essentially empty (count=%d nonzero=%d)",
      overlayCount,
      nonzero,
    );
    process.exit(1);
  }
  const markerBytes = new TextEncoder().encode(MARKER);
  let markerAt = -1;
  outer: for (let i = 0; i <= image2.length - markerBytes.length; i++) {
    for (let j = 0; j < markerBytes.length; j++) {
      if (image2[i + j] !== markerBytes[j]) continue outer;
    }
    markerAt = i;
    break;
  }
  if (markerAt < 0) {
    console.error(
      "FAIL: marker bytes missing from restored image (count=%d dirties=%d nonzero=%d)",
      overlayCount,
      dirtyN,
      nonzero,
    );
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
      "mkdir -p /mnt/state && mount -t ext2 /dev/vdb /mnt/state; echo REMOUNT_STAT=$?",
      /REMOUNT_STAT=0/,
      30_000,
    );
    await runGuest(
      s2,
      `cat /mnt/state/marker | sed 's/^/MARKER2_OUT /'; echo PHASE2_STAT=$?`,
      new RegExp(`MARKER2_OUT ${MARKER}`),
      30_000,
    );
    if (!out.includes("REMOUNT_STAT=0") && !s2.snapshot().includes("REMOUNT_STAT=0")) {
      throw new Error("remount failed\n" + s2.snapshot().slice(-1500));
    }
  } catch (e) {
    console.error("phase2 failed:", e.message || e);
    console.error("── transcript ──\n" + s2.snapshot().slice(-2500));
    s2.kill();
    process.exit(1);
  }
  s2.kill();
  console.log(
    "PASS: RW virtio-blk ext2 persists across saveDisk + reboot (G1/G3) overlay=%dB sectors=%d dirties=%d",
    overlay.byteLength,
    overlayCount,
    dirtyN,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
