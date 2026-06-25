// wl-autostart-smoke.mjs — issue #31 gate. Boots the FULL nix system and asserts
// that waylandproxyd auto-starts from the guest inittab (::respawn), with NO
// JS-side launch choreography. We never write a `waylandproxyd &` to any console;
// busybox init must bring it up on its own. We then read /var/log/waylandproxyd.log
// for the "RESULT waylandproxyd PASS ... listening" marker and confirm the
// $XDG_RUNTIME_DIR/wayland-0 socket exists.
//
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });

let code = 2;
try {
  const ok = await s.waitForPrompt(120000).catch((e) => {
    if (String(e.message).includes("KERNEL_PANIC")) return null;
    throw e;
  });
  if (ok === null) {
    console.log("[wl-autostart] INCONCLUSIVE — boot panic (re-run)");
    s.kill();
    process.exit(2);
  }
  if (!ok) {
    console.log("[wl-autostart] FAIL — no shell prompt within timeout");
    s.kill();
    process.exit(1);
  }

  // Give init a moment to reach the waylandproxyd respawn line + let the proxy
  // open /dev/wl0, bind, and listen.
  s.send("sleep 2; echo MARK-$?\n");
  await s.waitForOutput(/MARK-0/, 20000);

  // Confirm the proxy is up: its PASS marker landed in the log file, and the
  // wayland-0 socket is bound under XDG_RUNTIME_DIR.
  s.send("echo LOG-START; cat /var/log/waylandproxyd.log 2>&1; echo LOG-END\n");
  await s.waitForOutput(/LOG-END/, 20000);
  s.send("ls -l /tmp/wayland-0 2>&1; echo SOCK-DONE\n");
  await s.waitForOutput(/SOCK-DONE/, 20000);

  const out = s.snapshot(0);
  const proxyPass = /RESULT waylandproxyd PASS .*listening/.test(out);
  const sockExists =
    /\/tmp\/wayland-0/.test(out) &&
    !/No such file/.test(out.split("ls -l /tmp/wayland-0")[1] || "");
  const proxyFail = /RESULT waylandproxyd FAIL/.test(out);

  console.log(
    `[wl-autostart] proxyPass=${proxyPass} sockExists=${sockExists} proxyFail=${proxyFail}`,
  );
  if (proxyFail) {
    console.log("[wl-autostart] FAIL — waylandproxyd reported FAIL");
    code = 1;
  } else if (proxyPass && sockExists) {
    console.log(
      "[wl-autostart] PASS — waylandproxyd auto-started from inittab; wayland-0 socket bound",
    );
    code = 0;
  } else {
    console.log("[wl-autostart] FAIL — proxy did not come up from inittab");
    code = 1;
  }
} finally {
  s.kill();
}
process.exit(code);
