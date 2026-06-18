// transport.js — the 9P-server side of the `trans_cb` ring (docs/linux.md §9.3).
//
// Drives a Ring (ring.js) against a 9P server (server.js): drains FILLED
// request slots, dispatches each frame through `server.handle()` (async, hits
// vfs.*), and writes each reply back to its slot — waking the blocked kernel
// task-worker. In production this runs inside a dedicated 9P-server Worker that
// shares the kernel's WebAssembly.Memory, so its vfs/IndexedDB awaits never
// touch the UI thread; the kernel task-workers are the ones that block on
// Atomics.wait.
//
// Concurrency: a single serviceOnce() dispatches every drained slot at once
// (each vfs.* is an independent promise), so concurrent tasks (distinct 9P
// tags / ring slots) are serviced in parallel — the loop uses Atomics.waitAsync
// (not a blocking wait) precisely so those awaits keep flowing while it sleeps
// on the doorbell.

import { Ring } from "./ring.js";

/**
 * @param {{
 *   server: { handle(bytes: Uint8Array, cid?: number): Promise<Uint8Array> },
 *   ring?: Ring,
 *   buffer?: SharedArrayBuffer|ArrayBuffer,
 * }} opts
 */
export function createNinePTransport(opts) {
  const server = opts.server;
  const ring = opts.ring || Ring.attach(opts.buffer);
  let running = false;

  /**
   * Drain all currently-FILLED slots once, dispatching concurrently. Returns
   * the number of requests serviced. Never throws — server.handle() turns
   * errors into Rlerror frames itself.
   */
  async function serviceOnce() {
    const slots = ring.serverScan();
    if (slots.length === 0) return 0;
    await Promise.all(
      slots.map(async (i) => {
        const reply = await server.handle(ring.serverReadRequest(i), ring.serverReadCid(i));
        ring.serverWriteReply(i, reply);
      }),
    );
    return slots.length;
  }

  /**
   * Run the service loop until stop()/abort. Sleeps on the doorbell between
   * drains. The timeout is a safety re-scan, not a correctness dependency.
   * @param {{ signal?: AbortSignal }} [o]
   */
  async function run(o = {}) {
    running = true;
    while (running && !(o.signal && o.signal.aborted)) {
      const before = ring.doorbell(); // capture before scanning (no lost wakeup)
      await serviceOnce();
      const w = ring.waitDoorbell(before, 1000);
      if (w.async) await w.value; // resolves on doorbell bump, timeout, or already-advanced
    }
    running = false;
  }

  function stop() {
    running = false;
  }

  return { serviceOnce, run, stop, ring };
}
