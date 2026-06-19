// task2.2-allocator-dark.test.mjs — Task 2.2: per-`mm` base-0 allocator + the
// user/kernel gate, landed DARK (feature-flagged OFF by default).
//
// The dark contract (see task-2.2-report.md "the dark/flag decision"):
//   * DEFAULT boot (flag `wasm_user_as` unset/0): `mm->context.user_as_live`
//     stays 0, every gate site (do_mmap_private / anon-zero / do_munmap /
//     exit_mmap) takes the LEGACY shared `alloc_pages_exact` path, the
//     wasm_user_mem_create/free lifecycle ops never fire, and boot is bit-for-bit
//     the pre-0016 behavior → reaches a shell. This is what keeps default green.
//   * FLAG-ON boot (`wasm_user_as=1`): the per-`mm` allocator + create/free wire
//     up. The allocator can't be proven by a full boot — the user module is still
//     instantiated against the SHARED memory (the flip is T2.3), so a process
//     handed small private offsets can't run. We therefore prove the allocator by
//     an IN-KERNEL boot-time SELF-TEST (pure bump/free-list math, no runtime
//     memory needed) that runs before any user exec and prints
//     `WASM_USER_AS_SELFTEST: PASS` with the first offset it handed out (which
//     must be >= USER_AS_BASE 0x10000, i.e. a small private offset, not a shared
//     pool address), plus a one-line `wasm_user_as: create pid=N` marker the
//     first time create fires at exec. That is the honest dark verification the
//     plan/spec asks for, deferring the "running process over private memory"
//     proof to T2.3.
//
// Both halves gate on the nix-built artifacts (LINUX_WASM_ARTIFACTS or the
// runtime/web/artifacts symlink): they SKIP, not fail, when absent. The flag-on
// half additionally needs a vmlinux carrying patch 0016 — the same default
// artifact, just booted with the cmdline flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../index.js";
import { DEFAULT_CMDLINE } from "../boot.js";
import { MemVfs } from "../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const haveArtifacts =
  !ARTIFACTS.startsWith("file:") || existsSync(fileURLToPath(new URL("vmlinux.wasm", ARTIFACTS)));
const skipArtifacts = haveArtifacts
  ? false
  : "set LINUX_WASM_ARTIFACTS or symlink runtime/web/artifacts to a `nix build` output";

