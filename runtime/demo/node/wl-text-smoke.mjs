// wl-text-smoke.mjs — boots and runs /bin/wl-text --selftest in-guest.
// Proves the M2 text stack (fontconfig→freetype→harfbuzz→cairo-ft) renders.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
//
// Boots the FULL Nix system (nix: true): the M2 font bundle — /etc/fonts/fonts.conf,
// DejaVu Sans at /run/current-system/sw/share/fonts, and FONTCONFIG_FILE — is baked
// into the Nix system profile (userspace/fonts.nix + system.nix), so it is only
// present once the served /nix closure is mounted. A nix:false busybox-only boot has
// no fontconfig config and FcInit would fail to resolve the font.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[wl-text-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/wl-text --selftest\n");
  pass = await s.waitForOutput(
    /WL-TEXT-SELFTEST: glyphs=[1-9][0-9]* nonzero_px=[1-9][0-9]* OK/,
    30000,
  );
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[wl-text-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
