// host-call.js — the kernel↔ring adapter for the `trans_cb` 9P transport
// (docs/linux.md §9). This implements the single Wasm host import that the
// kernel side calls:
//
//   long wasm_driver_9p_request(u32 cid, const u8 *tc, u32 tc_size, u8 *rc, u32 rc_cap)
//
// `cid` is the connection id trans_cb assigns each p9_client (one per guest
// mount); it rides the ring slot so the JS 9P server keeps per-connection state
// (msize + fid namespace) when several mounts share this one ring (Phase E/N1).
//
// It runs on a kernel *task-worker* (the same thread that issued the syscall),
// so it is allowed to block. It:
//   1. copies the request frame out of the kernel's shared linear memory,
//   2. drives ring.clientRequest(frame) — which posts to the SAB ring, rings
//      the doorbell, and blocks this worker on Atomics.wait until the JS
//      9P-server worker (transport.run over the same ring) writes the reply,
//   3. copies the reply frame back into the kernel's memory at `rc`,
//   4. returns the reply length, or a negative errno on a transport failure.
//
// This is the JS mirror of drivers/tty/hvc/hvc_wasm.c's wasm_driver_hvc_get:
// the kernel makes one synchronous import call; the *blocking* happens here in
// JS while another thread does the async work. Protocol-level errors are NOT
// negative returns — they come back as a framed Rlerror reply (a normal,
// positive-length frame the kernel hands up as an errno).

const EIO = -5; // -EIO: transport failure (ring full, copy error, …)

/**
 * Build the wasm_driver_9p_request import bound to a kernel memory + ring.
 *
 * @param {{ memory: { buffer: ArrayBufferLike }, ring: { clientRequest(frame: Uint8Array, cid?: number): Uint8Array } }} opts
 *   - memory: the kernel's WebAssembly.Memory (its `.buffer` is re-read on every
 *     access because a concurrent task-worker may grow it while we're blocked).
 *   - ring: a Ring (js/linux/ninep/ring.js) over the shared 9P transport SAB.
 * @returns {(cid: number, tc: number, tc_size: number, rc: number, rc_cap: number) => number}
 */
export function makeWasm9pRequest({ memory, ring }) {
  return function wasm_driver_9p_request(cid, tc, tc_size, rc, rc_cap) {
    let reply;
    try {
      // Copy the request frame out BEFORE blocking: clientRequest may park
      // this worker, and a grow() on another worker would detach this view.
      const frame = new Uint8Array(memory.buffer, tc, tc_size).slice();
      reply = ring.clientRequest(frame, cid);
    } catch {
      return EIO;
    }
    // Re-derive the view AFTER the round-trip — memory may have grown.
    const n = Math.min(reply.length, rc_cap);
    new Uint8Array(memory.buffer).set(reply.subarray(0, n), rc);
    return n;
  };
}
