// galculator-smoke.mjs — boots (nix:true) and confirms /bin/galculator STARTS in-guest
// (links, instantiates, runs gobject statics through the fpcast-emu seam, reaches GTK init).
// Headless node harness has no compositor — galculator exits on "cannot open display" (not a
// wasm trap). The click-7×6=42 compute is a MANUAL browser check; see
// docs/superpowers/notes/m4-galculator-visual.md. Exit 0 pass / 1 fail / 2 inconclusive.
import { bootNode } from "./boot-node.mjs";

// Any wasm trap means fpcast-emu failed or a link issue snuck through.
const TRAP = /null function or function signature mismatch|unreachable|RuntimeError|wasm trap/i;
// galculator reaches GTK display init and hits "cannot open display" (no Wayland compositor in
// the node harness). GModule-CRITICAL fires first (static wasm: no dlopen), then Gtk-WARNING.
// Either line proves galculator started, loaded all libs, and ran gobject class_init through the
// fpcast seam without a wasm trap.
const REACHED_GTK = /cannot open display|GModule-CRITICAL|Gtk-WARNING/;

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
  s.send("/bin/galculator; echo GALC_RC=$?\n");
  const reachedGtk = await s.waitForOutput(REACHED_GTK, 30000);
  const tail = s.snapshot();
  pass = reachedGtk && !TRAP.test(tail);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[galculator-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
