// ping-pace-smoke.mjs — boots and runs /bin/ping-pace-test in-guest, the
// faithful no-network reproducer for issue #75 (busybox FANCY `ping` sends one
// ICMP echo, receives its reply, then never sends packet #2). It mirrors
// busybox ping's exact pacing: a one-shot setitimer(ITIMER_REAL) re-armed from
// inside its own SIGALRM handler, with an async echo-host thread so the main
// loop's blocking recv() is woken by I/O, re-blocks, and the NEXT one-shot timer
// must fire — the sequence sigalrm-test case 3 does NOT cover. No busybox, no
// networking. See userspace/ping-pace-test.c.
//
// PASS: the timer paces WANT requests across I/O-woken, re-blocked recvs and the
// test prints "...OK". BUG (reproduced): the loop stalls at "sent=1" (only the
// first, direct request is ever sent) — the real-world ping symptom verbatim —
// and this smoke times out → FAIL with the stalled transcript tail.
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
      console.log("[ping-pace-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/ping-pace-test\n");
  pass = await s.waitForOutput(
    /PING-PACE-TEST: paced \d+ one-shot timers re-armed-in-handler across I\/O-woken recv OK/,
    40000,
  );
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[ping-pace-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
