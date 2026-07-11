// rsvg-smoke.mjs — boots (nix:true) and renders a REAL game tileset SVG to
// PNG in-guest with rsvg-convert. The GNOME-games tier's headless gate, with
// zero source patches: exercises libcroco (CSS) → librsvg (SVG DOM +
// rendering) → pango/cairo (text/paths) → cairo-png (the newly-enabled cairo
// PNG backend) end-to-end, display-free. The tileset is gnome-mahjongg's
// actual postmodern theme riding the served closure, so this also proves the
// games' assets are where the binaries will look. The game WINDOWS are
// browser checks on the rig (docs/superpowers/notes/gnome-games-visual.md).
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
      console.log("[rsvg-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  // Render the mahjongg tileset, then print the PNG magic bytes: a valid
  // render starts 89 50 4e 47 ("\x89PNG").
  s.send(
    'svg=$(find /run/current-system/sw/share/gnome-mahjongg/themes -name "*.svg" | head -1); ' +
      'rsvg-convert "$svg" -o /tmp/tile.png && od -An -tx1 -N4 /tmp/tile.png | tr -s " "\n',
  );
  pass = await s.waitForOutput(/89 50 4e 47/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[rsvg-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
