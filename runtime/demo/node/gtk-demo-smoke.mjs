// gtk-demo-smoke.mjs — boots (nix:true) and runs /bin/gtk3-demo --selftest
// in-guest. gtk3-demo is the first REAL (non-showcase) GTK3 app on the wasm
// guest: a full GtkApplication whose main window wires every signal in C with
// g_signal_connect and never calls gtk_builder_connect_signals, so unlike
// galculator it has NO GModule dependency (the static guest cannot provide
// g_module_open(NULL)/dlsym). Done display-free (the node harness has no
// compositor): the selftest walks the generated gtk_demos[] dispatch table
// asserting every do_<demo> fn-pointer is a real fpcast canonical thunk, runs a
// few browser-chrome widget class_init functions through the fpcast seam, and
// checks gtk_get_major_version()==3. The full browser window is a MANUAL browser
// check. See userspace/gtk-demo.nix + patches/gtk-demo/.
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[gtk-demo-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/gtk3-demo --selftest\n");
  pass = await s.waitForOutput(/GTK-DEMO-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[gtk-demo-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
