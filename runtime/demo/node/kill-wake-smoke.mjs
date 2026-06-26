// kill-wake-smoke.mjs — boots and runs /bin/kill-wake-test in-guest, the
// diagnostic reproducer for issue #35's `timeout 2 sleep 10` hang reduced to a
// standalone C program: a sibling process kill()s a target that is blocked in
// nanosleep, for both the DEFAULT SIGTERM action (timeout's exact mechanism) and
// a SIGTERM handler (EINTR). No busybox, no networking. See
// userspace/kill-wake-test.c.
//
// If #35's cross-process async-signal wake is broken, a victim never wakes and
// the in-guest harness's 15s SIGALRM watchdog prints a WATCHDOG/FAIL line (so we
// get a definite verdict instead of an indefinite hang).
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[kill-wake-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/kill-wake-test\n");
  pass = await s.waitForOutput(
    /KILL-WAKE-TEST: default \+ handler cross-process SIGTERM wake OK/,
    40000,
  );
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[kill-wake-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
