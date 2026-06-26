// console-device.js — host (JS) model of a MULTIPORT virtio-console device on
// the `virtio_wasm` transport. This is the device the guest's STOCK mainline
// virtio-console driver (drivers/char/virtio_console.c, CONFIG_VIRTIO_CONSOLE)
// talks to. It is the guest's SOLE console transport: it replaced the bespoke
// `hvc_wasm` backend (kernel patches 0002/0003, retired) — the guest console is
// now a standard virtualized-Linux path (virtio-console → hvc), the same way the
// filesystem moved to stock virtio-9p and /Ctl to stock virtio-vsock.
//
// MULTIPORT (VIRTIO_CONSOLE_F_MULTIPORT). The device offers CONSOLE_PORTS console
// ports; the stock driver registers one hvc line per console port (hvc0..hvc{N-1},
// one per pc Terminal window + the wayland control console). This is what gives
// multi-tty parity with the old hvc_wasm path (which exposed HVC_WASM_NR=8 lines).
// hvc0 is also the boot console (`console=hvc`). Port index === hvc line index ===
// the engine's `vtermno`: the host sends PORT_ADD/PORT_READY→CONSOLE_PORT in port
// order, so the guest allocates hvc0..hvc{N-1} to ports 0..N-1 deterministically.
//
// Virtqueue layout for a multiport device with N ports (mainline init_vqs):
//   port 0      : receiveq = vq[0]      transmitq = vq[1]
//   control     : receiveq = vq[2]      transmitq = vq[3]
//   port i (≥1) : receiveq = vq[2+2i]   transmitq = vq[3+2i]
// "receiveq" is host→guest (guest posts writable inbufs; host fills them);
// "transmitq" is guest→host (guest posts readable outbufs; host drains them).
// N=CONSOLE_PORTS=8 ⇒ 18 vqs — which is why the transport's VIRTIO_WASM_MAX_VQS
// (kernel patch 0013) and the cross-worker MAX_QS (shared-queues.js) are sized to
// cover it.
//
// The control plane runs the port-lifecycle handshake (virtio spec §5.3.6):
//   guest →host (control transmitq): DEVICE_READY, then per port PORT_READY, and
//                                    PORT_OPEN when its tty side opens/closes;
//   host →guest (control receiveq) : per port PORT_ADD, then for each console port
//                                    CONSOLE_PORT + PORT_OPEN(1), and RESIZE
//                                    (cols,rows) to drive the tty winsize/SIGWINCH.
//
// WORKER→MAIN INVERSION (the same reason virtio-9p/wl/net/vsock aren't a free
// swap): the per-port output sink + input buffers live on the MAIN thread (where
// bootLinux's per-console fan-out runs), but the guest's vq kick lands on whichever
// task worker issued the syscall. So the worker-side instance only answers the
// synchronous transport probes (features / config / queue setup) and FORWARDS the
// notify to the main thread; the main-thread instance (given a `sink`) services
// every queue. Host→guest delivery (input + control) wakes a parked idle CPU via
// the SAME raised_irqs self-wake path virtio-wl/net/9P/vsock use (raiseHostWlIrq):
// the vring write happens before the OR-into-raised_irqs[0] + notify, so there is
// no lost-wakeup race.

import { VirtioWasmDevice } from "./device.js";

// Number of console ports the device exposes = number of hvc lines the guest
// registers (hvc0..hvc{N-1}). MUST match the guest inittab's getty count
// (userspace/init.nix nrConsoles) and is reported to the guest as the config
// `max_nr_ports`. 8 keeps parity with the retired hvc_wasm's HVC_WASM_NR.
export const CONSOLE_PORTS = 8;

// virtio_console feature bits (uapi/linux/virtio_console.h). We offer MULTIPORT
// (bit 1) so the guest sets up the control vq + N ports; per-port window size is
// driven by RESIZE control messages, so F_SIZE (bit 0, port-0 config cols/rows)
// is not needed. VIRTIO_F_VERSION_1 (bit 32) is OR'd in by the transport itself
// (vw_get_features in virtio_wasm.c), so it is not advertised here.
const VIRTIO_CONSOLE_F_MULTIPORT = 1n << 1n;

