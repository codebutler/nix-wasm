// wl-handshake.mjs — Wayland registry handshake through Sommelier (Task 11).
// Boots the busybox-only guest, launches /bin/sommelier --parent, then runs
// /bin/wlhandshake — a STOCK libwayland client — pointed at wayland-0. Client:
//   wl_display_connect(NULL) -> get_registry -> roundtrip -> enumerate globals.
//
// Full path proven end-to-end:
//   wlhandshake --AF_UNIX wayland-0--> sommelier --parent
//     (accept) --posix_spawn--> sommelier --client-fd=N
//       --VIRTWL_IOCTL_SEND--> /dev/wl0 --OUT vq--> JS wl device
//       --wl-server.js: get_registry --> wl_registry.global x N + done
//       --IN vq VFD_RECV--> sommelier --AF_UNIX--> wlhandshake sees globals.
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

  // Point libwayland at Sommelier's socket: WAYLAND_DISPLAY=wayland-0 under
  // XDG_RUNTIME_DIR. wl_display_connect(NULL) composes "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY".
  s.send("export XDG_RUNTIME_DIR=/tmp\n");
  s.send("export WAYLAND_DISPLAY=wayland-0\n");
  // Redirect stderr to capture Sommelier's LOG(WARNING) dmabuf fallback line.
  s.send("/bin/sommelier --parent 2>&1 &\n");

  // Sommelier --parent binds wayland-0 silently; poll until the socket appears.
  let socketReady = false;
  for (let i = 0; i < 15; i++) {
    s.send("ls /tmp/wayland-0 2>/dev/null && echo SOCKREADY || echo SOCKWAIT\n");
    const found = await s.waitForOutput(/SOCKREADY|SOCKWAIT/, 3000).catch(() => false);
    if (found && /SOCKREADY/.test(s.snapshot())) {
      socketReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!socketReady) {
    console.log("[wl-handshake] FAIL — /tmp/wayland-0 socket never appeared");
    process.exit(1);
  }

  s.send("/bin/wlhandshake; echo HSDONE=$?\n");
  await s.waitForOutput(/HSDONE=\d/, 30000).catch(() => false);
  // Let Sommelier's poll loop flush any last host->client RECV.
  s.send("sleep 1; echo FLUSHDONE\n");
  await s.waitForOutput(/FLUSHDONE/, 10000).catch(() => false);

  const out = s.snapshot();

  console.log("── guest transcript ──");
  for (const l of out.split("\n")) {
    if (/sommelier|wlhandshake:|RESULT wl-handshake|HSDONE=|SOCKREADY/.test(l)) {
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
        `handshake end-to-end through Sommelier + virtio_wl + the transport. ` +
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
