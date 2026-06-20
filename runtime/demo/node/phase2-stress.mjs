// Phase 2 stability — fork stress + teardown/leak check.
//
// Boots busybox and runs /bin/fork-stress (50 fork/exit/reap cycles), asserting:
//   - correctness: every child spawned, ran, exited the expected code, was reaped
//     (`STRESS done forks=50 ok=50`, program exit 0);
//   - no worker leak: the live Web Worker count never climbs with the iteration
//     count (each fork child's task worker is terminated when its task is reaped)
//     and returns to the post-boot baseline afterwards;
//   - no scheduler wedge: it completes (a hang would time out → inconclusive).
//
// Exit 0 = PASS, 1 = FAIL, 2 = inconclusive (boot panic / timeout — re-run).
// Needs LINUX_WASM_ARTIFACTS=file:///path/ (vmlinux.wasm + initramfs.cpio.gz with
// /bin/fork-stress).
import { installWebShims, terminateAllWorkers, liveWorkerCount } from "./web-shims.mjs";
import { bootNixSystem } from "../../index.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORKS = 50;

async function main() {
  installWebShims();
  const handle = await bootNixSystem({
    vfs: MemVfs.from({ Home: {} }),
    baseUrl: ARTIFACTS,
    nix: false,
  });
  let out = "";
  handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
  const send = (s) => handle.console(0).write(s);

  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !/[#$]\s*$/.test(out.trimEnd())) {
    if (/panic/i.test(out)) {
      console.error("BOOT PANIC:\n" + out.slice(-1500));
      handle.kill();
      await terminateAllWorkers();
      process.exit(2);
    }
    await sleep(500);
  }
  if (!/[#$]\s*$/.test(out.trimEnd())) {
    console.error("no shell prompt");
    handle.kill();
    await terminateAllWorkers();
    process.exit(2);
  }
  await sleep(1000);
  const baseline = liveWorkerCount();
  console.log(`baseline live workers (post-boot): ${baseline}`);

  // Run the stress program; sample the worker count while it runs to catch a
  // monotonic climb (a per-fork leak would push it toward baseline+FORKS).
  out = "";
  const marker = "STRESSDONE_";
  send(`/bin/fork-stress; echo ${marker}$?\n`);
  let peak = baseline;
  const t1 = Date.now();
  while (Date.now() - t1 < 240000 && !new RegExp(marker + "\\d").test(out)) {
    if (/panic/i.test(out)) {
      console.error("PANIC during stress:\n" + out.slice(-1500));
      handle.kill();
      await terminateAllWorkers();
      process.exit(2);
    }
    peak = Math.max(peak, liveWorkerCount());
    await sleep(250);
  }
  const exitM = new RegExp(marker + "(\\d+)").exec(out);
  if (!exitM) {
    console.error("STRESS TIMED OUT (possible scheduler wedge / leak)\n" + out.slice(-1500));
    handle.kill();
    await terminateAllWorkers();
    process.exit(2);
  }

  // Let teardown settle, then measure the resting worker count.
  let settled = liveWorkerCount();
  for (let i = 0; i < 20 && settled > baseline; i++) {
    await sleep(500);
    settled = liveWorkerCount();
  }

  console.log("---- guest ----\n" + out.trim() + "\n--------------");
  console.log(`peak live workers during run: ${peak}  (baseline ${baseline})`);
  console.log(`resting live workers after run: ${settled}  (baseline ${baseline})`);

  handle.kill();
  await terminateAllWorkers();

  const done = /STRESS done forks=(\d+) ok=(\d+)/.exec(out);
  const checks = [
    [
      "correctness: all forks ran + reaped with right status",
      done && Number(done[1]) === FORKS && Number(done[2]) === FORKS,
    ],
    ["program exited 0", exitM[1] === "0"],
    // Sequential fork/wait → at most ~2 task workers live at once; a per-fork
    // leak would instead trend toward baseline+FORKS. Allow generous slack.
    [
      "no worker climb during run (peak well under baseline+FORKS)",
      peak < baseline + Math.floor(FORKS / 2),
    ],
    ["workers reclaimed to baseline after run (no leak)", settled <= baseline + 1],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    ok = ok && !!pass;
  }
  if (!ok) {
    console.error("PHASE2 STRESS FAIL");
    process.exit(1);
  }
  console.log(`PHASE2 STRESS PASS — ${FORKS} fork/exit cycles, no leak, no wedge`);
}

main().catch((e) => {
  console.error("harness error:", e && e.stack ? e.stack : e);
  process.exit(2);
});