// virtio_console_control events (uapi/linux/virtio_console.h).
const VIRTIO_CONSOLE_DEVICE_READY = 0;
const VIRTIO_CONSOLE_PORT_ADD = 1;
// const VIRTIO_CONSOLE_PORT_REMOVE = 2;  // (we never remove ports)
const VIRTIO_CONSOLE_PORT_READY = 3;
const VIRTIO_CONSOLE_CONSOLE_PORT = 4;
const VIRTIO_CONSOLE_RESIZE = 5;
const VIRTIO_CONSOLE_PORT_OPEN = 6;
// const VIRTIO_CONSOLE_PORT_NAME = 7;    // (optional; we name no ports)

// Fixed control-plane queue indices (port 0 is special; control sits at 2/3).
const CONTROL_RECEIVEQ = 2; // host -> guest control messages (c_ivq)
const CONTROL_TRANSMITQ = 3; // guest -> host control messages (c_ovq)

// Data-queue index for a port (mainline layout above).
function portReceiveq(i) {
  return i === 0 ? 0 : 2 + 2 * i; // host -> guest input
}
function portTransmitq(i) {
  return i === 0 ? 1 : 3 + 2 * i; // guest -> host output
}

// Classify a kicked queue index → { kind, port? }. Inverse of the layout above.
function classifyQueue(q) {
  if (q === CONTROL_RECEIVEQ) return { kind: "ctrl-rx" };
  if (q === CONTROL_TRANSMITQ) return { kind: "ctrl-tx" };
  if (q === 0) return { kind: "rx", port: 0 };
  if (q === 1) return { kind: "tx", port: 0 };
  const port = (q >> 1) - 1; // q≥4: vq[2+2i]→even (rx), vq[3+2i]→odd (tx)
  return q % 2 === 0 ? { kind: "rx", port } : { kind: "tx", port };
}

export class ConsoleVirtioDevice extends VirtioWasmDevice {
  /**
   * Extends the base VirtioWasmDevice opts with:
   * - `ports` (number): console-port count (default CONSOLE_PORTS). MUST be the
   *   same on the worker and main instances (it drives the config max_nr_ports
   *   and the queue layout).
   * - `sink` ((port: number, bytes: Uint8Array) => void): MAIN-thread only —
   *   receives guest console output drained from a port's transmitq, tagged with
   *   the port (= hvc/vtermno) index. In bootLinux this funnels into the
   *   per-console output fan-out.
   * - `forwardNotify` ((dev, q) => void): WORKER only — forwards the kick to the
   *   main thread (where the sink + input buffers live) instead of servicing here.
   *
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & { ports?: number, sink?: (port: number, bytes: Uint8Array) => void, forwardNotify?: (dev: number, q: number) => void }} opts
   */
  constructor(opts) {
    super(opts);
    this.nrPorts = opts.ports || CONSOLE_PORTS;
    this.sink = opts.sink || null;
    this.forwardNotify = opts.forwardNotify || null;
    // Host->guest input bytes per port not yet delivered to a receiveq inbuf (the
    // guest may not have posted/refilled an inbuf yet). Flushed on the next
    // pushRx / receiveq refill.
    /** @type {Map<number, Uint8Array>} */
    this._pendingIn = new Map();
    // Host->guest control messages awaiting a control-receiveq inbuf (FIFO).
    /** @type {Uint8Array[]} */
    this._ctrlOut = [];
    // Last window size requested per port; (re)sent on PORT_READY so a resize
    // that arrives before the port becomes a console still lands.
    /** @type {Map<number, { cols: number, rows: number }>} */
    this._lastSize = new Map();
  }

  getFeatures() {
    // MULTIPORT only; the transport adds VIRTIO_F_VERSION_1.
    return VIRTIO_CONSOLE_F_MULTIPORT;
  }

