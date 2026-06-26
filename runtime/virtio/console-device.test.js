import { describe, it, expect } from "bun:test";
import { ConsoleVirtioDevice, CONSOLE_PORTS } from "./console-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

// virtio-console multiport queue layout (mirrors console-device.js):
//   port 0: rx=0 tx=1 ; control rx=2 tx=3 ; port i≥1: rx=2+2i tx=3+2i.
const CONTROL_RX = 2; // host -> guest control
const CONTROL_TX = 3; // guest -> host control
const portRx = (i) => (i === 0 ? 0 : 2 + 2 * i);
const portTx = (i) => (i === 0 ? 1 : 3 + 2 * i);

// virtio_console_control events.
const DEVICE_READY = 0;
const PORT_ADD = 1;
const PORT_READY = 3;
const CONSOLE_PORT = 4;
const RESIZE = 5;
const PORT_OPEN = 6;

// Minimal split-vring builder in flat memory (mirrored from ninep-device.test.js).
// Each queue gets its own ring region + data region so multiple queues coexist.
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

// A multiport console rig: a device + a per-queue vq factory with separate ring
// and data regions, so the handshake + several ports can be exercised at once.
function makeRig({ ports = 4, sink, forwardNotify } = {}) {
  const memory = { buffer: new ArrayBuffer(1 << 20) };
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dev = new ConsoleVirtioDevice({
    dev: 6,
    irq: 14,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    ports,
    sink,
    forwardNotify,
  });
  const vqs = new Map();
  // Lay each queue's ring at 0x1000*q+0x1000 and its data area at 0x40000+0x2000*q.
  function vq(q, num = 8) {
    if (vqs.has(q)) return vqs.get(q);
    const v = makeVq(memory, 0x1000 + q * 0x1000, num);
    dev.setupQueue(q, v.desc, v.avail, v.used, v.num);
    const dataBase = 0x40000 + q * 0x2000;
    let head = 0;
    const obj = {
      ...v,
      // Post a writable inbuf (host -> guest); returns its addr.
      postInbuf(cap = 0x200) {
        const h = head++;
        const addr = dataBase + h * cap;
        new Uint8Array(memory.buffer, addr, cap).fill(0);
        v.setDesc(h, addr, cap, true, null);
        v.pushAvail(h);
        return { head: h, addr };
      },
      // Submit a readable outbuf (guest -> host) holding `bytes`.
      submitOut(bytes) {
        const h = head++;
        const addr = dataBase + h * 0x200;
        new Uint8Array(memory.buffer, addr, bytes.length).set(bytes);
        v.setDesc(h, addr, bytes.length, false, null);
        v.pushAvail(h);
        return h;
      },
      read(addr, len) {
        return Array.from(new Uint8Array(memory.buffer, addr, len));
      },
    };
    vqs.set(q, obj);
    return obj;
  }
  return { dev, memory, shared, irqs, vq };
}

// Encode a guest->host control message (id, event, value) into a port's queue.
function ctrl(id, event, value) {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, id >>> 0, true);
  dv.setUint16(4, event, true);
  dv.setUint16(6, value & 0xffff, true);
  return b;
}

// Decode a host->guest control message written into a control-rx inbuf.
function decodeCtrl(bytes) {
  const dv = new DataView(new Uint8Array(bytes).buffer);
  return { id: dv.getUint32(0, true), event: dv.getUint16(4, true), value: dv.getUint16(6, true) };
}

