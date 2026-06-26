// timeout-repro-smoke.mjs — regression smoke for issue #35. Boots the guest and
// runs the busybox command that used to fail: `timeout 2 sleep 10`.
//
// busybox `timeout` spawns a watcher that re-execs itself with `-pPID`
// (bb_daemonize_or_rexec), waits the timeout, then kill(parent, SIGTERM); the
// parent meanwhile execs PROG (so it IS PROG by the time it's signalled).
//
// #35: on the wasm/NOMMU guest the watcher's `-pPID` landed AFTER the SECONDS
// operand in the re-exec argv, and musl's getopt (unlike glibc) does not permute
// options past the first operand, so `-p` was never parsed — the watcher died
// with "can't execute '-p50'" and `sleep 10` ran to completion (exit 0). Fixed
// by patches/busybox/0008 (insert `-pPID` before the operands).
//
// Correct busybox behavior: `sleep 10` is TERMINATED by the watcher at ~2s.
// busybox `timeout` replaces itself with PROG and is killed directly, so the
// shell sees the signal exit 128+SIGTERM = 143 (NOT GNU coreutils' 124). Either
// 143 or 124 means the timeout fired; exit 0 (ran the full 10s) or the "-p50"
// error means #35 is back. No networking needed (runs in the busybox-only boot).
// Exit: 0 = timeout fired (PASS); 1 = #35 (ran full / errored); 2 = boot panic.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
let verdict = 1; // assume failure until we see the timeout actually fire
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
    verdict = 1;
  } else {
    const m = /TIMEOUT_REPRO_EXIT=(\d+)/.exec(s.snapshot());
    const code = m ? Number(m[1]) : NaN;
    // 143 = 128+SIGTERM (busybox: PROG is signalled directly); 124 = GNU style.
    if (code === 143 || code === 124) {
      console.log(`[timeout-repro] timeout fired (exit ${code}) — sleep was killed, #35 fixed`);
      verdict = 0;
    } else {
      console.log(
        `[timeout-repro] returned exit ${code} (expected 143/124) — sleep was NOT killed, #35`,
      );
      verdict = 1;
    }
  }
} finally {
  console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  s.kill();
}
console.log("\n[timeout-repro] " + (verdict === 0 ? "PASS" : "FAIL"));
process.exit(verdict);
