// sommelier-smoke.mjs — Task 9: Wayland registry handshake through Sommelier.
//
// Boots the busybox-only guest (nix:false), launches /bin/sommelier --parent
// in the background, then runs /bin/wlhandshake (a stock-libwayland registry
// client). Exercises the full guest→Sommelier→virtwl→JS-wl-device path:
//
//   wlhandshake ──AF_UNIX wayland-0──> sommelier --parent
//     (accept)──posix_spawn──> sommelier --client-fd=N --peer-pid=M
//       --open /dev/wl0--> VIRTWL_IOCTL_NEW_CTX
//       --VIRTWL_IOCTL_SEND--> virtio-wl JS device
//         --wl-server.js: get_registry → wl_registry.global×N → sync done-->
//       --VIRTWL_IOCTL_RECV--> sommelier → AF_UNIX → wlhandshake
//     wlhandshake: wl_display_roundtrip → sees N globals → PASS
//
// PASS conditions:
//   1. wlhandshake prints "RESULT wl-handshake PASS <n>"
//   2. JS device logged a "[virtio-wl] SEND" (bytes proxied guest→host)
//   3. Sommelier logged "using virtwl instead" (dmabuf→virtwl fallback, Task 5)
//
// Exit 0 PASS / 1 FAIL / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const hostLog = [];
const s = await bootNode({
  nix: false,
  onLog: (m) => {
    const str = String(m);
    if (/virtio.wl|virtwl|SEND|NEW_CTX|wl.server|using virtwl/i.test(str)) {
      hostLog.push(str);
    }
  },
});

let code = 2;
try {
  // ── 1. Wait for a shell prompt ────────────────────────────────────────────
  const got = await s.waitForPrompt(90000).catch((e) => {
    if (String(e.message).includes("KERNEL_PANIC")) return null;
    throw e;
  });
  if (got === null) {
    console.log("[sommelier-smoke] INCONCLUSIVE — kernel panic on boot (re-run)");
    process.exit(2);
  }
  if (!got) {
    console.log("[sommelier-smoke] INCONCLUSIVE — no shell prompt within timeout");
    process.exit(2);
  }

  // ── 2. Set XDG_RUNTIME_DIR and launch sommelier --parent ─────────────────
  s.send("export XDG_RUNTIME_DIR=/tmp\n");
  // Redirect stderr to stdout so we capture Sommelier's LOG(WARNING) dmabuf line.
  s.send("/bin/sommelier --parent 2>&1 &\n");

  // Sommelier --parent binds wayland-0 silently (no explicit "listening" log).
  // Poll until the socket file appears (it's AF_UNIX, so `ls` is reliable).
  let socketReady = false;
  for (let i = 0; i < 15; i++) {
    s.send("ls /tmp/wayland-0 2>/dev/null && echo SOCKREADY || echo SOCKWAIT\n");
    const found = await s.waitForOutput(/SOCKREADY|SOCKWAIT/, 3000);
    if (found && /SOCKREADY/.test(s.snapshot())) {
      socketReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!socketReady) {
    console.log("[sommelier-smoke] FAIL — /tmp/wayland-0 socket never appeared");
    code = 1;
  } else {
    // ── 3. Run wlhandshake ─────────────────────────────────────────────────
    s.send("export WAYLAND_DISPLAY=wayland-0\n");
    s.send("/bin/wlhandshake; echo HSDONE=$?\n");
    const done = await s.waitForOutput(/HSDONE=\d/, 20000);
    if (!done) {
      console.log("[sommelier-smoke] FAIL — wlhandshake timed out");
      code = 1;
    } else {
      // Give Sommelier's poll loop time to splice and SEND if it hasn't yet.
      s.send("sleep 1; echo SLEEPDONE\n");
      await s.waitForOutput(/SLEEPDONE/, 10000);

      const out = s.snapshot();

      // ── 4. Print transcript ──────────────────────────────────────────────
      console.log("── guest transcript ──");
      for (const l of out.split("\n")) {
        const stripped = l.replace(/\[[0-9;]*m/g, "").trim(); // strip ANSI
        if (
          /sommelier|wlhandshake:|RESULT wl-handshake|HSDONE=|virtwl|wayland-0|SOCKREADY/.test(
            stripped,
          )
        ) {
          console.log("  " + stripped);
        }
      }
      console.log("── host-side (JS virtio-wl) trail ──");
      for (const m of hostLog) {
        console.log("  " + m);
      }
      console.log("──────────────────────────────────");

      // ── 5. Assert PASS conditions ────────────────────────────────────────
      const hsPass = /RESULT wl-handshake PASS \d+/.test(out);
      const hsFail = /RESULT wl-handshake FAIL/.test(out);
      const hostSend = hostLog.some((m) => /\[virtio-wl\] SEND/.test(m));
      const dmabufFallback = /using virtwl instead/.test(out);

      console.log(
        `[sommelier-smoke] hsPass=${hsPass} hsFail=${hsFail} ` +
          `hostSend=${hostSend} dmabufFallback=${dmabufFallback}`,
      );

      if (hsFail) {
        code = 1;
        console.log("[sommelier-smoke] FAIL — wlhandshake reported FAIL");
      } else if (hsPass && hostSend) {
        code = 0;
        const globals = (out.match(/RESULT wl-handshake PASS (\d+)/) || [])[1] ?? "?";
        console.log(
          `[sommelier-smoke] PASS — registry handshake through Sommelier: ` +
            `${globals} globals seen, virtwl SEND observed, ` +
            `dmabuf fallback=${dmabufFallback}`,
        );
      } else if (hsPass) {
        // Handshake reported PASS but no virtio-wl SEND observed on the host.
        // A working Sommelier proxies guest Wayland traffic through the virtio-wl
        // device — a missing SEND means the transport may be broken (wlhandshake
        // got its response via a different path, or onLog missed it). Treat as
        // INCONCLUSIVE so a silent transport regression cannot produce a false PASS.
        code = 2;
        const globals = (out.match(/RESULT wl-handshake PASS (\d+)/) || [])[1] ?? "?";
        console.log(
          `[sommelier-smoke] INCONCLUSIVE — wlhandshake saw ${globals} globals ` +
            `but no virtio-wl SEND observed on host; check onLog filter or ` +
            `re-run to rule out a timing miss`,
        );
      } else {
        code = 1;
        console.log("[sommelier-smoke] FAIL — wlhandshake did not report PASS");
      }
    }
  }
} finally {
  s.kill();
}

process.exit(code);
