// rsvg-smoke.mjs — boots (nix:true) and renders a self-contained SVG to PNG
// in-guest with rsvg-convert. The GNOME-games tier's headless gate, zero
// source patches and zero game-asset-path dependency: it writes a tiny SVG
// and converts it, exercising libcroco (CSS) → librsvg (SVG DOM + render) →
// pango/cairo → cairo-png (the newly-enabled cairo PNG backend) end-to-end,
// display-free. A valid PNG (magic 89 50 4e 47) proves the whole chain the
// games link against. The game WINDOWS are browser checks on the rig
// (docs/superpowers/notes/gnome-games-visual.md). Exit 0 pass / 1 fail /
// 2 inconclusive (boot panic; re-run).
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
  // Write a minimal SVG and convert it; print the PNG magic bytes. A valid
  // render starts 89 50 4e 47 ("\x89PNG"). Self-contained — no dependency on
  // a game's installed theme path (which drift and made the first cut flaky).
  s.send(
    'printf \'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
      '<rect width="8" height="8" fill="red"/></svg>\' > /tmp/t.svg && ' +
      'rsvg-convert /tmp/t.svg -o /tmp/t.png && od -An -tx1 -N4 /tmp/t.png | tr -s " "\n',
  );
  pass = await s.waitForOutput(/89 50 4e 47/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[rsvg-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
