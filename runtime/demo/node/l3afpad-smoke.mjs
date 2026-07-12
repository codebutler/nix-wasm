// l3afpad-smoke.mjs — boots (nix:true) and runs `l3afpad --selftest` in-guest.
// l3afpad (the GTK3 leafpad fork) is the first real GTK3 PRODUCTIVITY app on
// the wasm guest (#122): pure C, every signal wired with g_signal_connect /
// GtkActionEntry tables — it never calls gtk_builder_connect_signals, so like
// gtk3-demo it has NO GModule dependency. Done display-free (the node harness
// has no compositor): the selftest class_inits the editor chrome's widget
// classes (menubar/textview/scrolledwindow) through the fpcast seam, fires a
// GtkTextBuffer "changed" signal into an address-taken C handler, and checks
// gtk_get_major_version()==3. The full editor window — open, edit, save a file
// to /mnt/pc — is a MANUAL browser check. See userspace/l3afpad.nix +
// patches/l3afpad/.
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
  // PATH lookup, not /bin: l3afpad ships via systemPackages (the gcalctool
  // lesson — initramfs extraBins live in unevictable tmpfs), so it loads from
  // the file-backed squashfs at /run/current-system/sw/bin.
  s.send("l3afpad --selftest\n");
  pass = await s.waitForOutput(/L3AFPAD-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[l3afpad-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
