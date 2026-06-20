// phase1-acceptance.mjs — Task 3 aggregate: the full Phase-1 (per-process memory
// isolation) acceptance suite, run over per-process memory (wasm_user_as, the
// default cmdline). Each sub-test boots the guest, so the whole suite is heavy
// (~minutes per boot) and memory-sensitive — intended for CI / a deliberate
// local capstone run, not the fast inner loop. Point LINUX_WASM_ARTIFACTS at a
// full artifact set (vmlinux.wasm + initramfs.cpio.gz + store.json + nix-cache/)
// for the smoke (Phase B) step; the busybox-only sub-tests need no nix-cache.
//
// Exit: 0 all pass / 1 any fail.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// [file, mode]: "node" = standalone script (process.exit), "test" = node:test.
const SUITE = [
  ["task2.2-allocator-dark.test.mjs", "test"], // allocator + flag-off byte-identical
  ["task2.3-private-mem.test.mjs", "node"], // the flip: malloc / CLONE_VM / 8MB grow
  ["task2.4-isolation.test.mjs", "node"], // B1: cross-process isolation probe
  ["task2.4-teardown.test.mjs", "node"], // registry no-leak
  ["task2.5-fastpath.test.mjs", "node"], // B2: clone-with-fn regression
  ["smoke.mjs", "node"], // capstone: full nix-system Phase A + B (needs nix-cache)
];

// Sub-tests exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run). An
// inconclusive run is NOT a failure: surface it as inconclusive so the aggregate
// is re-run rather than read as a real regression.
let fail = false;
let inconclusive = false;
for (const [file, mode] of SUITE) {
  const args = mode === "test" ? ["--test", join(here, file)] : [join(here, file)];
  console.log(`\n=== phase1-acceptance: ${file} ===`);
  const r = spawnSync("node", args, { stdio: "inherit" });
  const status = r.status === 2 ? "INCONCLUSIVE" : r.status === 0 ? "PASS" : "FAIL";
  if (r.status === 2) inconclusive = true;
  else if (r.status !== 0) fail = true;
  console.log(`--- ${file}: ${status} (exit ${r.status}) ---`);
}

const overall = fail ? "FAIL" : inconclusive ? "INCONCLUSIVE (re-run)" : "ALL PASS";
console.log(`\n[phase1-acceptance] ${overall}`);
process.exit(fail ? 1 : inconclusive ? 2 : 0);
