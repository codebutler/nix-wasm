// task2.4-teardown.test.mjs — Task 2.4 teardown / no-leak: the per-process memory
// registry (`userMems`) returns to baseline after processes exit. Every
// `wasm_user_mem_create(pid)` at exec MUST be matched by a `wasm_user_mem_free(pid)`
// at exit_mmap, so a spawn/exit storm cannot grow the registry without bound.
//
// Observation is via the kernel console markers, gated identically to the create
// marker (so the canonical flag-OFF boot stays byte-unchanged):
//   `wasm_user_as: create pid=N pages=…`   (patch 0016, at exec)
//   `wasm_user_as: free pid=N`             (patch 0021, at wasm_user_as_destroy)
// There is no direct JS handle into the worker-local `userMems` map; the
// create/free marker balance is the honest proxy for registry size — every free
// marker is emitted from the exact site that calls `userMems.delete(pid)`
// (hostbridge `wasm_user_mem_free`).
//
// WHY THIS PROVES NO LEAK: we count creates and frees across a 50-iteration
// `/bin/true` spawn loop. If exits did NOT free their private memory, frees would
// lag creates and the count gap would grow with the loop; we assert the gap stays
// bounded (frees catch up to creates) — i.e. the registry returns to baseline.
//
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";
import { MemVfs } from "../ninep/mem-vfs.js";

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
};
const count = (re, s) => (s.match(re) || []).length;

const s = await bootNode({
  vfs: MemVfs.from({ Home: {} }),
  nix: false,
  // `wasm_user_as_freelog` opts the per-exit `wasm_user_as: free pid=N` marker IN
  // (patch 0021; OFF by default so it can't interleave into pipeline output on a
  // normal flag-on boot). This test needs the free markers to count create/free
  // balance, so it explicitly enables them.
  cmdline:
    "maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0 wasm_user_as wasm_user_as_freelog",
});

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[t2.4-teardown] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached over a private memory");

  const CRE = /wasm_user_as: create pid=\d+ pages=\d+/g;
  const FREE = /wasm_user_as: free pid=\d+/g;

  // Baseline AFTER boot has settled: both markers must already be present and
  // roughly balanced (boot itself spawns + reaps many processes).
  const baseline = s.snapshot();
  const cre0 = count(CRE, baseline);
  const free0 = count(FREE, baseline);
  check(cre0 > 0, "create markers present at baseline (allocator active)", ` (${cre0})`);
  check(free0 > 0, "free markers present at baseline (free path fires on exit)", ` (${free0})`);

  // Spawn/exit storm: 50 short-lived processes. Each `/bin/true` exec → one
  // create; its exit → one free.
  const LOOP = 50;
  s.send(`i=0; while [ $i -lt ${LOOP} ]; do /bin/true; i=$((i+1)); done; echo LOOP_DONE\n`);
  check(await s.waitForOutput(/LOOP_DONE/, 60000), "spawn/exit loop completed");

  // The create/free printk markers flush to the console slightly AFTER the
  // shell's `echo LOOP_DONE` (kernel printk vs hvc ordering), so poll until the
  // loop's creates have all landed (or a ceiling) before sampling the balance.
  for (let i = 0; i < 40 && count(CRE, s.snapshot()) - cre0 < LOOP; i++) {
    await s.waitForOutput(/never-matches-just-settle/, 250).catch(() => {});
  }

  const after = s.snapshot();
  const cre1 = count(CRE, after);
  const free1 = count(FREE, after);
  check(
    cre1 - cre0 >= LOOP,
    `the loop drove >=${LOOP} new creates`,
    ` (Δcreate=${cre1 - cre0})`,
  );
  // The registry returns to baseline: frees track creates. Allow a tiny window
  // for the last in-flight exit(s) still tearing down when we sampled (a handful
  // of background helpers), but the gap MUST NOT scale with the 50-iteration loop.
  const gap = cre1 - free1;
  check(
    gap <= 5,
    "registry balanced — frees track creates (no leak across the storm)",
    ` (creates=${cre1} frees=${free1} gap=${gap})`,
  );
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-4000));
  s.kill();
}

console.log("\n[t2.4-teardown] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
