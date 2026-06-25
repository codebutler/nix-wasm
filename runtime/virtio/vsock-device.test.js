import { describe, it, expect } from "bun:test";
import {
  VsockVirtioDevice,
  VSOCK_HDR_LEN,
  VSOCK_GUEST_CID,
  VMADDR_CID_HOST,
  VIRTIO_VSOCK_TYPE_STREAM,
  VIRTIO_VSOCK_OP_REQUEST,
  VIRTIO_VSOCK_OP_RESPONSE,
  VIRTIO_VSOCK_OP_RST,
  VIRTIO_VSOCK_OP_RW,
  VIRTIO_VSOCK_OP_CREDIT_UPDATE,
  VIRTIO_VSOCK_OP_SHUTDOWN,
  VIRTIO_VSOCK_SHUTDOWN_RCV,
  VIRTIO_VSOCK_SHUTDOWN_SEND,
} from "./vsock-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

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

/**
 * @param {{ srcCid?: number, dstCid?: number, srcPort: number, dstPort: number, len?: number, op: number, flags?: number, bufAlloc?: number, fwdCnt?: number }} h
 */
function encodeHdr({ srcCid, dstCid, srcPort, dstPort, len = 0, op, flags, bufAlloc, fwdCnt }) {
  const pkt = new Uint8Array(VSOCK_HDR_LEN);
  const dv = new DataView(pkt.buffer);
  dv.setBigUint64(0, BigInt(srcCid ?? VSOCK_GUEST_CID), true);
  dv.setBigUint64(8, BigInt(dstCid ?? VMADDR_CID_HOST), true);
  dv.setUint32(16, srcPort >>> 0, true);
  dv.setUint32(20, dstPort >>> 0, true);
  dv.setUint32(24, len >>> 0, true);
  dv.setUint16(28, VIRTIO_VSOCK_TYPE_STREAM, true);
  dv.setUint16(30, op, true);
  dv.setUint32(32, (flags || 0) >>> 0, true);
  dv.setUint32(36, (bufAlloc ?? 65536) >>> 0, true);
  dv.setUint32(40, (fwdCnt ?? 0) >>> 0, true);
  return pkt;
}

function decodeHdr(bytes, off = 0) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    srcCid: dv.getBigUint64(off + 0, true),
    dstCid: dv.getBigUint64(off + 8, true),
    srcPort: dv.getUint32(off + 16, true),
    dstPort: dv.getUint32(off + 20, true),
    len: dv.getUint32(off + 24, true),
    type: dv.getUint16(off + 28, true),
    op: dv.getUint16(off + 30, true),
    flags: dv.getUint32(off + 32, true),
    bufAlloc: dv.getUint32(off + 36, true),
    fwdCnt: dv.getUint32(off + 40, true),
  };
}

/**
 * @param {{ guestCid?: number, forwardNotify?: (dev: number, q: number) => void }} [opts]
 */
function makeDev({ guestCid, forwardNotify } = {}) {
  const memory = /** @type {any} */ ({ buffer: new ArrayBuffer(128 * 1024) });
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dev = new VsockVirtioDevice({
    dev: 7,
    irq: 15,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    guestCid,
    forwardNotify,
  });
  return { dev, memory, shared, irqs };
}

