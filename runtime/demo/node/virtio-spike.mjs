// virtio-spike.mjs — Wayland Phase 1 sub-step 1a de-risking spike test runner.
//
// Boots the busybox-only guest (nix:false) and greps the boot console for the
// in-kernel echo self-test marker emitted by drivers/virtio/virtio_wasm.c:
//
//   RESULT virtio_wasm PASS ...   -> exit 0
//   RESULT virtio_wasm FAIL ...   -> exit 1
//   (neither, e.g. boot panic)    -> exit 2 (inconclusive)
//
// The whole round-trip (kick -> host echo -> raise_interrupt -> vq callback)
// happens automatically during boot as a late_initcall, so there is nothing to
// drive from userspace — we just watch the kernel log.
import { bootNode } from "./boot-node.mjs";

const hostLog = [];
const s = await bootNode({
  nix: false,
  onLog: (m) => {
    if (/virtio|raise_interrupt/.test(String(m))) hostLog.push(String(m));
  },
});

const PASS = /RESULT virtio_wasm PASS/;
const FAIL = /RESULT virtio_wasm FAIL/;
const PROBE = /virtio_wasm: TEST driver probe RUNNING/;

let code = 2;
try {
  // Wait up to 60s for a RESULT line (or a panic).
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const log = s.snapshot();
    if (/Kernel panic|panic:/i.test(log)) {
      console.log("[virtio-spike] INCONCLUSIVE — kernel panic on boot");
      console.log(log.slice(-2000));
      code = 2;
      break;
    }
    if (PASS.test(log)) {
      code = 0;
      break;
    }
    if (FAIL.test(log)) {
      code = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const log = s.snapshot();
  // Surface the milestone trail for the report.
  console.log("── virtio_wasm milestone trail ──");
  for (const line of log.split("\n")) {
    if (/virtio_wasm|virtio-echo|virtio_bus|RESULT/.test(line)) console.log("  " + line);
  }
  console.log("─────────────────────────────────");
  console.log("── host-side (JS device) trail ──");
  for (const m of hostLog) console.log("  " + m);
  console.log("─────────────────────────────────");

  if (code === 0) console.log("[virtio-spike] PASS — raise_interrupt delivered, round-trip OK");
  else if (code === 1) console.log("[virtio-spike] FAIL — see RESULT line above");
  else {
    console.log("[virtio-spike] INCONCLUSIVE — no RESULT marker within timeout");
    console.log("probe ran: " + PROBE.test(log));
    console.log("\n── console tail ──\n" + log.slice(-3000));
  }
} finally {
  s.kill();
}

process.exit(code);
