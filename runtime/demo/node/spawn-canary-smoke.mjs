// spawn-canary-smoke.mjs — boots and runs /bin/spawn-canary-test in-guest, the
// reduced reproducer for the posix_spawn() parent-static-memory corruption
// found while debugging Xvfb's xkbcomp spawn on the NOMMU wasm guest (worker
// #6, xchat-irc-setup epic). A large patterned static array + a same-size
// heap buffer are filled, a trivial self-exec'd child is posix_spawn()ed, and
// both buffers are rescanned for corruption after waitpid. See
// userspace/spawn-canary-test.c.
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
      console.log("[spawn-canary-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/spawn-canary-test\n");
  pass = await s.waitForOutput(/SPAWN-CANARY: clean OK/, 40000);
} finally {
  console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[spawn-canary-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
