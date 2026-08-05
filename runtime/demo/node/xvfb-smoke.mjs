// xvfb-smoke.mjs — M-X1/M-X2 (XChat/X11 epic). Boots (nix:true), launches the
// cross-built Xvfb in the background, and runs x11-probe (a minimal libxcb
// client — no Xlib, no toolkit) against it: connect to $DISPLAY, read the
// connection setup reply, print vendor + first-screen dimensions. This is the
// client/server wire-protocol proof for the whole X11 stack — nothing
// upstream of libxcb is exercised yet (GTK2/XChat land in M-X4/M-X5).
//
// Both xserver (Xvfb) and x11-probe ship via systemPackages (not initramfs
// extraBins) — Xvfb's mesonFlags bake in absolute store paths for xkbcomp
// (Popen()-spawned at startup to compile the XKB keymap) and
// xkeyboard-config's XKB data tree, both of which only reach the guest if
// something in the served squashfs closure references them. See
// deps-overlay.nix's "xorg-server (Xvfb)" section + userspace/x11-probe.nix.
//
// NOTE (session record, M-X1): this smoke has NOT been run to completion in
// this environment — the sandbox's local nix-wasm.cachix.org substituter was
// missing narinfos for the entire M2/M3/M4 GTK tier (glib/pango/cairo/gtk3/
// wayland/the GNOME-games set, all already baked unconditionally into
// userspace/system.nix's systemPackages), which `environment.systemPackages`
// bundles into ONE closure regardless of which app you actually added. That
// gap predates and is unrelated to the M-X1 xorg-server work (confirmed: the
// gtk+3 derivation hash is byte-identical with and without this change) —
// it's a from-scratch rebuild of an already-shipped tier, not a new one this
// milestone introduces. Rebuilding it here would have cost hours neither
// this session's budget nor its disk-safety margin could responsibly absorb.
// Run this once that tier substitutes cleanly (a warm CI cache, or a
// from-scratch rebuild elsewhere) — expect the usual first-run surprises
// (xkbcomp spawn, a missing core-font, …) the design plan calls out.
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
  s.send("Xvfb :9 -nolisten tcp -screen scrn 1280x1024x24 -logfile /tmp/xvfb.log &\n");
  await new Promise((r) => setTimeout(r, 3000)); // let the server bind + compile its XKB keymap
  s.send("DISPLAY=:9 x11-probe\n");
  pass = await s.waitForOutput(/X11-PROBE: vendor=.* screen=\d+x\d+ OK/, 30000);
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