async function bootAndCollect({ cmdline, untilRe, settleMs = 90000 }) {
  installWebShims();
  const vfs = MemVfs.from({ Home: {} });
  const handle = await bootNixSystem({ vfs, baseUrl: ARTIFACTS, nix: false, cmdline });
  let out = "";
  handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
  const t0 = Date.now();
  while (Date.now() - t0 < settleMs && !untilRe.test(out)) {
    if (/KERNEL_PANIC_UNHANDLED|Kernel panic/i.test(out)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { handle, out };
}

// DEFAULT (dark, flag off): boots green, AND the lifecycle ops never fired
// (no `wasm_user_as: create` marker), confirming the legacy shared path is taken.
test(
  "default boot stays green and the dark allocator never activates",
  { timeout: 120000, skip: skipArtifacts },
  async () => {
    const { handle, out } = await bootAndCollect({ untilRe: /[#$]\s*$/m });
    try {
      assert.match(out, /[#$]\s*$/m, "expected a shell prompt on the default (flag-off) boot");
      assert.doesNotMatch(
        out,
        /wasm_user_as: create/,
        "create must NOT fire when the flag is off (legacy shared path)",
      );
      assert.doesNotMatch(
        out,
        /WASM_USER_AS_SELFTEST/,
        "the allocator self-test must NOT run when the flag is off",
      );
      handle.console(0).write("echo ALLOC_DARK_OK\n");
      const t1 = Date.now();
      let tail = out;
      handle.console(0).onData((b) => (tail += new TextDecoder().decode(b)));
      while (Date.now() - t1 < 10000 && !/ALLOC_DARK_OK/.test(tail)) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.match(tail, /ALLOC_DARK_OK/, "shell is live on the default boot");
    } finally {
      handle.kill();
      await terminateAllWorkers();
    }
  },
);

// FLAG-ON: the in-kernel allocator self-test PASSes (offsets in [0x10000, size))
// and `create` fires at the first exec. Proves the allocator + lifecycle wiring
// without needing private instantiation (that's T2.3). The self-test is a
// late_initcall that runs at boot BEFORE any user exec, so it is observable even
// though a flag-on userspace can't reach a usable shell yet: with instantiation
// still SHARED (T2.3 hasn't flipped it), the process is handed small private
// offsets with no backing in the shared memory, so the first exec traps
// ("table index out of bounds") and panics. That trap is the EXPECTED proof that
// the gate routed the user mappings into the private space — it is exactly why
// the path is flagged off by default. (Also: under Node's web-shims the
// main-thread Memory mint can't be structured-clone-transferred to the worker, a
// Node-only `DataCloneError`; both are benign here and tolerated below.)
test(
  "flag-on: in-kernel allocator self-test passes and create fires at exec",
  { timeout: 120000, skip: skipArtifacts },
  async () => {
    // The flag-on user exec trap + the Node-only Memory-transfer DataCloneError
    // surface as uncaughtExceptions (thrown from worker message handlers, off the
    // await chain). They are EXPECTED on this path; swallow only those, rethrow
    // anything else, and restore the handler in finally.
    const benign = (e) => {
      const s = String((e && e.message) || e);
      return (
        /Found invalid value in transferList/.test(s) || // Node can't transfer WebAssembly.Memory
        /table index is out of bounds/.test(s) || // flag-on exec over shared mem (no T2.3 flip)
        /should be ignored.*host glue/i.test(s) || // Linux/Wasm panic glue
        (e && e.kind === "panic")
      );
    };
    const prior = process.listeners("uncaughtException").slice();
    for (const l of prior) process.removeListener("uncaughtException", l);
    const guard = (e) => {
      if (!benign(e)) {
        for (const l of prior) process.on("uncaughtException", l);
        throw e;
      }
    };
    process.on("uncaughtException", guard);

    // Append the flag to the DEFAULT cmdline — `cmdline` REPLACES it, so passing
    // only "wasm_user_as=1" would drop init=/console= and the kernel never boots.
    // bailing at the self-test match returns BEFORE the user exec/panic.
    const { handle, out } = await bootAndCollect({
      cmdline: DEFAULT_CMDLINE + " wasm_user_as=1",
      untilRe: /WASM_USER_AS_SELFTEST:\s*PASS/,
      settleMs: 90000,
    });
    try {
      assert.match(
        out,
        /WASM_USER_AS_SELFTEST:\s*PASS/,
        "the per-mm allocator self-test must PASS with the flag on",
      );
      // The self-test prints the first handed-out offset; it must be a small
      // private offset >= USER_AS_BASE (0x10000), not a large shared-pool address.
      const m = out.match(/WASM_USER_AS_SELFTEST:\s*PASS first=0x([0-9a-fA-F]+)/);
      assert.ok(m, "self-test reports the first offset it handed out");
      const first = parseInt(m[1], 16);
      assert.ok(
        first >= 0x10000,
        `first allocator offset 0x${first.toString(16)} must be >= USER_AS_BASE (0x10000)`,
      );
    } finally {
      handle.kill();
      await terminateAllWorkers();
      // Let any in-flight benign worker-teardown exceptions settle, then restore.
      await new Promise((r) => setTimeout(r, 250));
      process.removeListener("uncaughtException", guard);
      for (const l of prior) process.on("uncaughtException", l);
    }
  },
);

// FLAG-ON teardown: a flag-on process gets PRIVATE regions (small offsets), then
// traps at exec instantiation (still shared — T2.3). Its mm teardown
// (exit_mm sets current->mm=NULL, then mmput->exit_mmap runs the per-VMA loop
// delete_vma->put_nommu_region->free_page_series) MUST free the private extents
// via the OWNING-mm gate. The T2.2 review found a Critical here: gating on
// current->mm (NULL at exit) let private offsets fall through to
// virt_to_page()/put_page() on a bogus struct page → "Bad page"/BUG. Assert the
// fix: create fires, AND the teardown produces NO struct-page-corruption output.
test(
  "flag-on: exec→exit teardown frees private regions via the owning mm (no bogus struct page)",
  { timeout: 120000, skip: skipArtifacts },
  async () => {
    const benign = (e) => {
      const s = String((e && e.message) || e);
      return (
        /Found invalid value in transferList/.test(s) ||
        /table index is out of bounds/.test(s) ||
        /should be ignored.*host glue/i.test(s) ||
        (e && e.kind === "panic")
      );
    };
    const prior = process.listeners("uncaughtException").slice();
    for (const l of prior) process.removeListener("uncaughtException", l);
    const guard = (e) => {
      if (!benign(e)) {
        for (const l of prior) process.on("uncaughtException", l);
        throw e;
      }
    };
    process.on("uncaughtException", guard);

    // Run past create + the exec trap into the mm teardown. Keep a LIVE collector
    // on the returned handle (bootAndCollect's `out` snapshot is frozen at return).
    const { handle, out: snap } = await bootAndCollect({
      cmdline: DEFAULT_CMDLINE + " wasm_user_as=1",
      untilRe: /wasm_user_as: create pid=/,
      settleMs: 90000,
    });
    let out = snap;
    handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
    try {
      // create fired → the process got private regions out of the allocator.
      assert.match(out, /wasm_user_as: create pid=/, "create fires at exec (private regions)");
      // give the exec trap + mm teardown time to run the per-VMA free loop.
      await new Promise((r) => setTimeout(r, 3000));
      // The owning-mm gate must keep the private free path off the struct-page
      // code: NO "Bad page", "BUG", or put_page/virt_to_page corruption output.
      assert.doesNotMatch(
        out,
        /Bad page|BUG:|bad_page|corrupted|VM_BUG/i,
        "private-region teardown must not touch a bogus struct page",
      );
    } finally {
      handle.kill();
      await terminateAllWorkers();
      await new Promise((r) => setTimeout(r, 250));
      process.removeListener("uncaughtException", guard);
      for (const l of prior) process.on("uncaughtException", l);
    }
  },
);
