// xvfb-smoke.mjs — M-X1's probe (XChat/X11 epic). Boots (nix:true), launches
// the cross-built Xvfb in the background, and runs x11-probe (a minimal
// libxcb client — no Xlib, no toolkit) against it: connect to $DISPLAY, read
// the connection setup reply, print vendor + first-screen dimensions. This is
// the client/server wire-protocol proof for the whole X11 stack — nothing
// upstream of libxcb is exercised yet (GTK2/XChat land in M-X4/M-X5; M-X2
// proper — xeyes + xwd — is still open).
//
// Both xserver (Xvfb) and x11-probe ship via systemPackages (not initramfs
// extraBins) — Xvfb's mesonFlags bake in absolute store paths for xkbcomp
// (Popen()-spawned at startup to compile the XKB keymap) and
// xkeyboard-config's XKB data tree, both of which only reach the guest if
// something in the served squashfs closure references them. See
// deps-overlay.nix's "xorg-server (Xvfb)" section + userspace/x11-probe.nix.
//
// NOTE (session record, M-X1): boot-run to completion against a PR-preview
// guest build (commit aee0cf6). The boot itself is clean (full 9P/virtio
// device enumeration, nix userspace, ash prompt); Xvfb starts and Popen()s
// xkbcomp successfully, but then FAULTS during device init:
// "RuntimeError: null function or function signature mismatch" in
// InitPtrFeedbackClassDeviceStruct → InitPointerDeviceStruct →
// CorePointerProc → ActivateDevice → InitCoreDevices → dix_main. This is the
// same wasm strict-call_indirect function-pointer-cast class CLAUDE.md's
// gobject/fpcast-emu entry documents (the DIX device-feedback vtables are
// almost certainly stored/called through a differently-typed function
// pointer, same shape as glib's class_init cast) — xorg-server's build in
// deps-overlay.nix does NOT yet run the shared `--fpcast-emu` post-link pass
// that glib/gtk3/pango/galculator/l3afpad all need for the identical reason.
// Not diagnosed further / not patched here — the candidate fix needs a
// squashfs rebuild to boot-verify, out of scope for this pass. Re-run once
// xorg-server gets the fpcast-emu treatment.
//
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
      console.log("[xvfb-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // PATH lookup, not /bin: both ship via systemPackages, loading from the
  // file-backed squashfs at /run/current-system/sw/bin (the l3afpad/
  // gcalctool lesson — initramfs extraBins live in unevictable tmpfs).
  //
  // -logfile is an Xorg/XWin-only flag; Xvfb doesn't parse it and would
  // UseMsg()+FatalError instead of binding :9 — redirect stdout/stderr
  // instead. The first Xvfb start also spawns xkbcomp (a fresh wasm exec +
  // keymap compile), which can take longer than a fixed sleep, so retry
  // the probe in-guest rather than betting on one timing window.
  s.send("Xvfb :9 -nolisten tcp -screen 0 1280x1024x24 > /tmp/xvfb.log 2>&1 &\n");
  s.send("for i in $(seq 15); do DISPLAY=:9 x11-probe && break; sleep 2; done\n");
  pass = await s.waitForOutput(/X11-PROBE: vendor=.* screen=\d+x\d+ OK/, 60000);
  if (!pass) {
    s.send("cat /tmp/xvfb.log\n");
    await new Promise((r) => setTimeout(r, 1500));
  }
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[xvfb-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
