// console-device.js — host (JS) model of a virtio-console device on the
// `virtio_wasm` transport. This is the device the guest's STOCK mainline
// virtio-console driver (drivers/char/virtio_console.c, CONFIG_VIRTIO_CONSOLE)
// talks to, providing a guest TTY ALONGSIDE the existing bespoke hvc_wasm
// backend (issue #10 option 2: "everything is a virtio device" — console
// edition). It is added next to hvc_wasm so the two console paths can be A/B'd;
// hvc_wasm is NOT removed by this change.
//
// SINGLE PORT (no VIRTIO_CONSOLE_F_MULTIPORT). Mainline virtio_console binds a
// port to a (receiveq, transmitq) virtqueue pair; a featureless device gets one
// port (port 0) wired to hvc as a console line. So this device has exactly two
// vqs, mirroring virtio-net's directionality:
//   vq[0] = receiveq  (host -> guest): the guest posts WRITABLE inbufs; the host
//           fills them with input bytes (keystrokes) and pushes them used.
//   vq[1] = transmitq (guest -> host): the guest posts READABLE outbufs holding
//           console output; the host drains them to the console sink and pushes
//           them used (len 0 — transmit buffers are read-only).
// This is the hvc-equivalent of one console (hvc0). MULTIPORT (the hvc0..hvc7
// model the existing hvc_wasm path exposes via HVC_WASM_NR=8) is a DOCUMENTED
// GAP, not stubbed: extending it means adding the control vq + per-port queues
// here and offering VIRTIO_CONSOLE_F_MULTIPORT in the kernel registration
// (patch 0019). Until then a single port is the correct minimal console.
//
// WORKER->MAIN INVERSION (the same reason virtio-9p/wl/net aren't a free swap):
// the console sink + input buffer live on the MAIN thread (where bootLinux's
// per-console fan-out and key_input run), but the guest's vq kick lands on
// whichever task worker issued the syscall. So the worker-side instance only
// answers the synchronous transport probes (features / config / queue setup)
// and FORWARDS the notify to the main thread; the main-thread instance (given a
// `sink`) drains the transmitq to the sink. Host input (host -> guest) is
// delivered by the MAIN-thread instance too (pushRx), waking a parked idle CPU
// via the SAME raised_irqs self-wake path virtio-wl/net/9P use (raiseHostWlIrq):
// the OR-into-raised_irqs[0] + notify happens after the receiveq write, so there
// is no lost-wakeup race.

import { VirtioWasmDevice } from "./device.js";

// virtio-console queue indices for a single (non-multiport) port: the receiveq
// is queue 0, the transmitq is queue 1 (uapi/linux/virtio_console.h port-0
// convention; virtio_console.c's pdev->in_vqs[0]/out_vqs[0]).
const RECEIVEQ = 0; // host -> guest (guest posts writable inbufs)
const TRANSMITQ = 1; // guest -> host (guest posts readable outbufs)

// virtio-console feature bits (uapi/linux/virtio_console.h). We offer NONE: no
// VIRTIO_CONSOLE_F_SIZE (cols/rows config — TIOCSWINSZ stays on hvc_wasm for
// now) and no VIRTIO_CONSOLE_F_MULTIPORT (single port — see the header note).
// VIRTIO_F_VERSION_1 (bit 32) is OR'd in by the transport itself (vw_get_features
// in virtio_wasm.c), so the device need not advertise it here.

export class ConsoleVirtioDevice extends VirtioWasmDevice {
  /**
   * Extends the base VirtioWasmDevice opts with:
   * - `sink` ((bytes: Uint8Array) => void): MAIN-thread only — receives guest
   *   console output drained from the transmitq. In bootLinux this funnels into
   *   the per-console output fan-out (tagged as the single virtio console).
   * - `forwardNotify` ((dev, q) => void): WORKER only — forwards the kick to the
   *   main thread (where the sink + input buffer live) instead of servicing here.
   *
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & { sink?: (bytes: Uint8Array) => void, forwardNotify?: (dev: number, q: number) => void }} opts
   */
  constructor(opts) {
    super(opts);
    this.sink = opts.sink || null;
    this.forwardNotify = opts.forwardNotify || null;
    // Host -> guest input bytes not yet delivered to a receiveq inbuf (the guest
    // may not have posted an inbuf yet). Flushed on the next pushRx/refill.
    /** @type {Uint8Array} */
    this._pending = new Uint8Array(0);
  }

