// worker-bridge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebWorker } from "./web-shims.mjs";

test("bootstrap maps self.* and shares WebAssembly.Memory", async () => {
  const fixture = new URL("./echo-fixture.worker.mjs", import.meta.url).href;
  const w = new WebWorker(fixture, { type: "module" });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });

  const ack = new Promise((resolve) => {
    w.onmessage = (e) => resolve(e.data);
  });
  w.postMessage({ method: "poke", memory, value: 0xbeef });
  const reply = await ack;

  assert.equal(reply.method, "ack");
  // The worker wrote 0xbeef into the shared memory at i32 index 0.
  assert.equal(new Int32Array(memory.buffer)[0], 0xbeef);
  w.terminate();
});
