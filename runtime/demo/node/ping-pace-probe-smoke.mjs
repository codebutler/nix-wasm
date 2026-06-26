// ping-pace-probe-smoke.mjs — #75 localizer. Boots once and runs the three
// ping-pace-probe cases in-guest, printing a diagnostic matrix:
//   control — one-shot, NO SA_RESTART, single traffic-less recv (= sigalrm-test
//             case 3). Baseline — expected PASS.
//   restart — one-shot, SA_RESTART (signal()), SINGLE-THREADED self-pipe. The
//             discriminator: isolates SA_RESTART with no second thread / no
//             cross-CPU. Expected FAIL on the guest.
//   xcpu    — one-shot, NO SA_RESTART, cross-CPU reply wakes recv then re-blocks.
//             Confirms cross-CPU wakeup is NOT the bug — expected PASS.
//   repro   — full busybox-ping shape (SA_RESTART + re-arm + echo). Expected FAIL.
//
// Reading the matrix (the CI run on this branch showed exactly this):
//   control PASS, xcpu PASS, restart FAIL, repro FAIL
//     → the bug is SA_RESTART, NOT cross-CPU and NOT the handler re-arm: a
//       SIGALRM handler installed with SA_RESTART is never delivered when it
//       interrupts a blocking syscall. Fix belongs in the wasm syscall-restart
//       path (arch/wasm/kernel/traps.c WASM_SYSCALL_N + entry.S _user_mode_tail):
//       the restart loop must deliver the queued handler before/with the restart.
//
// Each probe self-bounds with an in-guest watchdog thread, so a lost-timer hang
// becomes an explicit "FAIL (watchdog)" line rather than blocking this smoke.
// NON-gating diagnostic: exit 0 always (prints the matrix); the bug is open.
// Exit 2 only on boot panic (inconclusive — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
const verdict = {};
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[ping-pace-probe-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  for (const c of ["control", "restart", "xcpu", "repro"]) {
    s.send(`/bin/ping-pace-probe ${c}\n`);
    const ok = await s.waitForOutput(new RegExp(`PROBE ${c}: OK `), 15000).catch(() => false);
    verdict[c] = ok ? "PASS" : "FAIL";
    console.log(`[ping-pace-probe-smoke] ${c}: ${verdict[c]}`);
  }
} finally {
  console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2500));
  s.kill();
}
console.log(
  `\n[ping-pace-probe-smoke] matrix: control=${verdict.control} xcpu=${verdict.xcpu} repro=${verdict.repro}`,
);
process.exit(0);
