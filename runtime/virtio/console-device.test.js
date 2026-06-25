import { describe, it, expect } from "bun:test";
import { ConsoleVirtioDevice } from "./console-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

// virtio-console single-port queue indices (mirrors console-device.js).
const RECEIVEQ = 0; // host -> guest
const TRANSMITQ = 1; // guest -> host

// Minimal split-vring builder in flat memory (mirrored from ninep-device.test.js).
function makeVq(memory, base, num) {
  const dv = new DataView(memory.buffer);
  const desc = base;
  const avail = base + num * 16;
  const used = avail + 4 + num * 2 + 2;
  return {
    desc,
    avail,
    used,
    num,
    setDesc(i, addr, len, write, next) {
      const d = desc + i * 16;
      dv.setBigUint64(d, BigInt(addr), true);
      dv.setUint32(d + 8, len, true);
      dv.setUint16(
        d + 12,
        (write ? VRING_DESC_F_WRITE : 0) | (next != null ? VRING_DESC_F_NEXT : 0),
        true,
      );
      dv.setUint16(d + 14, next ?? 0, true);
    },
    pushAvail(head) {
      const idx = dv.getUint16(avail + 2, true);
      dv.setUint16(avail + 4 + (idx % num) * 2, head, true);
      dv.setUint16(avail + 2, (idx + 1) & 0xffff, true);
    },
    usedIdx() {
      return dv.getUint16(used + 2, true);
    },
    usedElem(slot) {
      return {
        id: dv.getUint32(used + 4 + slot * 8, true),
        len: dv.getUint32(used + 8 + slot * 8, true),
      };
    },
  };
}

function makeDev({ sink, forwardNotify } = {}) {
  const memory = { buffer: new ArrayBuffer(64 * 1024) };
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dev = new ConsoleVirtioDevice({
    dev: 6,
    irq: 14,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    sink,
    forwardNotify,
  });
  return { dev, memory, shared, irqs };
}

// A transmitq chain: one READABLE (out) segment holding guest console output.
function makeTxRing(opts) {
  const ctx = makeDev(opts);
  const { dev, memory } = ctx;
  const vq = makeVq(memory, 0x1000, 8);
  dev.setupQueue(TRANSMITQ, vq.desc, vq.avail, vq.used, vq.num);
  const OUT = 0x4000;
  const STRIDE = 0x200; // per-head buffer so concurrent chains don't alias
  function submit(bytes, head = 0) {
    const addr = OUT + head * STRIDE;
    new Uint8Array(memory.buffer, addr, bytes.length).set(bytes);
    vq.setDesc(head, addr, bytes.length, false, null);
    vq.pushAvail(head);
  }
  return { ...ctx, vq, submit };
}

// A receiveq chain: one WRITABLE (in) segment the host fills with host input.
function makeRxRing(opts) {
  const ctx = makeDev(opts);
  const { dev, memory } = ctx;
  const vq = makeVq(memory, 0x1000, 8);
  dev.setupQueue(RECEIVEQ, vq.desc, vq.avail, vq.used, vq.num);
  const IN = 0x4000;
  const CAP = 0x100;
  function postInbuf(head, cap = CAP, addr = IN + head * CAP) {
    new Uint8Array(memory.buffer, addr, cap).fill(0);
    vq.setDesc(head, addr, cap, true, null);
    vq.pushAvail(head);
    return addr;
  }
  function rdata(addr, len) {
    return new Uint8Array(memory.buffer, addr, len);
  }
  return { ...ctx, vq, postInbuf, rdata };
}

