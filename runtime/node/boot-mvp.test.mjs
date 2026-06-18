// boot-mvp.test.mjs — Exercises boot-node.mjs's expect API (bootNode →
// waitForPrompt/send/snapshot) on a busybox boot; the raw bootNixSystem path
// is covered by boot.test.mjs.
//
// Tests SKIP (not fail) when artifacts are absent — prerequisite-gate only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootNode } from "./boot-node.mjs";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const haveArtifacts =
  !ARTIFACTS.startsWith("file:") || existsSync(fileURLToPath(new URL("vmlinux.wasm", ARTIFACTS)));

test(
  "bootNode expect API: boots to a shell prompt and runs a command",
  {
    timeout: 90000,
    skip: haveArtifacts
      ? false
      : "set LINUX_WASM_ARTIFACTS or symlink runtime/web/artifacts to a `nix build` output",
  },
  async () => {
    const s = await bootNode({ nix: false });
    try {
      const reached = await s.waitForPrompt(60000);
      assert.equal(reached, true, "shell prompt not reached:\n" + s.snapshot().slice(-1000));
      s.send("echo NODE_HARNESS_OK\n");
      assert.equal(await s.waitForOutput(/NODE_HARNESS_OK/, 15000), true);
    } finally {
      s.kill();
    }
  },
);
