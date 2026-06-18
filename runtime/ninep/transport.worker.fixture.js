// @ts-nocheck
// Test fixture (NOT a *.test.js, so the bun runner ignores it): the 9P-server
// half of the end-to-end transport test. It attaches the shared ring, builds a
// MemVfs-backed 9P server, and runs the service loop — exactly the role the
// dedicated 9P-server Worker plays in production (docs/linux.md §9.3), except
// the vfs is in-memory instead of IndexedDB. The main thread drives it as a
// blocking kernel task-worker.
import { Ring } from "./ring.js";
import { createNinePServer } from "./server.js";
import { createNinePTransport } from "./transport.js";
import { MemVfs } from "./mem-vfs.js";

self.onmessage = (e) => {
  const { buffer, seed } = e.data || {};
  if (!buffer) return;
  const vfs = MemVfs.from(seed || {});
  const transport = createNinePTransport({
    ring: Ring.attach(buffer),
    server: createNinePServer({ vfs }),
  });
  transport.run(); // loops on the doorbell via Atomics.waitAsync
  self.postMessage("ready");
};
