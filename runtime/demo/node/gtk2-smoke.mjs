// gtk2-smoke.mjs — boots (nix:true) and runs `gtk2-hello --selftest` in-guest.
// PATH-resolved from environment.systemPackages (evictable squashfs), NOT
// /bin (initramfs tmpfs is unevictable and starves the guest of RAM).
// The M-X4 GTK2 proof (XChat/X11 epic): gtk_init_check + GtkWindow + GtkLabel
// class registration (gobject through the fpcast-emu seam), display-free —
// mirrors gtk-smoke.mjs's posture exactly, so it runs in the same no-DISPLAY
// boot as every other GTK selftest. The LIVE window (via GTK2's X11 backend,
// screenshotted with Xvfb+xwd) is gtk2-x11-smoke.mjs, a separate boot. Exit 0/1/2.
//
// ROOT CAUSE OF #193's hang, confirmed via this smoke's own transcript-based
// diagnosis (below): cc217a9/#194 ("bake DISPLAY=:1 + GDK_USE_XSHM=0 +
// QT_X11_NO_MITSHM=1 into /etc/profile", landed for the sommelier/Xwayland
// guest-X11 work) bakes a REAL `DISPLAY=:1` into every login shell — and this
// smoke's boot has no compositor/Xwayland actually listening on :1. Before
// cc217a9, gtk2-hello's `gtk_init_check()` saw no DISPLAY at all and (per its
// own source comment in userspace/gtk2-hello.c) failed cleanly; after cc217a9
// it instead tries to connect to a DEAD `:1` and hangs — this gate is
// DISPLAY-FREE BY CONTRACT (see the file header above) and must not silently
// inherit whatever the ambient login-shell env happens to bake in for real
// X11 apps. `env -u DISPLAY` (not `DISPLAY=`) genuinely UNSETS it for the
// child (busybox `env`'s `-u` is unconditional under CONFIG_ENV=y, verified
// against busybox-1.36.1's coreutils/env.c — no feature-flag gate), matching
// the "none set" case gtk2-hello.c was written against, rather than leaving
// DISPLAY set to an untested empty string (`DISPLAY=`), which Xlib may still
// try to parse/connect on.
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
  // Snapshot length RIGHT BEFORE sending the command, so the failure-path
  // diagnostics below can scope their checks to "everything received after
  // this command was sent" — a pre-command prompt (or anything else already
  // in the transcript) can't false-positive into the post-command checks.
  const cmdOffset = s.snapshot().length;
  s.send("env -u DISPLAY gtk2-hello --selftest\n");
  pass = await s.waitForOutput(/GTK2-SELFTEST: .* OK/, 180000);
  // #193 PROVEN ROOT CAUSE (see the file-header comment): this smoke hung
  // with a COMPLETELY EMPTY transcript after the command — no echo, no
  // "not found", no GTK/GDK error, nothing — because gtk_init_check() was
  // trying to connect to a freshly-baked but dead `DISPLAY=:1`. The fix is
  // `env -u DISPLAY` above. The transcript-based diagnosis machinery below
  // is kept as a standing regression guard: it's what proved this exact
  // failure shape (echoed=true, no prompt after, ^C freed it, was HUNG in
  // the foreground) and will do the same for any future recurrence of a
  // similarly silent hang, from whatever cause.
  //
  // Round 1 (Bugbot, correct): a bare post-timeout `echo` can't tell these
  // apart, because `gtk2-hello --selftest` runs in the FOREGROUND — the shell
  // doesn't even read the echo's command line until the selftest returns. So
  // send Ctrl-C first to force any still-running foreground job out.
  //
  // Round 2 (Bugbot, correct): the PROBE'S $? IS NOT A RELIABLE CLASSIFIER,
  // even with the ^C. busybox ash/hush (like bash) also report 130 for ^C
  // received at an already-IDLE prompt (there is no live foreground job to
  // kill; the shell's own interrupted read still yields a 128+SIGINT-shaped
  // status for the NEXT command's $?) — so "$?=130" fires for both "a job
  // was alive and got killed" and "the shell was already sitting idle",
  // which is exactly the hung-vs-exited distinction this probe exists to
  // make. $? cannot discriminate the two cases; do not re-promote it to one.
  //
  // The only thing that DOES discriminate is the TRANSCRIPT, scoped to the
  // region after cmdOffset:
  //   Bit A — did the command's own echo show up at all? (console received
  //           the input in the first place)
  //   Bit B — did a NEW shell prompt appear after that echo, before the
  //           180s timeout expired? (the foreground job had already
  //           finished on its own, before we ever touched ^C)
  //   Bit C — does the post-^C liveness probe answer at all? (the shell/
  //           console is responsive RIGHT NOW, after ^C)
  // Verdicts: !A → console never took the input (transport/boot race).
  // A && B → the selftest already exited silently on its own; ^C is
  // irrelevant. A && !B && C → the selftest was genuinely HUNG in the
  // foreground and ^C freed the shell. A && !B && !C → hung AND the
  // console/transport is now wedged too (or the guest died). The raw probe
  // $? is still printed, but purely as supplementary data, never as the
  // classifier.
  if (!pass) {
    const region = s.snapshot().slice(cmdOffset);
    const echoed = region.includes("gtk2-hello --selftest"); // Bit A
    const newPromptAfterCmd = /[#$]\s*$/.test(region.trimEnd()); // Bit B, scoped past cmdOffset
    s.send("\x03"); // Ctrl-C: SIGINT whatever is in the foreground, if anything
    await new Promise((r) => setTimeout(r, 1000));
    s.send("echo GTK2_LIVENESS_PROBE=$?\n");
    const probeAnswered = await s.waitForOutput(/GTK2_LIVENESS_PROBE=\d+/, 15000); // Bit C
    const m = /GTK2_LIVENESS_PROBE=(\d+)/.exec(s.snapshot());
    const rc = m ? m[1] : "n/a";

    console.log(
      `\n[gtk2-smoke] post-timeout diagnosis: echoed=${echoed} newPromptAfterCmd=${newPromptAfterCmd} ` +
        `probeAnsweredAfterCtrlC=${probeAnswered} (raw probe $?=${rc})`,
    );
    if (!echoed) {
      console.log(
        "  -> the command's own echo never appeared in the transcript at all: the console " +
          "never took the input — consistent with a transport/boot race (e.g. waitForPrompt's " +
          "whole-transcript `#`/`$` match firing on a transient boot-log line before the real " +
          "login shell was up), not with gtk2-hello itself.",
      );
    } else if (newPromptAfterCmd) {
      console.log(
        "  -> a fresh shell prompt appeared AFTER the command echo, before the 180s timeout — " +
          "the foreground job (gtk2-hello --selftest) had already EXITED ON ITS OWN, silently, " +
          "without ever printing the expected 'GTK2-SELFTEST: ... OK' marker. The ^C/probe that " +
          "followed is irrelevant; the shell was already idle.",
      );
    } else if (probeAnswered) {
      console.log(
        "  -> no fresh prompt appeared after the command echo within the timeout, but the " +
          "post-^C probe answered — a foreground job was still running when ^C arrived and got " +
          "freed by it: gtk2-hello --selftest was genuinely HUNG.",
      );
    } else {
      console.log(
        "  -> no fresh prompt appeared after the command echo, AND the probe never answered " +
          "even after ^C: gtk2-hello --selftest was hung AND the console/transport is now " +
          "unresponsive too (or the whole guest died).",
      );
    }
    console.log(
      "  -> NOTE: the raw probe $? above is supplementary only, not a classifier — busybox " +
        "ash/hush report the same 128+SIGINT-shaped code (130) for ^C at an already-idle prompt " +
        "as for ^C killing a live foreground job, so it can't distinguish hung-vs-exited by " +
        "itself (Bugbot round 2); the echoed/newPromptAfterCmd bits above are what decide it.",
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
