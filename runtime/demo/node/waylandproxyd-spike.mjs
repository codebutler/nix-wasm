// waylandproxyd-spike.mjs — Wayland Phase 1 sub-step 1c (Sommelier pivot) M3 runner.
//
// Boots the busybox-only guest (nix:false), waits for a shell, launches
// /bin/waylandproxyd in the background, then runs /bin/wlclient. This drives the
// full 1c path:
//   waylandproxyd: open(/dev/wl0) -> VIRTWL_IOCTL_NEW_CTX (host channel up)
//                  -> listen() on $XDG_RUNTIME_DIR/wayland-0
//   wlclient:      connect(wayland-0) -> write wl_display.get_registry
//   waylandproxyd: accept -> splice the bytes -> VIRTWL_IOCTL_SEND on the ctx
//                  -> the JS wl device logs "[virtio-wl] SEND ...B".
//
// 1c bar (per the task): proxy builds, runs, /dev/wl0 ctx up, wayland-0
// listening, accepts a connection and forwards initial bytes to the host (the JS
// device logs them). A full registry handshake needs the JS host to speak
// Wayland — that's 1d.
//
//   RESULT waylandproxyd PASS ...  + a JS-device SEND log  -> exit 0
//   any FAIL / no SEND seen                                -> exit 1
//   no shell prompt (boot panic)                           -> exit 2 (re-run once)
import { bootNode } from "./boot-node.mjs";

const hostLog = [];
const s = await bootNode({
  nix: false,
  onLog: (m) => {
    const str = String(m);
    if (/virtio|wl|raise|SEND|NEW/.test(str)) hostLog.push(str);
  },
});

let code = 2;
try {
  const got = await s.waitForPrompt(90000).catch(() => false);
  if (!got) {
    console.log("[waylandproxyd-spike] INCONCLUSIVE — no shell prompt (boot panic?)");
    console.log(s.snapshot().slice(-2000));
    process.exit(2);
  }

  // XDG_RUNTIME_DIR=/tmp; launch the proxy in the background, wait for it to be
  // listening, then run the test client.
  s.send("export XDG_RUNTIME_DIR=/tmp\n");
  s.send("/bin/waylandproxyd & sleep 1\n");
  // Wait for the proxy to report ctx up + wayland-0 listening.
  await s.waitForOutput(/RESULT waylandproxyd PASS .*listening/, 15000).catch(() => false);

  s.send("/bin/wlclient; echo CLIENTDONE=$?\n");
  await s.waitForOutput(/CLIENTDONE=\d/, 15000).catch(() => false);
  // Give the proxy's poll loop a moment to splice + SEND.
  s.send("sleep 1; echo SPLICEDONE\n");
  await s.waitForOutput(/SPLICEDONE/, 10000).catch(() => false);

  const out = s.snapshot();

  console.log("── guest transcript ──");
  for (const l of out.split("\n")) {
    if (/waylandproxyd:|wlclient:|RESULT (waylandproxyd|wlclient)|CLIENTDONE=/.test(l)) {
      // eslint-disable-next-line no-control-regex -- strip ANSI SGR escapes
      console.log("  " + l.replace(/\[[0-9;]*m/g, "").trim());
    }
  }
  console.log("── host-side (JS wl device) trail ──");
  for (const m of hostLog) if (/virtio-wl|wl0|SEND|NEW/.test(m)) console.log("  " + m);
  console.log("──────────────────────────────────");

  const ctxUp = /RESULT waylandproxyd PASS ctx_fd=\d+ listening/.test(out);
  const accepted = /RESULT waylandproxyd PASS accepted client/.test(out);
  const clientSent = /RESULT wlclient PASS sent get_registry/.test(out);
  const forwarded =
    /waylandproxyd: forwarded \d+B .* client->host/.test(out) ||
    hostLog.some((m) => /\[virtio-wl\] SEND \d+B/.test(m));
  const anyFail = /RESULT (waylandproxyd|wlclient) FAIL/.test(out);

  console.log(
    `[waylandproxyd-spike] ctxUp=${ctxUp} accepted=${accepted} ` +
      `clientSent=${clientSent} forwardedToHost=${forwarded}`,
  );

  if (anyFail) {
    code = 1;
    console.log("[waylandproxyd-spike] FAIL — a RESULT FAIL marker appeared above");
  } else if (ctxUp && accepted && forwarded) {
    code = 0;
    console.log(
      "[waylandproxyd-spike] PASS — /dev/wl0 ctx up, wayland-0 listening, client " +
        "accepted, initial bytes spliced to the host (JS device saw the SEND)",
    );
  } else if (ctxUp) {
    code = 1;
    console.log(
      "[waylandproxyd-spike] PARTIAL — ctx + listen OK but the splice/SEND was not observed",
    );
  } else {
    code = 1;
    console.log("[waylandproxyd-spike] FAIL — proxy never reported ctx up / listening");
  }
} finally {
  s.kill();
}

process.exit(code);
