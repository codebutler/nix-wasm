// resize-smoke.mjs — boots busybox-only and proves a terminal RESIZE propagates
// to the guest tty (#83 follow-up). console(idx).resize(cols, rows) writes the
// new size into that virtio-console device's config space (struct
// virtio_console_config) and raises the device's dedicated config-change irq
// (VW_CONSOLE_CONFIG_IRQ_BASE + idx); the stock virtio-console driver re-reads
// config and hvc_resize()s the tty. We read the size back in-guest with
// `stty size` (TIOCGWINSZ, which busybox prints as "rows cols").
//
// Two things are proven:
//   1) probe-time config read: the tty boots at the device's default 80x24
//      (VIRTIO_CONSOLE_F_SIZE config space served at probe), and
//   2) the config-change interrupt: a later resize reaches hvc_resize().
// Only (2) gates — (1) is logged but not asserted (a getty might pre-set the
// winsize), while the distinctive resize target can only come from our resize.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const COLS = 137;
const ROWS = 49; // distinctive — won't collide with boot-log digits or defaults
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await bootNode({ nix: false });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[resize-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // (1) Initial winsize from F_SIZE config space at probe (informational).
  s.send("stty size | sed 's/^/RSZ0 /'\n");
  const initOk = await s.waitForOutput(/RSZ0 24 80\b/, 12000);
  console.log(`[resize-smoke] initial winsize 24x80 from probe config: ${initOk ? "yes" : "no"}`);

  // (2) GATING: a resize must reach the guest tty via the config-change irq.
  s.console(0).resize(COLS, ROWS);
  await sleep(800); // config irq -> config_intr -> workqueue -> hvc_resize
  s.send("stty size | sed 's/^/RSZ1 /'\n");
  pass = await s.waitForOutput(new RegExp(`RSZ1 ${ROWS} ${COLS}\\b`), 20000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[resize-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
