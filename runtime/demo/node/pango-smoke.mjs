// pango-smoke.mjs — boots (nix:true) and runs /bin/pango-text --selftest in-guest.
// Proves the pango-layout → cairo render path (PangoLayout + pango_cairo_show_layout)
// over the M2 text stack and the shared gobject --fpcast-emu seam. Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[pango-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/pango-text --selftest\n");
  pass = await s.waitForOutput(/PANGO-TEXT-SELFTEST: nonzero_px=[1-9][0-9]* OK/, 30000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[pango-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
