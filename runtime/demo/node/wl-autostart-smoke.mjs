// wl-autostart-smoke.mjs — issue #31 gate. Boots the FULL nix system and asserts
// that Sommelier auto-starts from the guest inittab (::respawn), with NO
// JS-side launch choreography. We never write a `sommelier --parent &` to any
// console; busybox init must bring it up on its own. We then read
// /var/log/sommelier.log for the "listening" marker and confirm the
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

  // Give init a moment to reach the sommelier respawn line + let sommelier
  // open /dev/wl0, bind, and listen.
  s.send("sleep 2; echo MARK-$?\n");
  await s.waitForOutput(/MARK-0/, 20000);

  // Confirm Sommelier is up: check its log file and that the wayland-0 socket
  // is bound under XDG_RUNTIME_DIR.
  s.send("echo LOG-START; cat /var/log/sommelier.log 2>&1; echo LOG-END\n");
  await s.waitForOutput(/LOG-END/, 20000);
  s.send("ls -l /tmp/wayland-0 2>&1; echo SOCK-DONE\n");
  await s.waitForOutput(/SOCK-DONE/, 20000);

  const out = s.snapshot(0);
  // Sommelier --parent prints "listening on wayland-0" (or similar) to its log.
  const sommelierListening = /listening|wayland-0|sommelier/i.test(
    out.split("LOG-START")[1]?.split("LOG-END")[0] || "",
  );
  const sockExists =
    /\/tmp\/wayland-0/.test(out) &&
    !/No such file/.test(out.split("ls -l /tmp/wayland-0")[1] || "");
  const logEmpty = (out.split("LOG-START")[1]?.split("LOG-END")[0] || "").trim() === "";

  console.log(
    `[wl-autostart] sommelierListening=${sommelierListening} sockExists=${sockExists} logEmpty=${logEmpty}`,
  );
  if (sockExists) {
    console.log(
      "[wl-autostart] PASS — Sommelier auto-started from inittab; wayland-0 socket bound",
    );
    code = 0;
  } else if (logEmpty) {
    console.log("[wl-autostart] FAIL — sommelier.log is empty; Sommelier did not start");
    code = 1;
  } else {
    console.log("[wl-autostart] FAIL — wayland-0 socket not bound after Sommelier start");
    code = 1;
  }
} finally {
  s.kill();
}
process.exit(code);
