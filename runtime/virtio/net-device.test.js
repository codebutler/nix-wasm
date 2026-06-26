import { test, expect } from "bun:test";
import { NetDevice, VIRTIO_NET_HDR_LEN } from "./net-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

// Minimal split-vring builder in a flat memory, returning offsets + helpers.
function makeVq(memory, base, num) {
  const dv = new DataView(memory.buffer);
  const desc = base,
    avail = base + num * 16,
    used = avail + 4 + num * 2 + 2;
  return {
    desc,
    avail,
    used,
    num,
    // describe one buffer at `addr` of `len`, writable if `write`.
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

function mkDevice() {
  const memory = { buffer: new ArrayBuffer(64 * 1024) };
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const d = new NetDevice({
    dev: 2,
    irq: 10,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    mac: [0x52, 0x54, 0x00, 0xcb, 0x00, 0x02],
  });
  return { memory, d, irqs, makeVq };
}

test("getFeatures advertises MAC + STATUS", () => {
  const { d } = mkDevice();
  expect(d.getFeatures()).toBe((1n << 5n) | (1n << 16n));
});

test("configRead returns the MAC at offset 0", () => {
  const { d } = mkDevice();
  const out = new Uint8Array(6);
  d.configRead(0, out);
  expect([...out]).toEqual([0x52, 0x54, 0x00, 0xcb, 0x00, 0x02]);
});

test("TX strips the virtio-net header and emits the ethernet frame", () => {
  const { memory, d } = mkDevice();
  const frames = [];
  d.setFrameSink((f) => frames.push(Uint8Array.from(f)));
  // TX queue = 1. Lay a single OUT descriptor: [hdr(12)][frame(4)].
  const vq = makeVq(memory, 0x1000, 8);
  const payloadAt = 0x4000;
  const dv = new DataView(memory.buffer);
  for (let i = 0; i < VIRTIO_NET_HDR_LEN; i++) dv.setUint8(payloadAt + i, 0);
  [0xde, 0xad, 0xbe, 0xef].forEach((b, i) => dv.setUint8(payloadAt + VIRTIO_NET_HDR_LEN + i, b));
  vq.setDesc(0, payloadAt, VIRTIO_NET_HDR_LEN + 4, false, null);
  vq.pushAvail(0);
  d.setupQueue(1, vq.desc, vq.avail, vq.used, vq.num);
  d.onNotify(1);
  expect(frames.length).toBe(1);
  expect([...frames[0]]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  expect(vq.usedIdx()).toBe(1);
});

test("pushRx writes header+frame into an RX buffer and raises IRQ", () => {
  const { memory, d, irqs } = mkDevice();
  const vq = makeVq(memory, 0x1000, 8);
  vq.setDesc(0, 0x4000, 2048, true, null); // one writable RX buffer
  vq.pushAvail(0);
  d.setupQueue(0, vq.desc, vq.avail, vq.used, vq.num);
  const frame = Uint8Array.from([0x01, 0x02, 0x03]);
  expect(d.pushRx(frame)).toBe(true);
  expect(vq.usedIdx()).toBe(1);
  const { len } = vq.usedElem(0);
  expect(len).toBe(VIRTIO_NET_HDR_LEN + 3);
  const dv = new DataView(memory.buffer);
  expect([
    dv.getUint8(0x4000 + VIRTIO_NET_HDR_LEN),
    dv.getUint8(0x4000 + VIRTIO_NET_HDR_LEN + 1),
    dv.getUint8(0x4000 + VIRTIO_NET_HDR_LEN + 2),
  ]).toEqual([1, 2, 3]);
  expect(irqs).toEqual([[0, 10]]);
});

test("pushRx returns false when no RX buffer is available", () => {
  const { memory, d } = mkDevice();
  const vq = makeVq(memory, 0x1000, 8);
  d.setupQueue(0, vq.desc, vq.avail, vq.used, vq.num); // no avail buffers
  expect(d.pushRx(Uint8Array.from([1, 2, 3]))).toBe(false);
});
