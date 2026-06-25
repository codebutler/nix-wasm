import { describe, it, expect } from "bun:test";
import { NinePVirtioDevice } from "./ninep-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

// Minimal split-vring builder in flat memory (mirrored from blk-device.test.js).
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

function makeDev({ tag = "pcroot", cid = 1, server, forwardNotify } = {}) {
  const memory = { buffer: new ArrayBuffer(64 * 1024) };
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dev = new NinePVirtioDevice({
    dev: 4,
    irq: 12,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    tag,
    cid,
    server,
    forwardNotify,
  });
  return { dev, memory, shared, irqs };
}

// Build a 9P "requests" chain: desc0 = OUT (T-message bytes), desc1 = IN (space
// for the R-message). Push it on the avail ring and return read helpers.
function makeDevWithRing(opts) {
  const ctx = makeDev(opts);
  const { dev, memory, irqs } = ctx;
  const dv = new DataView(memory.buffer);
  const vq = makeVq(memory, 0x1000, 8);
  dev.setupQueue(0, vq.desc, vq.avail, vq.used, vq.num);

  const T_ADDR = 0x4000; // T-message (out)
  const R_ADDR = 0x5000; // R-message buffer (in)
  const R_CAP = 0x800;

  function submit(tBytes, head = 0) {
    new Uint8Array(memory.buffer, T_ADDR, tBytes.length).set(tBytes);
    new Uint8Array(memory.buffer, R_ADDR, R_CAP).fill(0);
    vq.setDesc(head, T_ADDR, tBytes.length, false, head + 1);
    vq.setDesc(head + 1, R_ADDR, R_CAP, true, null);
    vq.pushAvail(head);
  }

  function rmsg(len) {
    return new Uint8Array(memory.buffer, R_ADDR, len);
  }

  return { ...ctx, dev, vq, submit, rmsg, irqs, dv };
}

describe("NinePVirtioDevice", () => {
  it("advertises VIRTIO_9P_MOUNT_TAG and VIRTIO_F_VERSION_1", () => {
    const { dev } = makeDev();
    const f = dev.getFeatures();
    expect(f & 1n).toBe(1n); // VIRTIO_9P_MOUNT_TAG (bit 0)
    expect((f >> 32n) & 1n).toBe(1n); // VIRTIO_F_VERSION_1 (bit 32)
  });

  it("serves the mount tag in config space (le16 tag_len + tag bytes)", () => {
    const { dev } = makeDev({ tag: "nixcache" });
    const cfg = new Uint8Array(2 + 8);
    dev.configRead(0, cfg);
    const tagLen = new DataView(cfg.buffer).getUint16(0, true);
    expect(tagLen).toBe(8);
    expect(new TextDecoder().decode(cfg.subarray(2, 2 + tagLen))).toBe("nixcache");
  });

  it("zero-pads config reads past the end of the tag", () => {
    const { dev } = makeDev({ tag: "x" });
    const cfg = new Uint8Array(8).fill(0xee);
    dev.configRead(0, cfg);
    // [len_lo, len_hi, 'x', 0, 0, 0, 0, 0]
    expect(Array.from(cfg)).toEqual([1, 0, 0x78, 0, 0, 0, 0, 0]);
  });

  it("runs a T-message through the server, writes the reply, raises the IRQ", async () => {
    const seen = [];
    const reply = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const server = {
      handle(bytes, cid) {
        seen.push({ bytes: Array.from(bytes), cid });
        return reply;
      },
    };
    const { dev, submit, rmsg, vq, irqs } = makeDevWithRing({ cid: 7, server });
    submit(new Uint8Array([1, 2, 3]));
    await dev.service(0);

    // The server saw the exact T-message bytes + this device's cid.
    expect(seen).toEqual([{ bytes: [1, 2, 3], cid: 7 }]);
    // The R-message was written into the in segment and the chain pushed used.
    expect(Array.from(rmsg(4))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(vq.usedIdx()).toBe(1);
    expect(vq.usedElem(0)).toEqual({ id: 0, len: 4 });
    expect(irqs.length).toBe(1);
    expect(irqs[0]).toEqual([0, 12]); // (cpu0, irq 12)
  });

  it("services multiple in-flight chains concurrently (async server)", async () => {
    const server = {
      async handle(bytes) {
        await Promise.resolve();
        return new Uint8Array([bytes[0] ^ 0xff]);
      },
    };
    const { dev, submit, vq } = makeDevWithRing({ server });
    submit(new Uint8Array([0x01]), 0);
    submit(new Uint8Array([0x02]), 2);
    await dev.service(0);
    expect(vq.usedIdx()).toBe(2);
  });

  it("forwards the kick instead of servicing when forwardNotify is set (worker mode)", () => {
    const fwd = [];
    const { dev } = makeDev({ forwardNotify: (d, q) => fwd.push([d, q]) });
    dev.onNotify(0);
    expect(fwd).toEqual([[4, 0]]);
  });

  it("completes a chain (0-length) when the server throws, so the guest doesn't hang", async () => {
    const server = {
      handle() {
        throw new Error("boom");
      },
    };
    const { dev, submit, vq, irqs } = makeDevWithRing({ server });
    submit(new Uint8Array([9]));
    await dev.service(0);
    expect(vq.usedIdx()).toBe(1);
    expect(vq.usedElem(0).len).toBe(0);
    expect(irqs.length).toBe(1);
  });
});
