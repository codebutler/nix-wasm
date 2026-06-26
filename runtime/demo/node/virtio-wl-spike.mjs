// virtio-wl-spike.mjs — Wayland Phase 1 sub-step 1b M3 test runner.
//
// Boots the busybox-only guest (nix:false), waits for a shell, and runs the
// /bin/wltest userspace self-test (userspace/wltest.c). wltest open()s /dev/wl0
// and issues VIRTWL_IOCTL_NEW (NEW_CTX), driving the full round-trip:
//   userspace -> virtio_wl driver -> virtio_wasm transport -> JS wl device model
//   -> response -> guest. It prints:
//
//   RESULT virtio_wl PASS ...  -> exit 0
//   RESULT virtio_wl FAIL ...  -> exit 1
//   (neither, e.g. boot panic) -> exit 2 (inconclusive; re-run once)
import { bootNode } from "./boot-node.mjs";

const hostLog = [];
const s = await bootNode({
  nix: false,
  onLog: (m) => {
    if (/virtio|wl|raise/.test(String(m))) hostLog.push(String(m));
  },
});

let code = 2;
try {
  const got = await s.waitForPrompt(90000).catch(() => false);
  if (!got) {
    console.log("[virtio-wl-spike] INCONCLUSIVE — no shell prompt (boot panic?)");
    console.log(s.snapshot().slice(-2000));
    process.exit(2);
  }

  s.send("/bin/wltest; echo WLDONE=$?\n");
  const done = await s.waitForOutput(/WLDONE=\d/, 20000);
  const out = s.snapshot();

  console.log("── wltest transcript ──");
  for (const l of out.split("\n")) {
    if (/wltest:|RESULT virtio_wl|WLDONE=/.test(l)) {
      // eslint-disable-next-line no-control-regex -- intentional: strip ANSI escape sequences
      console.log("  " + l.replace(/\x1b\[[0-9;]*m/g, "").trim());
    }
  }
  console.log("── host-side (JS wl device) trail ──");
  for (const m of hostLog) if (/wl|dev0/.test(m)) console.log("  " + m);
  console.log("──────────────────────────────────");

  if (/RESULT virtio_wl PASS/.test(out)) {
    code = 0;
    console.log(
      "[virtio-wl-spike] PASS — /dev/wl0 NEW_CTX round-trip reached the JS device and returned",
    );
  } else if (/RESULT virtio_wl FAIL/.test(out)) {
    code = 1;
    console.log("[virtio-wl-spike] FAIL — see RESULT line above");
  } else if (!done) {
    console.log("[virtio-wl-spike] INCONCLUSIVE — wltest produced no RESULT within timeout");
  } else {
    code = 1;
    console.log("[virtio-wl-spike] FAIL — wltest exited without a RESULT marker");
  }
} finally {
  s.kill();
}

process.exit(code);
