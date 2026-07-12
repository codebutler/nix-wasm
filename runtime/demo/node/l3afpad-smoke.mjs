// l3afpad-smoke.mjs — boots (nix:true) and runs /bin/l3afpad --selftest
// in-guest. l3afpad (the GTK3 fork of leafpad) is the first real PRODUCTIVITY
// app on the wasm guest (#122): a Notepad-class open/edit/save text editor.
// Like gtk3-demo it wires every signal in C (GtkActionEntry/G_CALLBACK +
// g_signal_connect) and never calls gtk_builder_connect_signals, so it has NO
// GModule dependency. Done display-free (the node harness has no compositor):
// the selftest class_inits the editor's widget classes (menubar/textview/
// scrolled-window) through the fpcast seam, round-trips text through a real
// GtkTextBuffer instance (the editor core), asserts the menu callbacks are
// real address-taken fn pointers (fpcast canonical thunks), and checks
// gtk_get_major_version()==3. The full window — open, edit, save a file to
// /mnt/pc (the 9P pc VFS) — is a MANUAL browser check. See
// userspace/l3afpad.nix + patches/l3afpad/.
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
      console.log("[l3afpad-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/l3afpad --selftest\n");
  pass = await s.waitForOutput(/L3AFPAD-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[l3afpad-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