// Build the three vsock vqs (rx=0, tx=1, event=2). The TX queue carries
// guest→host packets (one OUT desc per chain); the RX queue carries host→guest
// packets (one IN desc per chain, space the host fills).
function makeDevWithVqs(opts) {
  const ctx = makeDev(opts);
  const { dev, memory } = ctx;

  const RX = makeVq(memory, 0x1000, 8);
  const TX = makeVq(memory, 0x3000, 8);
  const EV = makeVq(memory, 0x5000, 8);
  dev.setupQueue(0, RX.desc, RX.avail, RX.used, RX.num);
  dev.setupQueue(1, TX.desc, TX.avail, TX.used, TX.num);
  dev.setupQueue(2, EV.desc, EV.avail, EV.used, EV.num);

  // TX OUT buffers: guest posts a packet at TX_BUF[head].
  const TX_BASE = 0x8000;
  const TX_STRIDE = 0x400;
  let txHead = 0;
  function submitTx(pktBytes) {
    const head = txHead++;
    const addr = TX_BASE + head * TX_STRIDE;
    new Uint8Array(memory.buffer, addr, pktBytes.length).set(pktBytes);
    TX.setDesc(head, addr, pktBytes.length, false, null);
    TX.pushAvail(head);
    return head;
  }

  // RX IN buffers: guest posts empty space the host fills with a packet.
  const RX_BASE = 0x10000;
  const RX_STRIDE = 0x800;
  let rxHead = 0;
  function provideRx(n = 1) {
    for (let i = 0; i < n; i++) {
      const head = rxHead++;
      const addr = RX_BASE + head * RX_STRIDE;
      new Uint8Array(memory.buffer, addr, RX_STRIDE).fill(0);
      RX.setDesc(head, addr, RX_STRIDE, true, null);
      RX.pushAvail(head);
    }
  }
  // Read the packet the host wrote into RX used slot `slot`.
  function rxPacket(slot) {
    const { id, len } = RX.usedElem(slot);
    const addr = RX_BASE + id * RX_STRIDE;
    return new Uint8Array(memory.buffer.slice(addr, addr + len));
  }

  return { ...ctx, RX, TX, EV, submitTx, provideRx, rxPacket };
}

