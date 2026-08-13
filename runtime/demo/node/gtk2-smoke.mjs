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
  // #193: this smoke has failed with a COMPLETELY EMPTY transcript after the
  // command — no echo, no "not found", no GTK/GDK error, nothing — which is
  // consistent with at least two very different root causes that a bare
  // timeout can't tell apart: (a) the shell never received/ran the command at
  // all (a boot-log false-positive prompt match — waitForPrompt matches ANY
  // trailing `#`/`$` in the whole accumulated transcript, so a transient boot
  // line could in principle satisfy it before the real login shell is up,
  // swallowing the command into pre-login output), vs (b) the shell DID run
  // it and gtk2-hello itself hung before its first printf (e.g. inside
  // gtk_init_check()'s X connection attempt — this smoke is the only one that
  // invokes an X11-linked binary without an explicit `DISPLAY=` on the
  // command line, unlike xdpyinfo/xeyes in x11-apps-smoke.mjs). A short,
  // separately-budgeted liveness probe on failure distinguishes them for the
  // next occurrence instead of leaving a bare empty tail to guess from.
  if (!pass) {
    s.send("echo GTK2_LIVENESS_PROBE=$?\n");
    const alive = await s.waitForOutput(/GTK2_LIVENESS_PROBE=\d+/, 15000);
    console.log(
      "\n[gtk2-smoke] post-timeout liveness probe: " +
        (alive
          ? "shell responded — gtk2-hello --selftest itself produced no matching marker (hung or wrong output)"
          : "console unresponsive — the selftest command likely never reached a live shell (transport/boot race)"),
    );
  }
} finally {
  if (!pass) {
    const tail = s.snapshot();
    console.log(`\n── transcript tail (${tail.length} bytes total) ──\n` + tail.slice(-2000));
  }
  s.kill();
}
console.log("\n[gtk2-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
