// wl-server-ffi-smoke.mjs — boots the busybox-only guest and runs
// /bin/wl-server-ffi, which proves libwayland-server's wl_closure_invoke
// dispatches through our raw wasm libffi backend (risk B de-risk).
//
// The program runs entirely in-process (no waylandproxyd needed): it creates a
// wl_display server + a wl_client over a socketpair, sends a custom ping(42)
// request from the client side, and asserts the server handler received it via
// wl_closure_invoke → ffi_call. PASS = "RESULT wl-server-ffi PASS handler_ran=1".
//
// Exit: 0 PASS / 1 FAIL / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[wl-server-ffi-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) {
    console.log("[wl-server-ffi-smoke] INCONCLUSIVE — no shell prompt after 90s; re-run");
    console.log(s.snapshot().slice(-2000));
    s.kill();
    process.exit(2);
  }

  s.send("/bin/wl-server-ffi; echo DONE=$?\n");
  const done = await s.waitForOutput(/DONE=\d/, 30000);
  if (!done) {
    console.log("[wl-server-ffi-smoke] FAIL — /bin/wl-server-ffi did not finish in 30s");
  }

  const out = s.snapshot();
  console.log("── guest transcript ──");
  for (const line of out.split("\n")) {
    // eslint-disable-next-line no-control-regex -- strip ANSI SGR escapes
    const clean = line.replace(/\[[0-9;]*m/g, "").trim();
    if (/wl-server-ffi:|RESULT wl-server-ffi|DONE=/.test(clean)) {
      console.log("  " + clean);
    }
  }
  console.log("─────────────────────");

  pass = /RESULT wl-server-ffi PASS handler_ran=1/.test(out);
  const anyFail = /RESULT wl-server-ffi FAIL/.test(out);

  if (pass) {
    console.log("[wl-server-ffi-smoke] PASS — server wl_closure_invoke → ffi_call fired");
  } else if (anyFail) {
    console.log("[wl-server-ffi-smoke] FAIL — RESULT FAIL seen in transcript");
  } else {
    console.log("[wl-server-ffi-smoke] FAIL — no RESULT line seen");
    console.log(out.slice(-2000));
  }
} finally {
  s.kill();
}

process.exit(pass ? 0 : 1);
