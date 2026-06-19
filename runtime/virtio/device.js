// device.js — base JS host model for a `virtio_wasm` transport device
// (Linux/Wasm, "pc" Wayland Phase 1). Generalized in 1b from the 1a echo spike.
//
// The guest kernel's drivers/virtio/virtio_wasm.c registers one or more virtio
// devices, each with N split virtqueues whose layout it hands the host via
// wasm_virtio_setup_queue(dev, q, ...). A subclass of VirtioWasmDevice models
// one such device: it owns the queues and implements onNotify(q) to service a
// kicked queue, then calls this.raiseIrq() to deliver the used-buffer interrupt.
//
// CPU-0 RULE (1a finding, now inherited by every device — not a per-call knob):
// pc boots maxcpus=1, so CPU 0 is the only online CPU. The kernel's nominal
// IRQ_CPU=1 idle loop never runs, so raise_interrupt(1, ...) sets a bit nobody
// reads. The host MUST raise on the lowest online CPU (0). This is baked into
// raiseIrq() via the online-CPU mask (default {0}); a device model never picks
// a CPU itself.

import { Vring } from "./vring.js";

export class VirtioWasmDevice {
  /**
   * @param {object} opts
   * @param {number} opts.dev   host device index (matches the guest's `dev`)
   * @param {number} opts.irq   the irq this device's request_irq() grabbed
   *                            (VIRTIO_WASM_IRQ_BASE + dev in virtio_wasm.c)
   * @param {WebAssembly.Memory} opts.memory  shared kernel memory
   * @param {(cpu:number, irq:number)=>void} opts.raiseInterrupt  guest export
   * @param {Set<number>|number[]} [opts.onlineCpus]  online CPU mask (default {0})
   * @param {import("./shared-queues.js").SharedQueues} opts.sharedQueues
   *   cross-worker queue-layout store (a queue set up on one worker must be
   *   serviceable from another; see shared-queues.js).
   * @param {(s:string)=>void} [opts.log]
   */
  constructor({ dev, irq, memory, raiseInterrupt, onlineCpus, sharedQueues, log }) {
    this.dev = dev >>> 0;
    this.irq = irq;
    this.memory = memory;
    this._raise = raiseInterrupt;
    this.shared = sharedQueues;
    // The interrupt-target CPU is DERIVED from the online mask, never chosen by
    // a device. Lowest online CPU; defaults to 0 under maxcpus=1.
    const cpus = onlineCpus ? [...onlineCpus] : [0];
    this.irqCpu = cpus.length ? Math.min(...cpus) : 0;
    this.log = log || (() => {});
  }

  /** Called from wasm_virtio_setup_queue: record a queue's vring layout. */
  setupQueue(q, desc, avail, used, num) {
    this.shared.set(this.dev, q >>> 0, desc, avail, used, num);
    this.log(`[virtio dev${this.dev}] setup q=${q} desc=${desc} num=${num}`);
  }

  /**
   * Build a Vring for queue q from the shared layout, with its host-side avail
   * cursor backed by the cross-worker store. Returns null if q isn't set up.
   */
  vring(q) {
    const qi = q >>> 0;
    const layout = this.shared.get(this.dev, qi);
    if (!layout) return null;
    return new Vring(this.memory, layout, {
      load: () => this.shared.loadLastAvail(this.dev, qi),
      store: (v) => this.shared.storeLastAvail(this.dev, qi, v),
    });
  }

  /** Deliver this device's used-buffer interrupt to the (sole) online CPU. */
  raiseIrq() {
    this._raise(this.irqCpu, this.irq);
  }

  /** Called from wasm_virtio_notify: guest kicked queue q. Override. */
  onNotify(_q) {
    throw new Error("VirtioWasmDevice.onNotify not implemented");
  }

  /** Device feature bits offered to the guest (host side). Override if any. */
  getFeatures() {
    return 0n;
  }

  /** Read device config space into `bytes` (a Uint8Array view) at `offset`. */
  configRead(_offset, bytes) {
    bytes.fill(0); // no device-specific config by default
  }

  /** Write device config space. Override if writable config exists. */
  configWrite(_offset, _bytes) {}

  /** Quiesce: forget all queue state. Called from wasm_virtio_reset. */
  reset() {
    for (let q = 0; q < 4; q++) this.shared.clear(this.dev, q);
    this.log(`[virtio dev${this.dev}] reset`);
  }

  // ---- helpers for config space backed by the shared memory ----

  /** A Uint8Array view of `len` bytes at linear-memory offset `buf`. */
  memView(buf, len) {
    return new Uint8Array(this.memory.buffer, Number(buf), Number(len));
  }
}
