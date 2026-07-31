import { describe, it, expect } from "bun:test";
import { BlkDevice } from "./blk-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";
import { BLK_SECTOR, dirtyBitmapBytes, dirtySectorCount } from "./blk-disk.js";

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
  };
}

function makeBlk(image, opts = {}) {
  const memory = { buffer: new ArrayBuffer(64 * 1024) };
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dirtyCalls = [];
  const dev = new BlkDevice({
    dev: 3,
    irq: 11,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    image,
    readOnly: opts.readOnly,
    dirtyBitmap: opts.dirtyBitmap,
    onDirty: () => dirtyCalls.push(1),
    forwardNotify: opts.forwardNotify,
  });
  return { dev, memory, shared, irqs, dirtyCalls };
}

function makeBlkWithRing(image, opts = {}) {
  const { dev, memory, irqs, dirtyCalls } = makeBlk(image, opts);
  const dv = new DataView(memory.buffer);

  const vq = makeVq(memory, 0x1000, 8);
  dev.setupQueue(0, vq.desc, vq.avail, vq.used, vq.num);

  const HDR_ADDR = 0x4000;
  const DATA_ADDR = 0x4020;
  const DATA_LEN = 512;
  const STAT_ADDR = 0x4300;

  function readSector(sector) {
    dv.setUint32(HDR_ADDR, 0, true); // T_IN
    dv.setUint32(HDR_ADDR + 4, 0, true);
    dv.setBigUint64(HDR_ADDR + 8, BigInt(sector), true);
    new Uint8Array(memory.buffer, DATA_ADDR, DATA_LEN).fill(0);
    dv.setUint8(STAT_ADDR, 0xff);
    vq.setDesc(0, HDR_ADDR, 16, false, 1);
    vq.setDesc(1, DATA_ADDR, DATA_LEN, true, 2);
    vq.setDesc(2, STAT_ADDR, 1, true, null);
    vq.pushAvail(0);
    dev.onNotify(0);
    return {
      status: STAT_ADDR,
      data: new Uint8Array(memory.buffer, DATA_ADDR, DATA_LEN),
    };
  }

  function writeSector(sector, bytes) {
    dv.setUint32(HDR_ADDR, 1, true); // T_OUT
    dv.setUint32(HDR_ADDR + 4, 0, true);
    dv.setBigUint64(HDR_ADDR + 8, BigInt(sector), true);
    new Uint8Array(memory.buffer, DATA_ADDR, DATA_LEN).set(bytes.subarray(0, DATA_LEN));
    dv.setUint8(STAT_ADDR, 0xff);
    // OUT: header + data; IN: status
    vq.setDesc(0, HDR_ADDR, 16, false, 1);
    vq.setDesc(1, DATA_ADDR, DATA_LEN, false, 2);
    vq.setDesc(2, STAT_ADDR, 1, true, null);
    vq.pushAvail(0);
    dev.onNotify(0);
    return { status: STAT_ADDR };
  }

  function statusOf(addr) {
    return dv.getUint8(addr);
  }

  return { dev, readSector, writeSector, statusOf, irqCount: () => irqs.length, dirtyCalls };
}

describe("BlkDevice", () => {
  it("reports capacity in 512-byte sectors via config space", () => {
    const image = new Uint8Array(512 * 4);
    const { dev } = makeBlk(image);
    const cfg = new Uint8Array(8);
    dev.configRead(0, cfg);
    const capacity = new DataView(cfg.buffer).getBigUint64(0, true);
    expect(capacity).toBe(4n);
  });

  it("advertises F_RO when read-only", () => {
    const { dev } = makeBlk(new Uint8Array(512));
    expect((dev.getFeatures() >> 5n) & 1n).toBe(1n);
  });

  it("omits F_RO when writable", () => {
    const { dev } = makeBlk(new Uint8Array(512), { readOnly: false });
    expect((dev.getFeatures() >> 5n) & 1n).toBe(0n);
  });

  it("serves a VIRTIO_BLK_T_IN read from the image", () => {
    const image = new Uint8Array(512 * 2);
    image[512] = 0xab;
    const { readSector, statusOf } = makeBlkWithRing(image);
    const { status, data } = readSector(1);
    expect(statusOf(status)).toBe(0);
    expect(data[0]).toBe(0xab);
  });

  it("fails a read past end-of-image with S_IOERR", () => {
    const image = new Uint8Array(512 * 1);
    const { readSector, statusOf, irqCount } = makeBlkWithRing(image);
    const { status } = readSector(99);
    expect(statusOf(status)).toBe(1);
    expect(irqCount()).toBeGreaterThan(0);
  });

  it("rejects T_OUT on a read-only device with S_UNSUPP", () => {
    const image = new Uint8Array(512 * 2);
    const { writeSector, statusOf } = makeBlkWithRing(image);
    const payload = new Uint8Array(BLK_SECTOR);
    payload[0] = 0x11;
    const { status } = writeSector(0, payload);
    expect(statusOf(status)).toBe(2);
    expect(image[0]).toBe(0);
  });

  it("accepts T_OUT on a writable device and journals dirty sectors", () => {
    const image = new Uint8Array(512 * 2);
    const dirtyBitmap = new Uint8Array(dirtyBitmapBytes(image.length));
    const { writeSector, readSector, statusOf, dirtyCalls } = makeBlkWithRing(image, {
      readOnly: false,
      dirtyBitmap,
    });
    const payload = new Uint8Array(BLK_SECTOR);
    payload[0] = 0xef;
    const { status } = writeSector(1, payload);
    expect(statusOf(status)).toBe(0);
    expect(image[512]).toBe(0xef);
    expect(dirtySectorCount(dirtyBitmap)).toBe(1);
    expect(dirtyCalls.length).toBe(1);

    const { data } = readSector(1);
    expect(data[0]).toBe(0xef);
  });

  it("forwards the kick instead of servicing when forwardNotify is set", () => {
    const image = new Uint8Array(BLK_SECTOR);
    const forwarded = [];
    const { writeSector, statusOf } = makeBlkWithRing(image, {
      readOnly: false,
      forwardNotify: (d, q) => forwarded.push([d, q]),
    });
    const payload = new Uint8Array(BLK_SECTOR);
    payload[0] = 0x42;
    const { status } = writeSector(0, payload);
    expect(forwarded).toEqual([[3, 0]]);
    expect(image[0]).toBe(0);
    expect(statusOf(status)).toBe(0xff); // status slot untouched — not serviced here
  });
});
