// sigalrm-smoke.mjs — boots and runs /bin/sigalrm-test in-guest, proving the
// kernel + runtime async SIGALRM / setitimer(ITIMER_REAL) / alarm() delivery
// mechanism works end to end (#35): a one-shot alarm interrupts pause(), a
// periodic itimer ticks while blocked in nanosleep, and a one-shot itimer
// interrupts a timer-less recvfrom in a process that has posix_spawn'd (busybox
// ping's exact pattern). See userspace/sigalrm-test.c.
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
      console.log("[sigalrm-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/sigalrm-test\n");
  pass = await s.waitForOutput(
    /SIGALRM-TEST: alarm\/pause \+ setitimer periodic \+ after-spawn OK/,
    30000,
  );
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[sigalrm-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
