// clock-smoke.mjs — boots busybox-only and proves the guest WALL CLOCK is
// real time, not the 1970 epoch. patches/kernel/0028 implements
// read_persistent_clock64 off the engine's wasm_cpu_clock_get_monotonic
// import, whose absolute value is anchored at the UNIX epoch
// (performance.timeOrigin + performance.now() — the anchoring is load-bearing,
// see the comment at the formula in kernel-worker.js). Without it
// CLOCK_REALTIME boots at 1970 and TLS breaks: every certificate is "not yet
// valid" (curl 60), killing the guest's Cachix substitution.
//
// Gate: `date +%s` in-guest must be within TOLERANCE of the host clock. The
// tolerance is generous (15 min ≫ boot time + clock skew) because the failure
// mode this guards is ~56 YEARS off (epoch boot) or orders-of-magnitude off
// (a ns/us/ms unit regression in the import) — not small drift.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const TOLERANCE_S = 900;

const s = await bootNode({ nix: false });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[clock-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // Marker rule (#96): "GUESTEPOCH <digits>" cannot be matched by the echoed
  // command itself (the command text has "/'" after GUESTEPOCH, not digits).
  s.send("date +%s | sed 's/^/GUESTEPOCH /'\n");
  const m = await s.waitForOutput(/GUESTEPOCH ([0-9]+)/, 20000);
  if (!m) throw new Error("no GUESTEPOCH line");
  const guest = Number(s.snapshot().match(/GUESTEPOCH ([0-9]+)/)[1]);
  const host = Math.floor(Date.now() / 1000);
  const delta = Math.abs(guest - host);
  console.log(
    `[clock-smoke] guest epoch ${guest} (${new Date(guest * 1000).toISOString()}), ` +
      `host ${host}, |delta| ${delta}s (tolerance ${TOLERANCE_S}s)`,
  );
  pass = delta <= TOLERANCE_S;
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[clock-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