  // virtio_console_config { __virtio16 cols; __virtio16 rows; __virtio32
  // max_nr_ports; __virtio32 emerg_wr; }. With MULTIPORT the guest reads
  // max_nr_ports (offset 4) to size its port table / vq count; cols/rows are
  // unused (no F_SIZE) and emerg_wr is not offered. Fill the requested window.
  configRead(offset, bytes) {
    const cfg = new Uint8Array(12);
    new DataView(cfg.buffer).setUint32(4, this.nrPorts, true); // max_nr_ports
    for (let i = 0; i < bytes.length; i++) {
      const src = offset + i;
      bytes[i] = src < cfg.length ? cfg[src] : 0;
    }
  }

  onNotify(q) {
    const qi = q >>> 0;
    if (this.forwardNotify) {
      // Worker side: the sink + buffers are on the main thread — forward.
      this.forwardNotify(this.dev, qi);
      return;
    }
    const c = classifyQueue(qi);
    switch (c.kind) {
      case "ctrl-tx":
        this.drainControlTx(); // guest -> host control (handshake)
        break;
      case "ctrl-rx":
        this.flushControlOut(); // guest refilled control inbufs
        break;
      case "tx":
        this.drainTx(c.port); // guest -> host console output
        break;
      case "rx":
        this.flushRx(c.port); // guest refilled a data receiveq
        break;
    }
  }

  // ---- control plane (guest -> host) ----

  /** Drain the control transmitq, run the handshake for each message, push the
   *  read-only chains used, then flush any control replies we queued. */
  drainControlTx() {
    const vr = this.vring(CONTROL_TRANSMITQ);
    if (!vr) return;
    let serviced = 0;
    let chain;
    while ((chain = vr.next())) {
      this.handleControl(vr.readOut(chain));
      vr.pushUsed(chain.head, 0); // control transmit buffers are read-only
      serviced++;
    }
    if (serviced) this.raiseIrq();
    this.flushControlOut();
  }

  /** Run one guest→host control message (struct virtio_console_control:
   *  id u32, event u16, value u16). */
  handleControl(bytes) {
    if (bytes.length < 8) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = dv.getUint32(0, true);
    const event = dv.getUint16(4, true);
    switch (event) {
      case VIRTIO_CONSOLE_DEVICE_READY:
        // The guest's port table is ready — add every port (in index order so
        // CONSOLE_PORT, and thus hvc allocation, stays port-ordered).
        for (let p = 0; p < this.nrPorts; p++) {
          this.queueControl(VIRTIO_CONSOLE_PORT_ADD, p, 1);
        }
        break;
      case VIRTIO_CONSOLE_PORT_READY: {
        // The guest finished adding port `id`. Mark it a console (→ hvc line),
        // open the host side, and (re)assert any pending window size.
        this.queueControl(VIRTIO_CONSOLE_CONSOLE_PORT, id, 1);
        this.queueControl(VIRTIO_CONSOLE_PORT_OPEN, id, 1);
        const s = this._lastSize.get(id);
        if (s) this.queueResize(id, s.cols, s.rows);
        break;
      }
      case VIRTIO_CONSOLE_PORT_OPEN:
        // The guest opened/closed its tty side; on open, deliver buffered input.
        this.flushRx(id);
        break;
      default:
        break; // PORT_NAME etc. — nothing the host must do
    }
  }