describe("ConsoleVirtioDevice", () => {
  it("advertises no optional console features (single port, no size)", () => {
    const { dev } = makeDev();
    expect(dev.getFeatures()).toBe(0n);
  });

  it("drains the transmitq to the sink and pushes each chain used (len 0)", () => {
    const seen = [];
    const { dev, submit, vq, irqs } = makeTxRing({ sink: (b) => seen.push(Array.from(b)) });
    submit(new Uint8Array([0x68, 0x69]), 0); // "hi"
    submit(new Uint8Array([0x21]), 1); // "!"
    dev.onNotify(TRANSMITQ);
    expect(seen).toEqual([[0x68, 0x69], [0x21]]);
    expect(vq.usedIdx()).toBe(2);
    expect(vq.usedElem(0)).toEqual({ id: 0, len: 0 }); // transmit buffers are read-only
    expect(vq.usedElem(1)).toEqual({ id: 1, len: 0 });
    expect(irqs.length).toBe(1); // one IRQ for the drain
    expect(irqs[0]).toEqual([0, 14]); // (cpu0, irq 14)
  });

  it("delivers host input into a posted receiveq inbuf and raises the IRQ", () => {
    const { dev, postInbuf, rdata, vq, irqs } = makeRxRing();
    const addr = postInbuf(0);
    dev.pushRx(new Uint8Array([0x41, 0x42, 0x43])); // "ABC"
    expect(Array.from(rdata(addr, 3))).toEqual([0x41, 0x42, 0x43]);
    expect(vq.usedIdx()).toBe(1);
    expect(vq.usedElem(0)).toEqual({ id: 0, len: 3 });
    expect(irqs.length).toBe(1);
    expect(irqs[0]).toEqual([0, 14]);
  });

  it("keeps input pending when no inbuf is posted, then flushes on refill", () => {
    const { dev, postInbuf, rdata, vq, irqs } = makeRxRing();
    // No inbuf yet — input must NOT be lost, no IRQ raised.
    dev.pushRx(new Uint8Array([0x78, 0x79])); // "xy"
    expect(vq.usedIdx()).toBe(0);
    expect(irqs.length).toBe(0);
    // Guest posts an inbuf and kicks the receiveq → pending bytes flush.
    const addr = postInbuf(0);
    dev.onNotify(RECEIVEQ);
    expect(Array.from(rdata(addr, 2))).toEqual([0x78, 0x79]);
    expect(vq.usedIdx()).toBe(1);
    expect(irqs.length).toBe(1);
  });

  it("spreads input across multiple inbufs when one is too small (byte stream)", () => {
    const { dev, postInbuf, rdata, vq } = makeRxRing();
    const a0 = postInbuf(0, 2); // capacity 2
    const a1 = postInbuf(1, 4); // capacity 4
    dev.pushRx(new Uint8Array([1, 2, 3, 4, 5])); // 5 bytes > first inbuf
    expect(Array.from(rdata(a0, 2))).toEqual([1, 2]);
    expect(Array.from(rdata(a1, 3))).toEqual([3, 4, 5]);
    expect(vq.usedIdx()).toBe(2);
    expect(vq.usedElem(0).len).toBe(2);
    expect(vq.usedElem(1).len).toBe(3);
  });

  it("forwards the kick instead of servicing when forwardNotify is set (worker mode)", () => {
    const fwd = [];
    const { dev } = makeDev({ forwardNotify: (d, q) => fwd.push([d, q]) });
    dev.onNotify(TRANSMITQ);
    dev.onNotify(RECEIVEQ);
    expect(fwd).toEqual([
      [6, 1],
      [6, 0],
    ]);
  });

  it("re-entrant onNotify(transmitq) drains chains that arrive between kicks", () => {
    const seen = [];
    const { dev, submit, vq } = makeTxRing({ sink: (b) => seen.push(Array.from(b)) });
    submit(new Uint8Array([0xaa]), 0);
    dev.onNotify(TRANSMITQ);
    // A new chain arrives after the first drain — a second kick services it.
    submit(new Uint8Array([0xbb]), 1);
    dev.onNotify(TRANSMITQ);
    expect(seen).toEqual([[0xaa], [0xbb]]);
    expect(vq.usedIdx()).toBe(2);
  });

  it("no-ops a transmitq kick before queue setup (no sink call, no IRQ)", () => {
    const seen = [];
    const { dev, irqs } = makeDev({ sink: (b) => seen.push(Array.from(b)) });
    dev.onNotify(TRANSMITQ); // receiveq/transmitq never set up
    expect(seen).toEqual([]);
    expect(irqs.length).toBe(0);
  });
});
