// ninep-device.js — host (JS) model of a virtio-9p device on the `virtio_wasm`
// transport. This is the device the guest's STOCK mainline 9P-over-virtio
// transport (net/9p/trans_virtio.c, CONFIG_NET_9P_VIRTIO) talks to, replacing
// the bespoke trans_cb SAB-ring transport (issue #10: "everything is a virtio
// device" — make the guest a standard virtualized Linux at the 9P layer).
//
// One device == one 9P connection. Mainline 9pnet_virtio binds a single
// virtqueue named "requests" and one mount tag per virtio device; a mount
// selects the channel by tag (`mount -t 9p -o trans=virtio <tag>`). So this
// repo registers one device per mount: the pc VFS export (tag "pcroot") and the
// nix binary cache (tag "nixcache"). Each carries a distinct 9P connection id
// (`cid`) so the shared 9P server isolates per-connection state (negotiated
// msize + the fid namespace) exactly as the trans_cb cid did.
//
// The "requests" vq is symmetric: the guest posts a descriptor chain whose
// READABLE (out) segments hold the 9P T-message and whose WRITABLE (in) segments
// are space for the R-message. The host reads the T-message, runs it through the
// 9P server, writes the R-message back over the in segments, pushes the chain
// used, and raises the device IRQ.
//
// WORKER→MAIN INVERSION (the reason this isn't a trivial swap — issue #10):
// the 9P server is async (the VFS may be IndexedDB/host-bound) and lives on the
// MAIN thread, but the guest's vq kick (wasm_virtio_notify) lands on whichever
// task worker issued the syscall. So a worker-side instance only answers the
// synchronous transport probes (features / config / queue setup) and FORWARDS
// the notify to the main thread; a main-thread instance (given `server`) does
// the async drain→handle→reply→IRQ. The IRQ is raised via the SAME raised_irqs
// self-wake path virtio_wl/virtio_net use (kernel-host raiseHostWlIrq): when the
// requesting task blocks in p9_client_rpc, CPU 0's idle task parks in
// arch_cpu_idle's wait64 on raised_irqs[0]; OR-ing the irq bit + notifying wakes
// it to run the virtio IRQ handler, which completes the 9P request. The OR
// happens before the notify, so there is no lost-wakeup race (the next wait64
// sees the pending bit and returns immediately).

import { VirtioWasmDevice } from "./device.js";

// virtio-9p feature bits (uapi/linux/virtio_9p.h + virtio_config.h).
const VIRTIO_9P_MOUNT_TAG = 0n; // device carries a mount tag in config space
const VIRTIO_F_VERSION_1 = 32n; // modern (v1) device

export class NinePVirtioDevice extends VirtioWasmDevice {
  /**
   * Extends the base VirtioWasmDevice opts with:
   * - `tag` (string): mount tag advertised in config space.
   * - `cid` (number): 9P connection id, for per-connection isolation in the
   *   shared server (negotiated msize + fid namespace). Defaults to 0.
   * - `server` ({ handle(bytes, cid): Promise<Uint8Array>|Uint8Array }): MAIN-thread
   *   only — the 9P server that services the vq.
   * - `forwardNotify` ((dev, q) => void): WORKER only — forwards the kick to the
   *   main thread (where the async server lives) instead of servicing it here.
   *
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & { tag: string, cid?: number, server?: { handle(bytes: Uint8Array, cid?: number): Promise<Uint8Array>|Uint8Array }, forwardNotify?: (dev: number, q: number) => void }} opts
   */
  constructor(opts) {
    super(opts);
    this.tag = opts.tag;
    this.cid = (opts.cid ?? 0) >>> 0;
    this.server = opts.server || null;
    this.forwardNotify = opts.forwardNotify || null;
    this._tagBytes = new TextEncoder().encode(this.tag);
    // Re-entrancy: service() is async; a kick arriving mid-drain sets _rearm so
    // the drain loop re-scans rather than overlapping two drains on one vq.
    this._servicing = false;
    this._rearm = false;
  }

  getFeatures() {
    return (1n << VIRTIO_9P_MOUNT_TAG) | (1n << VIRTIO_F_VERSION_1);
  }

  // struct virtio_9p_config { __virtio16 tag_len; __u8 tag[]; } — little-endian.
  // The guest driver reads tag_len (offset 0) then tag (offset 2). Serve the
  // requested slice from that buffer, zero-padding past the end.
  configRead(offset, bytes) {
    const cfg = new Uint8Array(2 + this._tagBytes.length);
    new DataView(cfg.buffer).setUint16(0, this._tagBytes.length, true);
    cfg.set(this._tagBytes, 2);
    for (let i = 0; i < bytes.length; i++) {
      const src = offset + i;
      bytes[i] = src < cfg.length ? cfg[src] : 0;
    }
  }

  onNotify(q) {
    const qi = q >>> 0;
    if (this.forwardNotify) {
      // Worker side: the 9P server is on the main thread — forward the kick.
      this.forwardNotify(this.dev, qi);
      return;
    }
    // Main-thread side: drain + service asynchronously (fire-and-forget; the
    // guest task is parked waiting for the completion IRQ, not for this call).
    void this.service(qi);
  }

  /**
   * Drain the "requests" vq, run each T-message through the 9P server, write the
   * R-message back, push the chains used, and raise the device IRQ. Async (the
   * VFS is async) and re-entrancy-safe: a kick arriving while a drain is in
   * flight re-scans instead of overlapping. Never throws — server.handle turns
   * 9P errors into Rlerror frames itself; the catch is a last-resort guard.
   * @param {number} q
   */
  async service(q) {
    if (!this.server) {
      this.log(`[virtio-9p ${this.tag}] service() with no server`);
      return;
    }
    if (this._servicing) {
      this._rearm = true;
      return;
    }
    this._servicing = true;
    try {
      do {
        this._rearm = false;
        const vr = this.vring(q);
        if (!vr) {
          this.log(`[virtio-9p ${this.tag}] notify before queue setup`);
          return;
        }
        // Snapshot every available chain up front (readOut copies the request
        // bytes out of the vring), then service them concurrently — matching the
        // trans_cb transport's Promise.all dispatch so independent in-flight 9P
        // requests (distinct tags) aren't serialized behind one slow VFS call.
        const work = [];
        let chain;
        while ((chain = vr.next())) work.push({ chain, req: vr.readOut(chain) });
        if (work.length === 0) continue;
        await Promise.all(
          work.map(async ({ chain, req }) => {
            let reply;
            try {
              reply = await this.server.handle(req, this.cid);
            } catch (e) {
              // server.handle is supposed to encode errors as Rlerror; if it
              // throws anyway, complete the chain (0-length) so the guest's
              // request errors out instead of hanging forever.
              this.log(`[virtio-9p ${this.tag}] handle threw: ${e}`);
              reply = new Uint8Array(0);
            }
            const written = vr.writeIn(chain, reply);
            vr.pushUsed(chain.head, written);
          }),
        );
        this.raiseIrq();
      } while (this._rearm);
    } finally {
      this._servicing = false;
    }
  }
}
