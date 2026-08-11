// gtk2-smoke.mjs — boots (nix:true) and runs `gtk2-hello --selftest` in-guest.
// PATH-resolved from environment.systemPackages (evictable squashfs), NOT
// /bin (initramfs tmpfs is unevictable and starves the guest of RAM).
// The M-X4 GTK2 proof (XChat/X11 epic): gtk_init_check + GtkWindow + GtkLabel
// class registration (gobject through the fpcast-emu seam), display-free —
// mirrors gtk-smoke.mjs's posture exactly, so it runs in the same no-DISPLAY
// boot as every other GTK selftest. The LIVE window (via GTK2's X11 backend,
// screenshotted with Xvfb+xwd) is gtk2-x11-smoke.mjs, a separate boot. Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[gtk2-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("gtk2-hello --selftest\n");
  pass = await s.waitForOutput(/GTK2-SELFTEST: .* OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[gtk2-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
