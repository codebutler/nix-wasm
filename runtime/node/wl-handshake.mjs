// wl-handshake.mjs — Wayland Phase 1 sub-step 1d M2 runner: the PHASE 1
// DELIVERABLE. Boots the busybox-only guest, launches /bin/waylandproxyd in the
// background, then runs /bin/wlhandshake — a STOCK libwayland client — pointed at
// wayland-0 (i.e. through the proxy). The client does:
//   wl_display_connect(NULL) -> get_registry -> roundtrip -> enumerate globals.
//
// Full path proven end-to-end:
//   wlhandshake (libwayland) --AF_UNIX--> waylandproxyd --VIRTWL_IOCTL_SEND-->
//   /dev/wl0 --OUT vq--> JS wl device --wl-server.js parses get_registry-->
//   emits wl_registry.global x N + (sync) wl_callback.done + wl_display.delete_id
//   --IN vq VFD_RECV--> virtio_wl routes to ctx --VIRTWL_IOCTL_RECV-->
//   waylandproxyd --AF_UNIX--> wlhandshake demarshals -> sees globals.
//
//   RESULT wl-handshake PASS <n>  -> exit 0  (n = globals the client saw)
//   RESULT wl-handshake FAIL ...  -> exit 1
//   no shell prompt (boot panic)  -> exit 2 (re-run once)
import { bootNode } from "./boot-node.mjs";

const hostLog = [];
const s = await bootNode({
  nix: false,
  onLog: (m) => {
    const str = String(m);
    if (/virtio|wl|raise|SEND|RECV|NEW|IN push|wl-server/.test(str)) hostLog.push(str);
  },
});

let code = 2;
try {
  const got = await s.waitForPrompt(90000).catch(() => false);
  if (!got) {
    console.log("[wl-handshake] INCONCLUSIVE — no shell prompt (boot panic?)");
    console.log(s.snapshot().slice(-2000));
    process.exit(2);
  }

  // Point libwayland at the proxy's socket: WAYLAND_DISPLAY=wayland-0 under
  // XDG_RUNTIME_DIR. wl_display_connect(NULL) composes "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY".
  s.send("export XDG_RUNTIME_DIR=/tmp\n");
  s.send("export WAYLAND_DISPLAY=wayland-0\n");
  s.send("/bin/waylandproxyd & sleep 1\n");
  await s.waitForOutput(/RESULT waylandproxyd PASS .*listening/, 15000).catch(() => false);

  s.send("/bin/wlhandshake; echo HSDONE=$?\n");
  await s.waitForOutput(/HSDONE=\d/, 30000).catch(() => false);
  // Let the proxy poll loop flush any last host->client RECV.
  s.send("sleep 1; echo FLUSHDONE\n");
  await s.waitForOutput(/FLUSHDONE/, 10000).catch(() => false);

  const out = s.snapshot();

  console.log("── guest transcript ──");
  for (const l of out.split("\n")) {
    if (/waylandproxyd:|wlhandshake:|RESULT (waylandproxyd|wl-handshake)|HSDONE=/.test(l)) {
      // eslint-disable-next-line no-control-regex -- strip ANSI SGR escapes
      console.log("  " + l.replace(/\x1b\[[0-9;]*m/g, "").trim());
    }
  }
  console.log("── host-side (JS wl device + server) trail ──");
  for (const m of hostLog) {
    if (/virtio-wl|wl-server|SEND|RECV|IN push|NEW/.test(m)) {
      console.log("  " + m);
    }
  }
  console.log("──────────────────────────────────");

  const m = out.match(/RESULT wl-handshake PASS (\d+)/);
  const anyFail = /RESULT wl-handshake FAIL/.test(out);

  if (m) {
    code = 0;
    console.log(
      `[wl-handshake] PASS — stock libwayland client completed the registry ` +
        `handshake end-to-end through waylandproxyd + virtio_wl + the transport. ` +
        `Globals seen: ${m[1]}.`,
    );
  } else if (anyFail) {
    code = 1;
    const f = out.match(/RESULT wl-handshake FAIL[^\n]*/);
    console.log(`[wl-handshake] FAIL — ${f ? f[0] : "see transcript"}`);
  } else {
    code = 1;
    console.log("[wl-handshake] FAIL — wlhandshake produced no RESULT marker (stall?)");
  }
} finally {
  s.kill();
}

process.exit(code);
