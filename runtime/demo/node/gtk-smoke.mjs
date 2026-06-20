// gtk-smoke.mjs — boots (nix:true) and runs /bin/gtk-hello --selftest in-guest.
// The M3b GTK3 proof: gtk_init + GtkWindow + GtkLabel widget tree builds in-guest
// (gobject through the fpcast-emu seam). The node harness has no compositor, so this
// is the headless gate (init + widget tree); the visual window render is a manual
// browser check. Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[gtk-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/gtk-hello --selftest\n");
  pass = await s.waitForOutput(/GTK-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[gtk-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
