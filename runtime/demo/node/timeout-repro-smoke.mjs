// timeout-repro-smoke.mjs — DIAGNOSTIC (non-gating) for issue #35. Boots the
// guest and runs the ACTUAL busybox command that hangs: `timeout 2 sleep 10`.
//
// Correct behavior: busybox `timeout` clones a watcher that re-execs itself
// (bb_daemonize_or_rexec), sleeps 2s, then kill(parent, SIGTERM) — so the
// command should terminate `sleep 10` at ~2s and exit 124. The standalone C
// kill-wake-test (single posix_spawn + cross-process SIGTERM, default action AND
// handler) PASSES on the guest, so this smoke isolates whether the failure is in
// busybox's *double-spawn / re-exec* watcher path specifically.
//
// No networking needed (unlike `ping`), so it runs in the busybox-only boot.
// Exit: 0 = timeout worked (bug NOT reproduced); 3 = #35 reproduced (hang or a
// wrong/again exit); 2 = inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
let verdict = 3; // assume reproduced until we see a clean 124
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[timeout-repro] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // Unique sentinel so we read THIS command's exit status, not stray output.
  s.send("timeout 2 sleep 10; echo TIMEOUT_REPRO_EXIT=$?\n");
  const got = await s.waitForOutput(/TIMEOUT_REPRO_EXIT=(\d+)/, 20000);
  if (!got) {
    console.log("[timeout-repro] HANG — `timeout 2 sleep 10` never returned in 20s (this IS #35)");
    verdict = 3;
  } else {
    const m = /TIMEOUT_REPRO_EXIT=(\d+)/.exec(s.snapshot());
    const code = m ? Number(m[1]) : NaN;
    if (code === 124) {
      console.log("[timeout-repro] timeout fired correctly (exit 124) — #35 NOT reproduced");
      verdict = 0;
    } else {
      console.log(
        `[timeout-repro] returned exit ${code} (expected 124) — anomalous, treating as #35`,
      );
      verdict = 3;
    }
  }
} finally {
  console.log("\n── transcript tail ──\n" + s.snapshot().slice(-1500));
  s.kill();
}
console.log("\n[timeout-repro] " + (verdict === 0 ? "timeout OK" : "REPRODUCED (#35)"));
process.exit(verdict);
