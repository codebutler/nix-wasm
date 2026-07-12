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
  // Write a minimal SVG and convert it, then confirm the output is a PNG. The
  // PNG magic is \x89 P N G …, so "PNG" is printable at bytes 1-3 — grep -a
  // (binary-safe) on the header proves it. BusyBox `od` lacks GNU's
  // -A/-t/-N flags (the first cut used them and always errored), so avoid od.
  // Self-contained — no dependency on a game's installed theme path.
  s.send(
    'printf \'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
      '<rect width="8" height="8" fill="red"/></svg>\' > /tmp/t.svg && ' +
      "rsvg-convert /tmp/t.svg -o /tmp/t.png && " +
      "head -c 8 /tmp/t.png | grep -qa PNG && echo RSVG_PNG_OK\n",
  );
  pass = await s.waitForOutput(/RSVG_PNG_OK/, 180000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[rsvg-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
