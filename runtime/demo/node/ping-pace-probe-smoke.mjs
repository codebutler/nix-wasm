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
//   transparent — proves the restart is TRANSPARENT, not -EINTR: a single read()
//             (no EINTR-retry) whose SA_RESTART handler supplies the byte must
//             return the DATA (n==1), not -1/EINTR. FAILs on an EINTR-only fix.
//
// Reading the matrix:
//   ALL PASS  → the SA_RESTART fix (patches/kernel/0021, FOOT-level restart loop)
//     works: the handler is delivered AND the syscall transparently restarts
//     (the `transparent` case proves read() returns data, not -EINTR).
//   restart/repro/transparent FAIL (control/xcpu PASS) → the pre-fix bug: a
//     SA_RESTART handler is never delivered when it interrupts a blocking syscall
//     (arch/wasm/kernel/traps.c WASM_SYSCALL_N + entry.S).
//
// Each probe self-bounds with an in-guest watchdog thread, so a lost-timer hang
// becomes an explicit "FAIL (watchdog)" line rather than blocking this smoke.
// NON-gating diagnostic: exit 0 always (prints the matrix); the gating guard is
// ping-pace-smoke. Exit 2 only on boot panic (inconclusive — re-run).
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

  for (const c of ["control", "restart", "xcpu", "repro", "transparent"]) {
    s.send(`/bin/ping-pace-probe ${c}\n`);
    // Match the verdict line generically: the guest doesn't preserve the probe's
    // casename string across echo-thread creation (it prints "PROBE ?:" for the
    // threaded xcpu/repro cases), so key on the OK/FAIL token, not the name. Each
    // case runs sequentially and prints exactly one verdict, so the next
    // "PROBE …: OK" after the send is this case's.
    const ok = await s.waitForOutput(/PROBE [^\n]*: OK /, 15000).catch(() => false);
    verdict[c] = ok ? "PASS" : "FAIL";
    console.log(`[ping-pace-probe-smoke] ${c}: ${verdict[c]}`);
  }
} finally {
  console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2500));
  s.kill();
}
console.log(
  `\n[ping-pace-probe-smoke] matrix: control=${verdict.control} restart=${verdict.restart}` +
    ` xcpu=${verdict.xcpu} repro=${verdict.repro} transparent=${verdict.transparent}`,
);
process.exit(0);
