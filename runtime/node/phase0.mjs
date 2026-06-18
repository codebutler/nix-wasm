// phase0.mjs — Wayland Phase 0 kernel-primitive spike runner. Boots the guest
// busybox-only (nix:false) via bootNode, runs the probes baked into the
// initramfs at /bin/t_*, and greps `RESULT <name> PASS` markers off console 0.
// Single-process probes run on one ';'-joined line; the cross-process probe is
// a shell-spawned pair. Exit 2 = boot panic (inconclusive, re-run).
//   LINUX_WASM_ARTIFACTS=/tmp/p0-art P0_NAMES='t_afsock' node node/phase0.mjs
import { bootNode } from "./boot-node.mjs";

const names = (process.env.P0_NAMES || "t_afsock t_afunix t_scm t_mapself t_combined t_mapx")
  .split(/\s+/)
  .filter(Boolean);

const s = await bootNode({ nix: false });
let pass = true;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") { console.log("[phase0] INCONCLUSIVE — kernel panic on boot; re-run"); s.kill(); process.exit(2); }
    throw e;
  }
  if (!reached) { console.log("[phase0] no prompt\n" + s.snapshot().slice(-800)); s.kill(); process.exit(1); }

  const single = names.filter((n) => n !== "t_mapx");
  if (single.length) {
    s.send(single.map((n) => `/bin/${n}`).join("; ") + "\n");
    await s.waitForOutput(new RegExp("RESULT " + single[single.length - 1] + " (PASS|FAIL)"), 20000);
  }
  if (names.includes("t_mapx")) {
    s.send("/bin/t_mapx srv & sleep 1; /bin/t_mapx cli; wait\n");
    await s.waitForOutput(/RESULT t_mapx (PASS|FAIL)/, 15000);
  }

  const out = s.snapshot();
  if (/panic|Aiee/i.test(out)) { console.log("[phase0] TRAP\n" + out.slice(-1200)); s.kill(); process.exit(2); }
  for (const n of names) {
    if (new RegExp("RESULT " + n + " PASS").test(out)) console.log("  ok   " + n);
    else { const m = out.match(new RegExp("RESULT " + n + " FAIL[^\\n]*")); console.log("  FAIL " + n + (m ? "  (" + m[0] + ")" : "  (no RESULT line)")); pass = false; }
  }
  if (!pass) console.log("\n--- transcript tail ---\n" + out.slice(-1400));
} finally {
  s.kill();
}
console.log("\n[phase0] " + (pass ? "PASS" : "FAIL") + " — kernel-primitive spike");
process.exit(pass ? 0 : 1);
