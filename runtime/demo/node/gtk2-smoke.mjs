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
  // command line, unlike xdpyinfo/xeyes in x11-apps-smoke.mjs).
  //
  // A bare post-timeout `echo` can't tell these apart, because
  // `gtk2-hello --selftest` runs in the FOREGROUND: the shell doesn't even
  // read the echo's command line until the selftest itself returns. So if
  // the selftest is genuinely hung, a follow-up echo stays silent EITHER
  // WAY (indistinguishable from a dead console) — and if the echo DOES
  // answer, all that proves is the selftest already exited (not that it
  // "hung", the opposite of what a naive reading suggests). Send Ctrl-C
  // FIRST to force any still-running foreground job to terminate, THEN
  // probe: the probe's captured $? separates the cases — 128+SIGINT (130)
  // means something was still alive in the foreground and ^C killed it (a
  // real hang); anything else means the shell was already idle (the
  // selftest had already returned on its own, silently, before our ^C —
  // wrong/missing output, not a hang). If the probe never answers even
  // after ^C, the console/transport itself is unresponsive.
  if (!pass) {
    const preCtrlC = s.snapshot();
    s.send("\x03"); // Ctrl-C: SIGINT whatever is in the foreground, if anything
    await new Promise((r) => setTimeout(r, 1000));
    s.send("echo GTK2_LIVENESS_PROBE=$?\n");
    const alive = await s.waitForOutput(/GTK2_LIVENESS_PROBE=\d+/, 15000);
    if (!alive) {
      console.log(
        "\n[gtk2-smoke] post-timeout diagnosis: console unresponsive even after ^C — " +
          "the selftest command likely never reached a live shell (transport/boot race), " +
          "or the whole guest is wedged.",
      );
    } else {
      const m = /GTK2_LIVENESS_PROBE=(\d+)/.exec(s.snapshot());
      const rc = m ? Number(m[1]) : NaN;
      const sawSelftestOutput = preCtrlC.includes("GTK2-SELFTEST:");
      const signaled = rc >= 128 && rc < 160; // 128+N convention; 130 = SIGINT
      console.log(
        `\n[gtk2-smoke] post-timeout diagnosis: shell responded to ^C + probe ` +
          `(captured $?=${rc}, pre-^C transcript ${sawSelftestOutput ? "DOES" : "does NOT"} contain "GTK2-SELFTEST:").`,
      );
      if (signaled) {
        console.log(
          `  -> $?=${rc} looks signal-like (128+N; 130=SIGINT): a foreground job was ` +
            "still running when ^C arrived and was killed by it — consistent with " +
            "gtk2-hello --selftest being genuinely HUNG" +
            (sawSelftestOutput ? " after printing partial output." : " before its first printf."),
        );
      } else {
        console.log(
          `  -> $?=${rc} is not a SIGINT-shaped exit code: the shell was already idle ` +
            "when ^C arrived — consistent with gtk2-hello --selftest having already " +
            "returned/exited on its own " +
            (sawSelftestOutput
              ? "(it printed something, but never the expected 'OK' marker)."
              : "(completely silently, with no output at all — e.g. it never even " +
                "started, or exited before its first printf)."),
        );
      }
    }
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
