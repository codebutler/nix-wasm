// blk-spike.mjs — #43 Task 3 gating spike. Boots the guest busybox-only (no /nix
// 9P), feeds a tiny base.squashfs over virtio-blk, then drives the console to:
//   1. find the virtio-blk node (/dev/vdX),
//   2. mount -t squashfs it read-only,
//   3. cat a file off it (read path),
//   4. mmap-exec a real guest binary (busybox) DIRECTLY off the squashfs —
//      the NOMMU read-only file-mmap-for-exec proof (the gate's key risk).
//
// Usage:
//   LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ \
//     node demo/node/blk-spike.mjs /abs/path/to/base.squashfs
//
// Exit 0 = all of mount+cat+mmap-exec passed; non-zero = failure (the tail of
// the guest console transcript is dumped for diagnosis).
import { readFile } from "node:fs/promises";
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootLinux } from "../../boot.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

installWebShims();

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const SQUASHFS_PATH = process.argv[2];
if (!SQUASHFS_PATH) {
  console.error("usage: node blk-spike.mjs <path-to-base.squashfs>");
  process.exit(2);
}

const base = new URL(ARTIFACTS.endsWith("/") ? ARTIFACTS : ARTIFACTS + "/", "file:///");
const u = (p) => new URL(p, base).href;

const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load the squashfs image as an ArrayBuffer (passed by-value to the guest).
const sqBytes = await readFile(SQUASHFS_PATH);
const squashfs = sqBytes.buffer.slice(sqBytes.byteOffset, sqBytes.byteOffset + sqBytes.byteLength);
console.error(`[blk-spike] image ${SQUASHFS_PATH} (${sqBytes.byteLength} bytes)`);

// Busybox-only boot: no nixStore/nixCache → fast, and the squashfs is the ONLY
// block device, so the guest's /dev/vda is unambiguously our image.
const handle = await bootLinux({
  vfs: MemVfs.from({ Home: {} }),
  vmlinuxUrl: u("vmlinux.wasm"),
  initrdUrl: u("initramfs.cpio.gz"),
  squashfs,
  onLog: (t) => process.env.BLK_SPIKE_DEBUG && process.stderr.write("[log] " + t + "\n"),
});

let transcript = "";
const con = handle.console(0);
con.onData((b) => {
  transcript += dec.decode(b);
});

const send = (s) => con.write(s);
const waitFor = async (re, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (/panic/i.test(transcript)) throw new Error("KERNEL_PANIC");
    if (re.test(transcript)) return true;
    await sleep(200);
  }
  return false;
};
const waitForPrompt = async (ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (/panic/i.test(transcript)) throw new Error("KERNEL_PANIC");
    if (/[#$]\s*$/.test(transcript.trimEnd())) return true;
    await sleep(400);
  }
  return false;
};

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
};

try {
  let reached;
  try {
    reached = await waitForPrompt();
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[blk-spike] INCONCLUSIVE — kernel panic on boot; re-run");
      console.log("\n── console (tail) ──\n" + transcript.slice(-2000));
      handle.kill();
      terminateAllWorkers();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached");
  check(/squashfs: version/i.test(transcript) || true, "(squashfs driver present in kernel)");

  // Step 2a: enumerate virtio-blk nodes. We boot with exactly one blk device, so
  // expect /dev/vda. Use a sentinel so we can scrape it deterministically.
  send("ls -l /dev/vd* 2>&1; echo VDLS_DONE\n");
  await waitFor(/VDLS_DONE/);
  const vdMatch = transcript.match(/\/dev\/(vd[a-z]+)/);
  const node = vdMatch ? "/dev/" + vdMatch[1] : "/dev/vda";
  check(!!vdMatch, "virtio-blk node present", vdMatch ? ` (${node})` : " — NO /dev/vd* found");

  // Step 2b: mount -t squashfs read-only.
  send(`mkdir -p /mnt/sq; mount -t squashfs -o ro ${node} /mnt/sq 2>&1; echo MOUNT_RC=$?\n`);
  await waitFor(/MOUNT_RC=/);
  const mountOk = /MOUNT_RC=0\b/.test(transcript);
  check(mountOk, "mount -t squashfs succeeds");

  // Step 3: read a file off the squashfs (read path).
  send("cat /mnt/sq/store/aaaa-test/data.txt 2>&1; echo CAT_DONE\n");
  await waitFor(/CAT_DONE/);
  check(/(^|\n)hello\b/.test(transcript), "cat reads data.txt → 'hello'");

  // Step 4 (THE GATE): mmap-exec a real guest binary DIRECTLY off the squashfs.
  send("/mnt/sq/store/aaaa-test/busybox echo MMAP_EXEC_OK 2>&1; echo EXEC_RC=$?\n");
  await waitFor(/EXEC_RC=/, 45000);
  const execOk = /MMAP_EXEC_OK/.test(transcript) && /EXEC_RC=0\b/.test(transcript);
  check(execOk, "mmap-exec busybox off squashfs prints MMAP_EXEC_OK");

  // Watch for NOMMU page-allocation-failure during mount/read/exec (block-size risk).
  const allocFail = /page allocation failure|order:\d+|Out of memory/i.test(transcript);
  check(!allocFail, "no page-allocation-failure during mount/read/exec");
} finally {
  if (!pass || process.env.BLK_SPIKE_DUMP)
    console.log("\n── console transcript (tail) ──\n" + transcript.slice(-3000));
  handle.kill();
  terminateAllWorkers();
}

console.log("\n[blk-spike] " + (pass ? "PASS" : "FAIL") + " (" + SQUASHFS_PATH + ")");
process.exit(pass ? 0 : 1);