  getFeatures() {
    // No optional console features (single port, no size); the transport adds
    // VIRTIO_F_VERSION_1 on top.
    return 0n;
  }

  // virtio_console_config is only read when VIRTIO_CONSOLE_F_SIZE /
  // _MULTIPORT are offered; we offer neither, so config space is unused. Keep
  // the base zero-fill behaviour (defensive: a spec-conformant driver won't read
  // it without the gating feature).
  // configRead inherited from VirtioWasmDevice (zero-fill).

  onNotify(q) {
    const qi = q >>> 0;
    if (this.forwardNotify) {
      // Worker side: the sink + input buffer are on the main thread — forward.
      this.forwardNotify(this.dev, qi);
      return;
    }
    if (qi === TRANSMITQ) {
      this.drainTx();
    } else if (qi === RECEIVEQ) {
      // The guest (re)posted receiveq inbufs — try to deliver any pending input.
      this.flushRx();
    }
  }

  /**
   * Drain the transmitq: read each guest console-output chain and hand its bytes
   * to the sink, then push the chain used (transmit buffers are read-only → used
   * len 0). Raises the device IRQ once if any chain was consumed so the guest's
   * blocked write completes.
   */
  drainTx() {
    const vr = this.vring(TRANSMITQ);
    if (!vr) {
      this.log("[virtio-console] transmitq notify before queue setup");
      return;
    }
    let serviced = 0;
    let chain;
    while ((chain = vr.next())) {
      const bytes = vr.readOut(chain);
      if (bytes.length && this.sink) this.sink(Uint8Array.from(bytes));
      vr.pushUsed(chain.head, 0); // transmit buffers are read-only
      serviced++;
    }
    if (serviced) this.raiseIrq();
  }

  /**
   * Queue host->guest input bytes for delivery on the receiveq, then flush as
   * many as fit into currently-posted inbufs. Bytes that don't fit (no free
   * inbuf) stay pending and are delivered on the next flushRx (a receiveq
   * refill kick or a later pushRx). Mirrors NetDevice.pushRx, but a console is a
   * byte stream (no framing), so partial inbufs are fine and leftovers are kept.
   * @param {Uint8Array} bytes
   */
  pushRx(bytes) {
    if (bytes && bytes.length) {
      if (this._pending.length === 0) {
        this._pending = Uint8Array.from(bytes);
      } else {
        const merged = new Uint8Array(this._pending.length + bytes.length);
        merged.set(this._pending, 0);
        merged.set(bytes, this._pending.length);
        this._pending = merged;
      }
    }
    this.flushRx();
  }

  /**
   * Deliver pending input bytes into the guest's posted receiveq inbufs,
   * one chain at a time, until either the pending buffer is empty or the guest
   * has no more inbufs. Raises the device IRQ once if anything was delivered.
   */
  flushRx() {
    if (this._pending.length === 0) return;
    const vr = this.vring(RECEIVEQ);
    if (!vr) return; // receiveq not set up yet — keep pending
    let delivered = 0;
    while (this._pending.length > 0) {
      const chain = vr.next();
      if (!chain) break; // no free inbuf — leave the rest pending
      const cap = vr.inCapacity(chain);
      if (cap === 0) {
        vr.pushUsed(chain.head, 0); // recycle a zero-capacity inbuf
        continue;
      }
      const take = Math.min(cap, this._pending.length);
      const written = vr.writeIn(chain, this._pending.subarray(0, take));
      vr.pushUsed(chain.head, written);
      this._pending = this._pending.subarray(written);
      delivered += written;
    }
    if (delivered) this.raiseIrq();
  }
}
