// boot-mvp.test.mjs — Exercises boot-node.mjs's expect API (bootNode →
// waitForPrompt/send/snapshot) on a busybox boot; the raw bootNixSystem path
// is covered by boot.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootNode } from "./boot-node.mjs";

test(
  "bootNode expect API: boots to a shell prompt and runs a command",
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
  { timeout: 90000 },
);
