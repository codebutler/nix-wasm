// sommelier-leak-smoke.mjs — Task 10 / issue #7: virtwl shm buffer alloc/free
// leak regression. Boots the busybox-only guest (nix:false), starts Sommelier
// --parent, then runs /bin/wl-pool-churn which creates+attaches+commits N
// wl_shm buffers (driving Sommelier's VIRTWL_IOCTL_NEW_ALLOC), holds them, then
// destroys them all.
//
// wl-pool-churn self-measures guest MemFree and only prints
// "RESULT wl-pool-churn PASS" when BOTH hold true:
//   - alloc actually happened   (MemFree dropped ~N*4 MB while buffers held)
//   - everything was freed       (MemFree recovered after destroy)
// On waylandproxyd the buffers allocate but are never freed on destroy → the
// MemFree does NOT recover → FAIL (and the leaked NEW_ALLOC objects fragment the
// buddy allocator → order-11 failures). On Sommelier (libwayland-server frees the
// buffer on destroy) → PASS. So a green run proves the alloc path is real AND the
// lifecycle fix works — it can't pass trivially.
//
// This smoke also asserts there were no order-11 page allocation failures in the
// kernel log (the downstream symptom of the original crash).
//
// Exit 0 PASS / 1 FAIL / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

// Reliability wrapper: the boot + buffer churn pushes a kernel worker thread's V8
// isolate to a "Zone" OOM during teardown — AFTER wl-pool-churn has already
// printed its verdict — which corrupts node's exit code (133). So run the real
// test in a CHILD and decide pass/fail in a tiny PARENT by grepping the child's
// output. The parent never boots/churns, so it always exits cleanly.
if (!process.env.__LEAK_CHILD) {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, __LEAK_CHILD: "1" },
  });
  process.stdout.write(r.stdout || "");
  const out = (r.stdout || "") + (r.stderr || "");
  if (/\[sommelier-leak-smoke\] PASS/.test(out)) process.exit(0);
  if (/\[sommelier-leak-smoke\] INCONCLUSIVE/.test(out)) process.exit(2);
  process.exit(1);
}

// N buffers of 4 MiB. 16 is proven to drive ~128 MB of allocation (client shm +
// Sommelier NEW_ALLOC) while staying under the worker-thread memory pressure that
// would OOM the child before it reports — plenty to distinguish leak from no-leak.
const N = 16;

const s = await bootNode({ nix: false });

let code = 2;
try {
  const got = await s.waitForPrompt(90000).catch((e) => {
    if (String(e.message).includes("KERNEL_PANIC")) return null;
    throw e;
  });
  if (!got) {
    console.log("[sommelier-leak-smoke] INCONCLUSIVE — no shell prompt / boot panic (re-run)");
    process.exit(2);
  }

  // Start Sommelier --parent and wait for the wayland-0 socket to be bound.
  s.send("export XDG_RUNTIME_DIR=/tmp\n");
  s.send("/bin/sommelier --parent 2>/tmp/sommelier.log &\n");
  let socketReady = false;
  for (let i = 0; i < 20; i++) {
    s.send("ls /tmp/wayland-0 2>/dev/null && echo SOCKREADY || echo SOCKWAIT\n");
    await s.waitForOutput(/SOCKREADY|SOCKWAIT/, 4000);
    if (/SOCKREADY/.test(s.snapshot())) {
      socketReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!socketReady) {
    console.log("[sommelier-leak-smoke] FAIL — /tmp/wayland-0 socket never appeared");
    code = 1;
  } else {
    // Run the self-validating churn (it reads /proc/meminfo around hold/release).
    s.send(`/bin/wl-pool-churn ${N}; echo CHURN_EXIT=$?\n`);
    const churnDone = await s.waitForOutput(/CHURN_EXIT=\d/, 120000);
    const out = s.snapshot();
    const resultLine = (out.match(/RESULT wl-pool-churn (PASS|FAIL)[^\n]*/) || [])[0] || "";
    const churnPass = /RESULT wl-pool-churn PASS/.test(out);

    // Downstream symptom guard: a leak fragments the buddy allocator → order-11
    // (8 MB) page allocation failures in the kernel log.
    s.send("dmesg | grep -c 'page allocation failure' || true; echo DMESG_DONE\n");
    await s.waitForOutput(/DMESG_DONE/, 10000);
    const dmesgSection = s.snapshot().split("DMESG_DONE").slice(-2)[0] ?? "";
    const order11Failures = parseInt((dmesgSection.match(/^(\d+)$/m) || [])[1] ?? "0", 10);

    console.log("[sommelier-leak-smoke] " + (resultLine || "(no RESULT line from wl-pool-churn)"));
    console.log(
      `[sommelier-leak-smoke] churnDone=${!!churnDone} order11Failures=${order11Failures}`,
    );

    if (!churnDone) {
      console.log("[sommelier-leak-smoke] FAIL — wl-pool-churn timed out");
      code = 1;
    } else if (!churnPass) {
      console.log(
        "[sommelier-leak-smoke] FAIL — wl-pool-churn did not report PASS (alloc/free check)",
      );
      code = 1;
    } else if (order11Failures > 0) {
      console.log(
        `[sommelier-leak-smoke] FAIL — ${order11Failures} page allocation failure(s) in dmesg`,
      );
      code = 1;
    } else {
      console.log(
        `[sommelier-leak-smoke] PASS — ${N} buffers allocated+freed through Sommelier; no leak, no order-11 failures`,
      );
      code = 0;
    }
  }
} finally {
  if (code !== 0) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  // Exit before s.kill(): the worker-teardown can trip a V8 "Zone" OOM after the
  // verdict; the parent wrapper above already captured the result line.
  process.exit(code);
}
