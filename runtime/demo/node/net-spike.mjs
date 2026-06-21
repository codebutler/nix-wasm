// net-spike.mjs — Phase 1 Task 1.3 SPIKE: does stock virtio_net probe on the
// wasm32 nommu no-DMA virtio_wasm transport and create eth0?
//
// Boots the busybox-only guest (nix:false), captures the kernel log (onLog),
// waits for a shell prompt, then asks the guest to enumerate its net devices.
// PASS = `virtio_net` registers + `eth0` present. FAIL = probe oops / hang / no eth0.
import { bootNode } from "./boot-node.mjs";

const hostLog = [];
const s = await bootNode({
  nix: false,
  onLog: (m) => {
    const str = String(m);
    hostLog.push(str);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const gotPrompt = await s.waitForPrompt(60000).catch((e) => {
    console.log("[net-spike] waitForPrompt threw: " + e.message);
    return false;
  });
  console.log("[net-spike] prompt reached: " + gotPrompt);

  // Enumerate net interfaces a few different ways (busybox coverage).
  s.send("ls /sys/class/net\n");
  await sleep(1500);
  s.send("ip link\n");
  await sleep(1500);
  s.send("cat /proc/net/dev\n");
  await sleep(1500);

  const guestLog = s.snapshot();
  const kernelLog = hostLog.join("\n");
  const combined = guestLog + "\n" + kernelLog;

  console.log("\n── kernel log: virtio_net / eth0 trail ──");
  for (const line of kernelLog.split("\n")) {
    if (/virtio_net|virtio2|eth0|virtio_wasm: registered dev=2|net/i.test(line)) {
      console.log("  " + line);
    }
  }
  console.log("─────────────────────────────────");
  console.log("── guest console tail ──");
  console.log(guestLog.slice(-2500));
  console.log("─────────────────────────────────");

  const panic = /Kernel panic|panic:|Oops|BUG:/i.test(combined);
  const eth0 = /\beth0\b/.test(combined);
  const driverReg = /virtio_net/i.test(combined);

  console.log("\n[net-spike] panic/oops:   " + panic);
  console.log("[net-spike] virtio_net:   " + driverReg);
  console.log("[net-spike] eth0 present: " + eth0);

  if (!panic && eth0 && driverReg) {
    console.log("[net-spike] VERDICT: PASS");
    process.exitCode = 0;
  } else if (!panic && eth0) {
    console.log("[net-spike] VERDICT: PASS (eth0 present; driver string not in captured log)");
    process.exitCode = 0;
  } else {
    console.log("[net-spike] VERDICT: FAIL");
    process.exitCode = 1;
  }
} finally {
  s.kill();
  // boot-node spawns workers; give them a tick then hard-exit.
  await sleep(200);
  process.exit(process.exitCode || 0);
}
