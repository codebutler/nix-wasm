// widget-factory-smoke.mjs — boots (nix:true) and runs
// /bin/gtk3-widget-factory --selftest in-guest. The #33 proof: GtkBuilder signal
// autoconnect works on the statically-linked wasm guest WITHOUT GModule —
// gtk_builder_add_callback_symbol registers the handler, gtk_builder_connect_signals
// resolves it from the callback scope (never opening g_module_open(NULL)/dlsym, which
// the static guest cannot provide), and the resolved &handler — the fpcast-emu
// canonical thunk — fires when the signal is emitted. Done display-free via a
// GtkTextBuffer signal (the node harness has no compositor); the full widget-factory
// window is a MANUAL browser check. See userspace/widget-factory.nix + issue #33.
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
      console.log("[widget-factory-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/gtk3-widget-factory --selftest\n");
  pass = await s.waitForOutput(/WIDGET-FACTORY-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[widget-factory-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
