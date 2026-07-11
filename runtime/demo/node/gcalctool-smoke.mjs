// gcalctool-smoke.mjs — boots (nix:true) and computes 7*6 with /bin/gcalccmd,
// gcalctool's console front-end. Unlike the GUI selftests this needs NO source
// patch and no display: gcalccmd reads equations from stdin and prints results,
// sharing the full equation engine (lexer/parser/mp arithmetic, GObject
// MathEquation through the fpcast-emu seam) with the GTK app. `7*6` → `42`
// proves the engine end-to-end headless; the GUI window + GtkBuilder/GModule
// autoconnect is the browser check (the galculator click-to-42 path, #130).
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic; re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[gcalctool-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  // PATH lookup, not /bin: gcalctool is deliberately NOT in the initramfs
  // extraBins — its two ~14 MB binaries there grew the unevictable initramfs
  // tmpfs enough that build-from-source-e2e's in-guest nix-build could no
  // longer get a 128 MB contiguous NOMMU allocation. It ships via
  // systemPackages instead, so it loads from the (evictable, file-backed)
  // squashfs at /run/current-system/sw/bin.
  s.send('echo "7*6" | gcalccmd\n');
  // gcalccmd echoes a "> " prompt then the result line; match a bare 42.
  pass = await s.waitForOutput(/(^|[^0-9])42([^0-9]|$)/m, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[gcalctool-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
