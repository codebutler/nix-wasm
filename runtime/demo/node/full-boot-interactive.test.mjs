// full-boot-interactive.test.mjs — regression for the getty/login boot deadlocks
// (netfs offload, patch 0018; nommu_region_tree corruption, patch 0020). Boots
// the FULL NixOS userspace (nix:true, wasm_user_as ON) with MULTIPLE concurrent
// gettys — the concurrent getty->login->ash exec race that corrupted the global
// region tree — and asserts the autologin shell is INTERACTIVE (a command runs
// and its output comes back), not merely that a `#` prompt printed.
//
// Artifacts: a FULL-NixOS served closure (nix:true). Defaults to the repo's
// runtime/web/artifacts/ (the standard 8-getty closure — `nix build .#kernel
// .#wasm-initramfs .#wasm-store-manifest`), which reproduces the original
// concurrent-getty race and passes post-fix. Override with
// LINUX_WASM_ARTIFACTS_FULL to point at another full-NixOS artifact dir; e.g. a
// reduced-getty one (`.#wasm-store-manifest-3getty`) if a RAM-constrained host
// can't hold the 8-getty worker_threads × per-process WebAssembly.Memory set.
// SKIPS (not fails) when the artifact dir is absent — a prerequisite gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootNode } from "./boot-node.mjs";

const ART =
  process.env.LINUX_WASM_ARTIFACTS_FULL ||
  process.env.LINUX_WASM_ARTIFACTS ||
  new URL("../web/artifacts/", import.meta.url).href;
const have = ART && (!ART.startsWith("file:") || existsSync(fileURLToPath(new URL("vmlinux.wasm", ART))));

test(
  "full NixOS boot reaches an INTERACTIVE autologin shell (region-tree wedge regression)",
  {
    timeout: 120000,
    skip: have
      ? false
      : "set LINUX_WASM_ARTIFACTS_FULL to a full-NixOS reduced-getty artifact dir (see header)",
  },
  async () => {
    const s = await bootNode({ nix: true, baseUrl: ART });
    try {
      // Drain non-primary consoles (their gettys flood; untapped backlog grows).
      for (let i = 1; i < s.consoleCount; i++) s.handle.console(i).onData(() => {});
      // Wait for the autologin shell banner. We do NOT use waitForPrompt: kernel
      // printk (per-exec "wasm_user_as: create" lines) interleaves on hvc0, so
      // the `#` prompt is rarely the last byte — the banner is the reliable mark.
      const banner = await s.waitForOutput(/built-in shell \(ash\)/, 60000, 0);
      assert.equal(banner, true, "autologin shell banner not reached:\n" + s.snapshot(0).slice(-800));
      // The wedge printed a banner but was NOT interactive — so prove a command
      // round-trips (shell evaluates $((...)) and echoes the result back).
      s.send("echo REGRESSION_OK_$((6*7))\n", 0);
      const got = await s.waitForOutput(/REGRESSION_OK_42/, 25000, 0);
      assert.equal(got, true, "shell not interactive (echo round-trip never returned):\n" + s.snapshot(0).slice(-800));
    } finally {
      s.kill();
    }
  },
);
