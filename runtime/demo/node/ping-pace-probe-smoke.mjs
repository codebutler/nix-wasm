// ping-pace-probe-smoke.mjs — #75 localizer. Boots once and runs the three
// ping-pace-probe cases in-guest, printing a diagnostic matrix:
//   control — a one-shot ITIMER_REAL must interrupt a single traffic-less recv
//             (= sigalrm-test case 3). Expected PASS — baseline.
//   xcpu    — a pending one-shot must fire after a cross-CPU reply wakes recv and
//             recv RE-BLOCKS (no handler re-arm). This is the discriminator.
//   repro   — the full busybox-ping shape (one-shot re-armed in the handler).
//
// Reading the matrix:
//   control OK, xcpu FAIL  → the bug is "a pending one-shot timer is lost after a
//                            cross-CPU wakeup re-blocks the wait" — independent of
//                            ping's handler re-arm (fix in arch/wasm timer/idle).
//   control OK, xcpu OK, repro FAIL → the handler re-arm is implicated.
//   control FAIL           → even the baseline one-shot is broken in this harness
//                            (would contradict sigalrm-test; investigate harness).
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

  for (const c of ["control", "xcpu", "repro"]) {
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
