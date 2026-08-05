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
// SESSION RECORD (M-X1, resolved): the first boot-run (PR-preview build of
// aee0cf6) faulted during device init — "null function or function signature
// mismatch" in InitPtrFeedbackClassDeviceStruct → … → InitCoreDevices →
// dix_main: the DIX device-feedback vtables are called through
// differently-typed function pointers, the same wasm strict-call_indirect
// cast class as glib's class_init (CLAUDE.md's fpcast-emu entry). Fixed in
// deps-overlay.nix by running the shared `--fpcast-emu` post-link pass on
// bin/Xvfb (commit 3e3d699). Boot-verified PASS against the b065a19 preview
// build: Xvfb completes device init, binds :9, and x11-probe reads back
// "vendor=The X.Org Foundation screen=1280x1024" on the first attempt.
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
