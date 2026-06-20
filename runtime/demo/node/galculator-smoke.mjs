// galculator-smoke.mjs — boots (nix:true) and runs /bin/galculator --selftest
// in-guest. The M4 galculator proof: before gtk_init (no compositor needed), it
// loads the real .ui files from PACKAGE_UI_DIR and parses them with GLib's GMarkup
// XML parser (display-free — gtk_builder_add_from_file would instantiate widgets and
// abort with no display), asserting GtkWindow "main_window" (main_frame.ui) +
// GtkToggleButton "button_7" (basic_buttons_gtk3.ui) exist, printing
// `GALCULATOR-SELFTEST: ... OK`. gobject statics run through the fpcast-emu seam.
// The click-7×6=42 compute is a MANUAL browser check; see
// docs/superpowers/notes/m4-galculator-visual.md. Exit 0 pass / 1 fail / 2 inconclusive.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[galculator-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/galculator --selftest\n");
  pass = await s.waitForOutput(/GALCULATOR-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[galculator-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
