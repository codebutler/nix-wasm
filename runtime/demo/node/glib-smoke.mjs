// glib-smoke.mjs — boots (nix:true) and runs /bin/glib-selftest in-guest.
// Proves glib/gobject + the M1 libffi double-marshaller. Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[glib-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/glib-selftest\n");
  pass = await s.waitForOutput(/GLIB-SELFTEST: signal_double=42\.5 OK/, 30000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[glib-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
