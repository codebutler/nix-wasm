import { describe, it, expect } from "bun:test";
import { BlkDevice } from "./blk-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

// Minimal split-vring builder in flat memory, mirrored from net-device.test.js.
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

function makeBlk(image) {
  const memory = { buffer: new ArrayBuffer(64 * 1024) };
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dev = new BlkDevice({
    dev: 3,
    irq: 11,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    image,
  });
  return { dev, memory, shared, irqs };
}

// Build a complete virtio-blk request: [outhdr desc0][data desc1][status desc2],
// push it on the avail ring, call onNotify(0), and return helpers.
//
// virtio-blk outhdr: struct { le32 type; le32 reserved; le64 sector; } (16 bytes)
// desc 0 = OUT (host reads header) — NOT VRING_DESC_F_WRITE
// desc 1 = IN  (host writes data) — VRING_DESC_F_WRITE
// desc 2 = IN  (host writes status byte) — VRING_DESC_F_WRITE
function makeBlkWithRing(image) {
  const { dev, memory, irqs } = makeBlk(image);
  const dv = new DataView(memory.buffer);

  // Layout: vq at 0x1000 (8 entries), buffers above 0x4000
  const vq = makeVq(memory, 0x1000, 8);
  dev.setupQueue(0, vq.desc, vq.avail, vq.used, vq.num);

  // Buffer regions (no overlap)
  const HDR_ADDR = 0x4000; // 16 bytes: outhdr
  const DATA_ADDR = 0x4020; // 512 bytes: sector data
  const DATA_LEN = 512;
  const STAT_ADDR = 0x4300; // 1 byte: status

  function readSector(sector) {
    // Write the outhdr: type=0 (IN=read), reserved=0, sector
    dv.setUint32(HDR_ADDR, 0, true); // VIRTIO_BLK_T_IN
    dv.setUint32(HDR_ADDR + 4, 0, true); // reserved
    dv.setBigUint64(HDR_ADDR + 8, BigInt(sector), true);

    // Clear data + status buffers so we can detect writes
    new Uint8Array(memory.buffer, DATA_ADDR, DATA_LEN).fill(0);
    dv.setUint8(STAT_ADDR, 0xff);

    // desc 0: outhdr (OUT — host reads, no WRITE flag)
    vq.setDesc(0, HDR_ADDR, 16, false, 1);
    // desc 1: data (IN — host writes, WRITE flag)
    vq.setDesc(1, DATA_ADDR, DATA_LEN, true, 2);
    // desc 2: status (IN — host writes, WRITE flag, no next)
    vq.setDesc(2, STAT_ADDR, 1, true, null);
    vq.pushAvail(0);

    dev.onNotify(0);

    return {
      status: STAT_ADDR,
      data: new Uint8Array(memory.buffer, DATA_ADDR, DATA_LEN),
    };
  }

  function statusOf(addr) {
    return dv.getUint8(addr);
  }

  function irqCount() {
    return irqs.length;
  }

  return { dev, readSector, statusOf, irqCount };
}

describe("BlkDevice", () => {
  it("reports capacity in 512-byte sectors via config space", () => {
    const image = new Uint8Array(512 * 4); // 4 sectors
    const { dev } = makeBlk(image);
    const cfg = new Uint8Array(8);
    dev.configRead(0, cfg);
    const capacity = new DataView(cfg.buffer).getBigUint64(0, true);
    expect(capacity).toBe(4n);
  });

  it("serves a VIRTIO_BLK_T_IN read from the image", () => {
    const image = new Uint8Array(512 * 2);
    image[512] = 0xab; // first byte of sector 1
    const { readSector, statusOf } = makeBlkWithRing(image);
    const { status, data } = readSector(1);
    expect(statusOf(status)).toBe(0); // VIRTIO_BLK_S_OK
    expect(data[0]).toBe(0xab);
  });

  it("fails a read past end-of-image with S_IOERR", () => {
    const image = new Uint8Array(512 * 1);
    const { readSector, statusOf, irqCount } = makeBlkWithRing(image);
    const { status } = readSector(99);
    expect(statusOf(status)).toBe(1); // VIRTIO_BLK_S_IOERR
    expect(irqCount()).toBeGreaterThan(0);
  });
});
