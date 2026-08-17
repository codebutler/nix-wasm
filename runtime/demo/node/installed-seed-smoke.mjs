#!/usr/bin/env node
// installed-seed-smoke.mjs — #177 first-boot capacity regression gate.
//
// Boot the complete shipped Nix system with pc's real 1.75 GiB state-disk
// capacity, wait for the seed copy to finish, and prove that /nix is mounted
// directly from vdb with useful free space. This is intentionally different
// from blk-rw-smoke.mjs: that smoke proves the block journal with a tiny disk;
// this one catches compressed-image growth that only fails while expanding the
// complete seed (the 2026-08-16 ENOSPC regression).
//
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic).
import { bootNode } from "./boot-node.mjs";

const STATE_BYTES = 1792 * 1024 * 1024;
const MIN_FREE_KIB = 512 * 1024;
const BOOT_TIMEOUT_MS = Number(process.env.INSTALLED_SEED_TIMEOUT_MS || 20 * 60_000);

async function main() {
  // Production requires the full SharedArrayBuffer so the host and all kernel
  // workers share one image without a second GiB-scale copy.
  const image = new SharedArrayBuffer(STATE_BYTES);
  const session = await bootNode({
    nix: true,
    stateDisk: { image },
    onLog: (line) => {
      if (process.env.INSTALLED_SEED_SMOKE_LOG) process.stderr.write(line + "\n");
    },
  });

  try {
    let reached;
    try {
      reached = await session.waitForPrompt(BOOT_TIMEOUT_MS);
    } catch (error) {
      if (error.message === "KERNEL_PANIC") {
        console.error("INCONCLUSIVE — kernel panic during full seed install; re-run");
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    if (!reached) throw new Error("full seed install did not reach a prompt");

    let transcript = session.snapshot();
    if (/Unable to allocate RAM for stack|nommu: Allocation of length .* failed/.test(transcript)) {
      throw new Error("seed install exhausted or fragmented guest memory");
    }
    if (/seed copy failed|No space left on device|Total free blocks count 0/.test(transcript)) {
      throw new Error("seed install reported a copy/capacity failure");
    }
    if (!transcript.includes("yore: install complete — /nix is on /dev/vdb")) {
      throw new Error("guest did not confirm the direct vdb /nix install");
    }
    if (!transcript.includes("yore: seed copy used bounded per-file page cache")) {
      throw new Error("guest did not confirm bounded seed-copy cache handling");
    }
    const drops = transcript.match(/drop_caches:/g)?.length ?? 0;
    if (drops !== 0) throw new Error(`seed installer manipulated drop_caches (${drops} lines)`);

    session.send(
      "test -f /mnt/state/.yore-linux-installed && " +
        "set -- $(df -Pk /nix | tail -n 1) && " +
        "echo SEED_FREE_KIB=$4 && " +
        "echo SEED_BLOCK_SIZE=$(stat -f -c %S /nix); " +
        "echo SEED_STATE_RC=$?\n",
    );
    if (!(await session.waitForOutput(/SEED_STATE_RC=0/, 60_000))) {
      throw new Error("guest did not confirm installed-state metrics");
    }
    transcript = session.snapshot();
    const free = Number(/SEED_FREE_KIB=(\d+)/.exec(transcript)?.[1]);
    const blockSize = Number(/SEED_BLOCK_SIZE=(\d+)/.exec(transcript)?.[1]);
    if (!Number.isFinite(free) || free < MIN_FREE_KIB) {
      throw new Error(`seed left ${free || 0} KiB free; require at least ${MIN_FREE_KIB} KiB`);
    }
    if (blockSize !== 1024)
      throw new Error(`state filesystem block size is ${blockSize}, want 1024`);

    console.log(
      "PASS: complete seed installed on 1.75 GiB vdb (%d KiB free, block=%d, no drop_caches)",
      free,
      blockSize,
    );
  } catch (error) {
    console.error("FAIL:", error.message || error);
    console.error("── transcript ──\n" + session.snapshot().slice(-5000));
    process.exitCode = 1;
  } finally {
    session.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