  /** Queue an 8-byte control message (id, event, value) for the control receiveq. */
  queueControl(event, id, value) {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, id >>> 0, true);
    dv.setUint16(4, event, true);
    dv.setUint16(6, value & 0xffff, true);
    this._ctrlOut.push(b);
  }

  /** Queue a RESIZE control message: the 8-byte header (event RESIZE) followed by
   *  the payload struct { __virtio16 cols; __virtio16 rows; } (cols first). */
  queueResize(id, cols, rows) {
    const b = new Uint8Array(12);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, id >>> 0, true);
    dv.setUint16(4, VIRTIO_CONSOLE_RESIZE, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, cols & 0xffff, true);
    dv.setUint16(10, rows & 0xffff, true);
    this._ctrlOut.push(b);
  }

  /** Deliver queued host→guest control messages into control-receiveq inbufs,
   *  oldest first, until the queue drains or no inbuf is free. */
  flushControlOut() {
    if (this._ctrlOut.length === 0) return;
    const vr = this.vring(CONTROL_RECEIVEQ);
    if (!vr) return; // control receiveq not set up yet — keep pending
    let delivered = 0;
    while (this._ctrlOut.length > 0) {
      const chain = vr.next();
      if (!chain) break; // no free inbuf — leave the rest pending
      const msg = this._ctrlOut[0];
      const cap = vr.inCapacity(chain);
      if (cap < msg.length) {
        // Control inbufs are page-sized; a smaller one is malformed. Recycle it
        // rather than truncate a control message (a partial frame desyncs the
        // guest's control parser).
        vr.pushUsed(chain.head, 0);
        continue;
      }
      const written = vr.writeIn(chain, msg);
      vr.pushUsed(chain.head, written);
      this._ctrlOut.shift();
      delivered++;
    }
    if (delivered) this.raiseIrq();
  }

  // ---- data plane ----

  /** Drain one port's transmitq (guest console output) to the sink, tagged with
   *  the port index, and push each read-only chain used (len 0). */
  drainTx(port) {
    const vr = this.vring(portTransmitq(port));
    if (!vr) {
      this.log(`[virtio-console] port ${port} transmitq notify before queue setup`);
      return;
    }
    let serviced = 0;
    let chain;
    while ((chain = vr.next())) {
      const bytes = vr.readOut(chain);
      if (bytes.length && this.sink) this.sink(port, Uint8Array.from(bytes));
      vr.pushUsed(chain.head, 0); // transmit buffers are read-only
      serviced++;
    }
    if (serviced) this.raiseIrq();
  }

  /** Queue host→guest input for a port and flush as many bytes as fit into its
   *  currently-posted receiveq inbufs; the rest stays pending. */
  pushRx(port, bytes) {
    if (bytes && bytes.length) {
      const prev = this._pendingIn.get(port);
      if (!prev || prev.length === 0) {
        this._pendingIn.set(port, Uint8Array.from(bytes));
      } else {
        const merged = new Uint8Array(prev.length + bytes.length);
        merged.set(prev, 0);
        merged.set(bytes, prev.length);
        this._pendingIn.set(port, merged);
      }
    }
    this.flushRx(port);
  }

  /** Deliver a port's pending input into its posted receiveq inbufs (a console is
   *  a byte stream, so partial inbufs are fine), raising the IRQ once if any. */
  flushRx(port) {
    let pending = this._pendingIn.get(port);
    if (!pending || pending.length === 0) return;
    const vr = this.vring(portReceiveq(port));
    if (!vr) return; // receiveq not set up yet — keep pending
    let delivered = 0;
    while (pending.length > 0) {
      const chain = vr.next();
      if (!chain) break; // no free inbuf — leave the rest pending
      const cap = vr.inCapacity(chain);
      if (cap === 0) {
        vr.pushUsed(chain.head, 0); // recycle a zero-capacity inbuf
        continue;
      }
      const take = Math.min(cap, pending.length);
      const written = vr.writeIn(chain, pending.subarray(0, take));
      vr.pushUsed(chain.head, written);
      pending = pending.subarray(written);
      delivered += written;
    }
    this._pendingIn.set(port, pending);
    if (delivered) this.raiseIrq();
  }

  /**
   * Set a port's window size (cols×rows). Records it (so PORT_READY can re-assert
   * it for a not-yet-opened port — the guest gates RESIZE on is_console_port) and
   * sends a RESIZE control message now if the device is up. The guest's
   * virtio_console turns this into hvc_resize → TIOCSWINSZ/SIGWINCH on the tty.
   */
  resize(port, cols, rows) {
    this._lastSize.set(port, { cols, rows });
    this.queueResize(port, cols, rows);
    this.flushControlOut();
  }

  /** Quiesce: forget every queue this multiport device owns (2 per port + the 2
   *  control queues). The base reset() only clears q0..3. */
  reset() {
    const n = 2 * this.nrPorts + 2;
    for (let q = 0; q < n; q++) this.shared.clear(this.dev, q);
    this.log(`[virtio-console] reset`);
  }
}
