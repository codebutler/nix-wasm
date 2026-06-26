// console-device.js — host (JS) model of a SINGLE-PORT virtio-console device on
// the `virtio_wasm` transport. This is the device the guest's STOCK mainline
// virtio-console driver (drivers/char/virtio_console.c, CONFIG_VIRTIO_CONSOLE)
// talks to. It is the guest's SOLE console transport: it replaced the bespoke
// `hvc_wasm` backend (kernel patches 0002/0003, retired) — the guest console is
// now a standard virtualized-Linux path (virtio-console → hvc), the same way the
// filesystem moved to stock virtio-9p and /Ctl to stock virtio-vsock.
//
// ONE DEVICE = ONE CONSOLE; MULTI-TTY = N DEVICES (issue #83). Each device is a
// featureless single-port virtio-console. The crucial property is SYNCHRONOUS
// console registration: in the non-multiport probe path, virtcons_probe calls
// add_port(0) → init_port_console → hvc_alloc DURING the device probe (a
// device_initcall, before userspace init runs), so the hvc line exists before
// PID 1 opens /dev/console. A MULTIPORT device instead adds its console ports
// ASYNCHRONOUSLY via the control-vq handshake (DEVICE_READY → PORT_ADD →
// PORT_READY → CONSOLE_PORT), which the single-CPU wasm boot RACES — init runs
// and dies ("Attempted to kill init") before hvc0 registers. So multiport is a
// dead end here; instead the transport registers N single-port console devices
// (CONSOLE_DEVICES), and the stock driver registers one hvc line per device
// SYNCHRONOUSLY → hvc0..hvc{N-1}, one per pc Terminal window. hvc line index ===
// device registration order === the engine's `vtermno`.
//
// Two virtqueues per device (mainline single-port layout):
//   vq[0] = receiveq  (host -> guest): the guest posts WRITABLE inbufs; the host
//           fills them with input bytes (keystrokes) and pushes them used.
//   vq[1] = transmitq (guest -> host): the guest posts READABLE outbufs of
//           console output; the host drains them to the `sink` and pushes them
//           used (len 0 — transmit buffers are read-only).
//
// NO RESIZE YET. Single-port resize needs VIRTIO_CONSOLE_F_SIZE + a config-change
// interrupt (the multiport RESIZE control message isn't available without the
// control vq), and the wasm transport has no config-change path yet — a
// documented follow-up, not stubbed. Until then the guest tty keeps its boot
// winsize (TIOCSWINSZ does not propagate).
//
// WORKER→MAIN INVERSION (the same reason virtio-9p/wl/net/vsock aren't a free
// swap): the output sink + input buffer live on the MAIN thread (where bootLinux's
// per-console fan-out runs), but the guest's vq kick lands on whichever task
// worker issued the syscall. So the worker-side instance only answers the
// synchronous transport probes (features / config / queue setup) and FORWARDS the
// notify to the main thread; the main-thread instance (given a `sink`) drains the
// transmitq / delivers receiveq input. Host→guest input wakes a parked idle CPU
// via the SAME raised_irqs self-wake path virtio-wl/net/9P/vsock use
// (raiseHostWlIrq): the receiveq write happens before the OR-into-raised_irqs[0] +
// notify, so there is no lost-wakeup race.

import { VirtioWasmDevice } from "./device.js";

// Number of single-port console devices the transport registers = number of hvc
// lines the guest exposes (hvc0..hvc{N-1}). MUST match the kernel transport's
// console-device registration (kernel patch 0019, VW_DEV_CONSOLE_BASE..+8) and
// the guest inittab's getty count (userspace/init.nix nrConsoles). 8 keeps parity
// with the retired hvc_wasm's HVC_WASM_NR.
export const CONSOLE_DEVICES = 8;

// Host device index of the FIRST console device; the transport registers
// CONSOLE_DEVICES consecutive single-port virtio-console devices at
// CONSOLE_BASE..CONSOLE_BASE+CONSOLE_DEVICES-1. Console index N (hvcN) === device
// CONSOLE_BASE+N. MUST match kernel patch 0019 (VW_DEV_CONSOLE_BASE = 8). Index 6
// is unused and 7 is virtio-vsock (VW_DEV_VSOCK), so the consoles sit at 8..15.
export const CONSOLE_BASE = 8;

// virtio-console queue indices for a single (non-multiport) port: receiveq is
// queue 0, transmitq is queue 1 (uapi/linux/virtio_console.h port-0 convention;
// virtio_console.c's pdev->in_vqs[0]/out_vqs[0]).
const RECEIVEQ = 0; // host -> guest (guest posts writable inbufs)
const TRANSMITQ = 1; // guest -> host (guest posts readable outbufs)

export class ConsoleVirtioDevice extends VirtioWasmDevice {
  /**
   * Extends the base VirtioWasmDevice opts with:
   * - `sink` ((bytes: Uint8Array) => void): MAIN-thread only — receives this
   *   console's output drained from the transmitq. In bootLinux each device's
   *   sink is wired to its console (hvc/vtermno) index's output fan-out.
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
    // No optional console features → the guest takes the non-multiport probe
    // path (add_port(0) → init_port_console → hvc_alloc SYNCHRONOUSLY, before
    // init), so the console exists when PID 1 opens /dev/console. The transport
    // adds VIRTIO_F_VERSION_1 on top.
    return 0n;
  }

  // virtio_console_config is only read when VIRTIO_CONSOLE_F_SIZE / _MULTIPORT
  // are offered; we offer neither, so config space is unused. Keep the base
  // zero-fill behaviour (a spec-conformant driver won't read it without the
  // gating feature). configRead inherited from VirtioWasmDevice (zero-fill).

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
   * inbuf) stay pending and are delivered on the next flushRx (a receiveq refill
   * kick or a later pushRx). A console is a byte stream (no framing), so partial
   * inbufs are fine and leftovers are kept.
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
   * Deliver pending input bytes into the guest's posted receiveq inbufs, one
   * chain at a time, until either the pending buffer is empty or the guest has
   * no more inbufs. Raises the device IRQ once if anything was delivered.
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