describe("ConsoleVirtioDevice (multiport)", () => {
  it("advertises VIRTIO_CONSOLE_F_MULTIPORT", () => {
    const { dev } = makeRig();
    expect(dev.getFeatures()).toBe(1n << 1n);
  });

  it("reports max_nr_ports in config space", () => {
    const { dev } = makeRig({ ports: 4 });
    const cfg = new Uint8Array(12);
    dev.configRead(0, cfg);
    // cols(0,2)=0, rows(2,2)=0, max_nr_ports(4,4)=4, emerg_wr(8,4)=0.
    expect(new DataView(cfg.buffer).getUint32(4, true)).toBe(4);
    // A windowed read at the max_nr_ports offset works too.
    const win = new Uint8Array(4);
    dev.configRead(4, win);
    expect(new DataView(win.buffer).getUint32(0, true)).toBe(4);
  });

  it("default port count is CONSOLE_PORTS", () => {
    const memory = { buffer: new ArrayBuffer(1024) };
    const dev = new ConsoleVirtioDevice({
      dev: 6,
      irq: 14,
      memory,
      raiseInterrupt: () => {},
      sharedQueues: new SharedQueues(makeSharedQueues()),
    });
    expect(dev.nrPorts).toBe(CONSOLE_PORTS);
  });

  it("on DEVICE_READY, adds every port (PORT_ADD) in port order", () => {
    const { dev, vq, irqs } = makeRig({ ports: 3 });
    const crx = vq(CONTROL_RX);
    const ctx = vq(CONTROL_TX);
    // Guest posts control inbufs so the host can deliver PORT_ADDs.
    const adds = [crx.postInbuf(), crx.postInbuf(), crx.postInbuf()];
    // Guest sends DEVICE_READY.
    ctx.submitOut(ctrl(0xffffffff, DEVICE_READY, 1));
    dev.onNotify(CONTROL_TX);
    const got = adds.map((b) => decodeCtrl(crx.read(b.addr, 8)));
    expect(got).toEqual([
      { id: 0, event: PORT_ADD, value: 1 },
      { id: 1, event: PORT_ADD, value: 1 },
      { id: 2, event: PORT_ADD, value: 1 },
    ]);
    expect(crx.usedIdx()).toBe(3);
    expect(irqs.length).toBeGreaterThanOrEqual(1);
    expect(irqs[0]).toEqual([0, 14]);
  });

  it("on PORT_READY, marks the port a console and opens it (CONSOLE_PORT, PORT_OPEN)", () => {
    const { dev, vq } = makeRig({ ports: 2 });
    const crx = vq(CONTROL_RX);
    const ctx = vq(CONTROL_TX);
    const a = crx.postInbuf();
    const b = crx.postInbuf();
    ctx.submitOut(ctrl(1, PORT_READY, 1));
    dev.onNotify(CONTROL_TX);
    expect(decodeCtrl(crx.read(a.addr, 8))).toEqual({ id: 1, event: CONSOLE_PORT, value: 1 });
    expect(decodeCtrl(crx.read(b.addr, 8))).toEqual({ id: 1, event: PORT_OPEN, value: 1 });
  });

  it("queues control messages when no inbuf is posted, flushes on refill", () => {
    const { dev, vq, irqs } = makeRig({ ports: 2 });
    const crx = vq(CONTROL_RX);
    const ctx = vq(CONTROL_TX);
    // No control inbufs yet — DEVICE_READY must not be lost, no delivery.
    ctx.submitOut(ctrl(0xffffffff, DEVICE_READY, 1));
    dev.onNotify(CONTROL_TX);
    expect(crx.usedIdx()).toBe(0);
    const before = irqs.length;
    // Guest posts inbufs and kicks the control receiveq → pending PORT_ADDs flush.
    const a = crx.postInbuf();
    const b = crx.postInbuf();
    dev.onNotify(CONTROL_RX);
    expect(decodeCtrl(crx.read(a.addr, 8))).toEqual({ id: 0, event: PORT_ADD, value: 1 });
    expect(decodeCtrl(crx.read(b.addr, 8))).toEqual({ id: 1, event: PORT_ADD, value: 1 });
    expect(irqs.length).toBeGreaterThan(before);
  });

  it("drains a port's transmitq to the sink tagged with the port index", () => {
    const seen = [];
    const { dev, vq } = makeRig({ ports: 3, sink: (p, b) => seen.push([p, Array.from(b)]) });
    const tx0 = vq(portTx(0)); // q1
    const tx2 = vq(portTx(2)); // q7
    tx0.submitOut(new Uint8Array([0x68, 0x69])); // "hi" on port 0
    tx2.submitOut(new Uint8Array([0x7a])); // "z" on port 2
    dev.onNotify(portTx(0));
    dev.onNotify(portTx(2));
    expect(seen).toEqual([
      [0, [0x68, 0x69]],
      [2, [0x7a]],
    ]);
  });

  it("delivers host input into a port's receiveq inbuf (per-port isolation)", () => {
    const { dev, vq, irqs } = makeRig({ ports: 3 });
    const rx1 = vq(portRx(1)); // q4
    const buf = rx1.postInbuf();
    dev.pushRx(1, new Uint8Array([0x41, 0x42, 0x43])); // "ABC" to port 1
    expect(rx1.read(buf.addr, 3)).toEqual([0x41, 0x42, 0x43]);
    expect(rx1.usedElem(0)).toEqual({ id: buf.head, len: 3 });
    expect(irqs.at(-1)).toEqual([0, 14]);
  });

  it("keeps per-port input pending until that port posts an inbuf", () => {
    const { dev, vq } = makeRig({ ports: 2 });
    const rx1 = vq(portRx(1));
    dev.pushRx(1, new Uint8Array([0x78, 0x79])); // no inbuf yet
    expect(rx1.usedIdx()).toBe(0);
    const buf = rx1.postInbuf();
    dev.onNotify(portRx(1));
    expect(rx1.read(buf.addr, 2)).toEqual([0x78, 0x79]);
    expect(rx1.usedIdx()).toBe(1);
  });

  it("resize sends a RESIZE control message with cols then rows", () => {
    const { dev, vq } = makeRig({ ports: 2 });
    const crx = vq(CONTROL_RX);
    const buf = crx.postInbuf();
    dev.resize(1, 80, 24);
    const bytes = new Uint8Array(crx.read(buf.addr, 12));
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(1); // port id
    expect(dv.getUint16(4, true)).toBe(RESIZE);
    expect(dv.getUint16(8, true)).toBe(80); // cols first
    expect(dv.getUint16(10, true)).toBe(24); // rows second
  });

  it("re-asserts a pending resize on PORT_READY (resize before the console is up)", () => {
    const { dev, vq } = makeRig({ ports: 2 });
    const crx = vq(CONTROL_RX);
    const ctx = vq(CONTROL_TX);
    // Resize port 1 before any inbuf exists — queued, not delivered.
    dev.resize(1, 100, 40);
    // Now the guest readies port 1; CONSOLE_PORT + PORT_OPEN + the resize flush.
    const b0 = crx.postInbuf();
    const b1 = crx.postInbuf();
    const b2 = crx.postInbuf();
    const b3 = crx.postInbuf();
    ctx.submitOut(ctrl(1, PORT_READY, 1));
    dev.onNotify(CONTROL_TX);
    // First the queued resize (from before), then CONSOLE_PORT, PORT_OPEN, resize.
    const msgs = [b0, b1, b2, b3].map((b) => decodeCtrl(crx.read(b.addr, 8)));
    const events = msgs.map((m) => m.event);
    expect(events).toContain(CONSOLE_PORT);
    expect(events).toContain(PORT_OPEN);
    expect(events.filter((e) => e === RESIZE).length).toBe(2); // pre-queued + PORT_READY re-assert
  });

  it("forwards the kick instead of servicing when forwardNotify is set (worker mode)", () => {
    const fwd = [];
    const { dev } = makeRig({ forwardNotify: (d, q) => fwd.push([d, q]) });
    dev.onNotify(CONTROL_TX);
    dev.onNotify(portTx(0));
    dev.onNotify(portRx(1));
    expect(fwd).toEqual([
      [6, CONTROL_TX],
      [6, portTx(0)],
      [6, portRx(1)],
    ]);
  });

  it("no-ops a transmitq kick before queue setup (no sink, no IRQ)", () => {
    const seen = [];
    const { dev, irqs } = makeRig({ sink: (p, b) => seen.push([p, Array.from(b)]) });
    dev.onNotify(portTx(0)); // never set up
    expect(seen).toEqual([]);
    expect(irqs.length).toBe(0);
  });
});