describe("VsockVirtioDevice", () => {
  it("advertises VIRTIO_F_VERSION_1", () => {
    const { dev } = makeDev();
    const f = dev.getFeatures();
    expect((f >> 32n) & 1n).toBe(1n); // VIRTIO_F_VERSION_1 (bit 32)
  });

  it("serves the guest CID in config space (le64 at offset 0)", () => {
    const { dev } = makeDev();
    const cfg = new Uint8Array(8);
    dev.configRead(0, cfg);
    expect(new DataView(cfg.buffer).getBigUint64(0, true)).toBe(BigInt(VSOCK_GUEST_CID));
  });

  it("honors a custom guest CID and zero-pads past config end", () => {
    const { dev } = makeDev({ guestCid: 42 });
    const cfg = new Uint8Array(10).fill(0xee);
    dev.configRead(0, cfg);
    expect(new DataView(cfg.buffer).getBigUint64(0, true)).toBe(42n);
    expect(cfg[8]).toBe(0);
    expect(cfg[9]).toBe(0);
  });

  it("completes the REQUEST→RESPONSE handshake for a listening port", () => {
    const { dev, submitTx, provideRx, rxPacket, irqs } = makeDevWithVqs();
    /** @type {any} */ let accepted = null;
    dev.listen(1024, (conn) => {
      accepted = conn;
    });
    provideRx(2);
    submitTx(
      encodeHdr({ srcPort: 5555, dstPort: 1024, op: VIRTIO_VSOCK_OP_REQUEST, bufAlloc: 4096 }),
    );
    dev.onNotify(1); // TX kick

    // The host replied OP_RESPONSE on the rx vq and raised the IRQ.
    const resp = decodeHdr(rxPacket(0));
    expect(resp.op).toBe(VIRTIO_VSOCK_OP_RESPONSE);
    expect(resp.srcCid).toBe(BigInt(VMADDR_CID_HOST));
    expect(resp.dstCid).toBe(BigInt(VSOCK_GUEST_CID));
    expect(resp.srcPort).toBe(1024);
    expect(resp.dstPort).toBe(5555);
    expect(irqs.length).toBeGreaterThanOrEqual(1);
    expect(irqs[0]).toEqual([0, 15]);

    // The listener was invoked with a connection mirroring the guest's credit.
    expect(accepted).not.toBeNull();
    expect(accepted.hostPort).toBe(1024);
    expect(accepted.guestPort).toBe(5555);
    expect(accepted.peerBufAlloc).toBe(4096);
  });

  it("RSTs a connection request to a port with no listener", () => {
    const { dev, submitTx, provideRx, rxPacket } = makeDevWithVqs();
    provideRx(1);
    submitTx(encodeHdr({ srcPort: 7000, dstPort: 9999, op: VIRTIO_VSOCK_OP_REQUEST }));
    dev.onNotify(1);
    const rst = decodeHdr(rxPacket(0));
    expect(rst.op).toBe(VIRTIO_VSOCK_OP_RST);
    expect(rst.srcPort).toBe(9999);
    expect(rst.dstPort).toBe(7000);
  });

  it("delivers a guest OP_RW payload to the host and credit-updates the guest", () => {
    const { dev, submitTx, provideRx, rxPacket } = makeDevWithVqs();
    const got = [];
    dev.listen(1024, (conn) => conn.onData((b) => got.push(Array.from(b))));
    provideRx(4);
    submitTx(
      encodeHdr({ srcPort: 5555, dstPort: 1024, op: VIRTIO_VSOCK_OP_REQUEST, bufAlloc: 65536 }),
    );
    dev.onNotify(1); // handshake → consumes rx slot 0 (RESPONSE)

    const payload = new Uint8Array([0x68, 0x69]); // "hi"
    const rw = encodeHdr({
      srcPort: 5555,
      dstPort: 1024,
      op: VIRTIO_VSOCK_OP_RW,
      len: payload.length,
      bufAlloc: 65536,
    });
    const full = new Uint8Array(rw.length + payload.length);
    full.set(rw);
    full.set(payload, rw.length);
    submitTx(full);
    dev.onNotify(1);

    expect(got).toEqual([[0x68, 0x69]]);
    // The host acknowledged consumption with a CREDIT_UPDATE on rx slot 1, whose
    // fwd_cnt reflects the 2 bytes consumed.
    const cu = decodeHdr(rxPacket(1));
    expect(cu.op).toBe(VIRTIO_VSOCK_OP_CREDIT_UPDATE);
    expect(cu.fwdCnt).toBe(2);
  });

  it("writes host bytes to the guest as an OP_RW packet over the rx vq", () => {
    const { dev, submitTx, provideRx, rxPacket } = makeDevWithVqs();
    /** @type {any} */ let conn = null;
    dev.listen(1024, (c) => {
      conn = c;
    });
    provideRx(4);
    submitTx(
      encodeHdr({ srcPort: 5555, dstPort: 1024, op: VIRTIO_VSOCK_OP_REQUEST, bufAlloc: 65536 }),
    );
    dev.onNotify(1); // handshake (rx slot 0 = RESPONSE)

    conn.write(new Uint8Array([1, 2, 3, 4]));
    const rw = rxPacket(1);
    const hdr = decodeHdr(rw);
    expect(hdr.op).toBe(VIRTIO_VSOCK_OP_RW);
    expect(hdr.len).toBe(4);
    expect(Array.from(rw.subarray(VSOCK_HDR_LEN, VSOCK_HDR_LEN + 4))).toEqual([1, 2, 3, 4]);
    expect(conn.txCnt).toBe(4);
  });

  it("respects the guest's credit window and flushes on a credit update", () => {
    const { dev, submitTx, provideRx, rxPacket, RX } = makeDevWithVqs();
    /** @type {any} */ let conn = null;
    dev.listen(1024, (c) => {
      conn = c;
    });
    provideRx(8);
    // Guest advertises only a 4-byte window.
    submitTx(encodeHdr({ srcPort: 5555, dstPort: 1024, op: VIRTIO_VSOCK_OP_REQUEST, bufAlloc: 4 }));
    dev.onNotify(1); // rx slot 0 = RESPONSE

    // Host wants to send 6 bytes; only 4 fit the window.
    conn.write(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const first = decodeHdr(rxPacket(1));
    expect(first.op).toBe(VIRTIO_VSOCK_OP_RW);
    expect(first.len).toBe(4);
    expect(conn.txCnt).toBe(4);
    const usedAfterFirst = RX.usedIdx();

    // Guest consumes 4 bytes and advertises window again via CREDIT_UPDATE.
    submitTx(
      encodeHdr({
        srcPort: 5555,
        dstPort: 1024,
        op: VIRTIO_VSOCK_OP_CREDIT_UPDATE,
        bufAlloc: 4,
        fwdCnt: 4,
      }),
    );
    dev.onNotify(1);

    // The remaining 2 bytes now flush.
    expect(conn.txCnt).toBe(6);
    expect(RX.usedIdx()).toBeGreaterThan(usedAfterFirst);
    const rest = decodeHdr(rxPacket(RX.usedIdx() - 1));
    expect(rest.op).toBe(VIRTIO_VSOCK_OP_RW);
    expect(rest.len).toBe(2);
  });

  it("tears the connection down on a full SHUTDOWN and fires onClose", () => {
    const { dev, submitTx, provideRx } = makeDevWithVqs();
    /** @type {any} */ let conn = null;
    let closed = false;
    dev.listen(1024, (c) => {
      conn = c;
      c.onClose(() => {
        closed = true;
      });
    });
    provideRx(4);
    submitTx(encodeHdr({ srcPort: 5555, dstPort: 1024, op: VIRTIO_VSOCK_OP_REQUEST }));
    dev.onNotify(1);

    submitTx(
      encodeHdr({
        srcPort: 5555,
        dstPort: 1024,
        op: VIRTIO_VSOCK_OP_SHUTDOWN,
        flags: VIRTIO_VSOCK_SHUTDOWN_RCV | VIRTIO_VSOCK_SHUTDOWN_SEND,
      }),
    );
    dev.onNotify(1);
    expect(closed).toBe(true);
    expect(conn.open).toBe(false);
  });

  it("forwards the kick instead of servicing when forwardNotify is set (worker mode)", () => {
    const fwd = [];
    const { dev } = makeDev({ forwardNotify: (d, q) => fwd.push([d, q]) });
    dev.onNotify(1);
    expect(fwd).toEqual([[7, 1]]);
  });

  it("re-scans the tx queue when a kick arrives mid-drain (re-entrancy)", () => {
    const { dev, submitTx, provideRx } = makeDevWithVqs();
    let seen = 0;
    dev.listen(1024, (conn) =>
      conn.onData(() => {
        seen++;
        // A kick lands while we are still inside the first drain. The base
        // helper here is synchronous, but the re-entrancy guard must still
        // coalesce rather than overlap two drains.
        if (seen === 1) {
          const p = new Uint8Array([0x42]);
          const rw = encodeHdr({
            srcPort: 5555,
            dstPort: 1024,
            op: VIRTIO_VSOCK_OP_RW,
            len: 1,
            bufAlloc: 65536,
          });
          const full = new Uint8Array(rw.length + 1);
          full.set(rw);
          full.set(p, rw.length);
          submitTx(full);
          dev.onNotify(1); // re-entrant kick
        }
      }),
    );
    provideRx(8);
    submitTx(
      encodeHdr({ srcPort: 5555, dstPort: 1024, op: VIRTIO_VSOCK_OP_REQUEST, bufAlloc: 65536 }),
    );
    dev.onNotify(1);

    const p = new Uint8Array([0x41]);
    const rw = encodeHdr({
      srcPort: 5555,
      dstPort: 1024,
      op: VIRTIO_VSOCK_OP_RW,
      len: 1,
      bufAlloc: 65536,
    });
    const full = new Uint8Array(rw.length + 1);
    full.set(rw);
    full.set(p, rw.length);
    submitTx(full);
    dev.onNotify(1);

    // Both the first RW and the re-entrantly-submitted RW were delivered exactly
    // once each (no dropped or doubled packet).
    expect(seen).toBe(2);
  });

  it("does not complete event-queue buffers (no transport-reset events emitted)", () => {
    const { dev, EV } = makeDevWithVqs();
    // Guest posts an event buffer.
    EV.setDesc(0, 0x20000, 0x40, true, null);
    EV.pushAvail(0);
    dev.onNotify(2); // event kick
    expect(EV.usedIdx()).toBe(0); // left parked, not pushed used
  });
});
