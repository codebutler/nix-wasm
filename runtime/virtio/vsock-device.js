// vsock-device.js — host (JS) model of a virtio-vsock device on the
// `virtio_wasm` transport. This is the device the guest's STOCK mainline
// virtio-vsock transport (net/vmw_vsock/virtio_transport.c,
// CONFIG_VIRTIO_VSOCKETS riding CONFIG_VSOCKETS) talks to, providing a standard
// AF_VSOCK socket channel between guest and host (issue #10 option 3: the vsock
// piece of "everything is a virtio device"). It exists to carry the guest→host
// /Ctl desktop-control bridge (launch pc app, clipboard, notify) on a standard
// socket instead of riding 9P as an `aname` mount.
//
// SCOPE: this is the transport SUBSTRATE only. The /Ctl protocol consumer (the
// code that interprets launch-app/clipboard/notify messages) lives downstream in
// the pc repo and is OUT OF SCOPE here. This device exposes a clean host-side
// socket API (listen/accept/connect, per-connection read/write/close) that the
// future pc /Ctl consumer plugs into.
//
// THREE VIRTQUEUES (mainline virtio_transport.c binds exactly these, in order):
//   q0 = rx    host→guest packets (the guest posts empty buffers; the host fills
//              them with virtio_vsock_hdr + payload and pushes them used)
//   q1 = tx    guest→host packets (the guest posts virtio_vsock_hdr + payload;
//              the host reads them, runs the protocol, and pushes them used)
//   q2 = event device→driver transport-reset events (the guest posts buffers; we
//              never emit an event, so they stay parked — but we must not choke
//              on the kick)
//
// CONFIG SPACE: struct virtio_vsock_config { __le64 guest_cid; } — the guest
// driver reads its own CID from offset 0. We serve a fixed guest CID = 3 (the
// first guest CID; VMADDR_CID_HOST = 2 is the host, VMADDR_CID_HYPERVISOR = 0,
// VMADDR_CID_LOCAL = 1, VMADDR_CID_ANY = -1). The host always addresses the
// guest as CID 3 and identifies itself as CID 2.
//
// PACKET FRAMING (struct virtio_vsock_hdr, 44 bytes, little-endian):
//   off  0  __le64 src_cid
//   off  8  __le64 dst_cid
//   off 16  __le32 src_port
//   off 20  __le32 dst_port
//   off 24  __le32 len          (payload length following the header)
//   off 28  __le16 type         (VIRTIO_VSOCK_TYPE_STREAM = 1)
//   off 30  __le16 op           (REQUEST/RESPONSE/RST/SHUTDOWN/RW/CREDIT_*)
//   off 32  __le32 flags        (SHUTDOWN bits on an OP_SHUTDOWN)
//   off 36  __le32 buf_alloc    (sender's receive-buffer size, for credit)
//   off 40  __le32 fwd_cnt      (bytes the sender has consumed, for credit)
//
// STREAM CREDIT (virtio-vsock flow control): each side advertises buf_alloc (its
// rx buffer size) and fwd_cnt (bytes it has consumed). The peer may send up to
// (buf_alloc - (tx_cnt - fwd_cnt)) bytes. We honor it on the host→guest path
// (don't outrun the guest's advertised window) and account it on guest→host.
//
// WORKER→MAIN INVERSION (mirrors ninep-device.js — issue #10): the host socket
// API (listen/accept/connect callbacks) is main-thread-bound, but the guest's vq
// kick (wasm_virtio_notify) lands on whichever task worker issued the syscall. So
// a worker-side instance only answers the synchronous transport probes (features
// / config / queue setup) and FORWARDS the notify (virtiovsock_notify) to the
// main thread; a main-thread instance (given the socket callbacks) drains the tx
// vq, runs the protocol, and delivers host→guest packets on the rx vq, raising
// the device IRQ via the SAME raised_irqs self-wake path virtio-wl/net/9p use
// (kernel-host raiseHostWlIrq). The OR-before-notify in that path means no
// lost-wakeup race.

import { VirtioWasmDevice } from "./device.js";

// ---- virtio-vsock constants (uapi/linux/virtio_vsock.h) ----
export const VSOCK_HDR_LEN = 44;

export const VMADDR_CID_HOST = 2; // the host (us)
export const VSOCK_GUEST_CID = 3; // the guest (served in config space)

const VIRTIO_F_VERSION_1 = 32n; // modern (v1) device

// queue indices (mainline virtio_transport.c order)
const VSOCK_VQ_RX = 0;
const VSOCK_VQ_TX = 1;
const VSOCK_VQ_EVENT = 2;

export const VIRTIO_VSOCK_TYPE_STREAM = 1;

export const VIRTIO_VSOCK_OP_INVALID = 0;
export const VIRTIO_VSOCK_OP_REQUEST = 1;
export const VIRTIO_VSOCK_OP_RESPONSE = 2;
export const VIRTIO_VSOCK_OP_RST = 3;
export const VIRTIO_VSOCK_OP_SHUTDOWN = 4;
export const VIRTIO_VSOCK_OP_RW = 5;
export const VIRTIO_VSOCK_OP_CREDIT_UPDATE = 6;
export const VIRTIO_VSOCK_OP_CREDIT_REQUEST = 7;

// VIRTIO_VSOCK_SHUTDOWN_{RCV,SEND} flags on an OP_SHUTDOWN
export const VIRTIO_VSOCK_SHUTDOWN_RCV = 1;
export const VIRTIO_VSOCK_SHUTDOWN_SEND = 2;

// Default host rx-window we advertise to the guest (buf_alloc). The guest may
// send up to this many un-consumed bytes before it must wait for our credit
// update. 256 KiB is comfortably above any /Ctl message and a single virtio-vsock
// payload (bounded by the guest's tx buffer), and never approaches the 64-entry
// vq capacity since each packet is one chain.
const HOST_BUF_ALLOC = 256 * 1024;

function decodeHdr(view, off) {
  const dv =
    view instanceof DataView ? view : new DataView(view.buffer, view.byteOffset, view.byteLength);
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
 * One half of a vsock stream connection, as seen by the host. Identified by the
 * (guest_port, host_port) tuple. `write(bytes)` queues an OP_RW packet to the
 * guest (respecting the guest's advertised credit); `onData(cb)` delivers
 * guest→host payload bytes; `close()` sends an OP_SHUTDOWN + OP_RST and tears
 * the connection down. This is the surface the future pc /Ctl consumer uses.
 */
class VsockConnection {
  /**
   * @param {VsockVirtioDevice} dev
   * @param {number} hostPort  the host-side (local) port
   * @param {number} guestPort the guest-side (remote) port
   */
  constructor(dev, hostPort, guestPort) {
    this._dev = dev;
    this.hostPort = hostPort >>> 0;
    this.guestPort = guestPort >>> 0;
    this.open = true;
    // Credit accounting (host's view of the guest's rx window).
    this.peerBufAlloc = 0; // guest's advertised rx buffer size
    this.peerFwdCnt = 0; // bytes the guest reports consumed
    this.txCnt = 0; // total payload bytes we (host) have sent the guest
    // Host's own rx accounting (what we advertise to the guest).
    this.rxFwdCnt = 0; // bytes we (host) have consumed from the guest
    /** @type {((bytes: Uint8Array) => void) | null} */
    this._onData = null;
    /** @type {(() => void) | null} */
    this._onClose = null;
    this._pendingTx = []; // bytes queued while over-credit / before rx buffers
  }

  /** Subscribe to guest→host payload bytes. */
  onData(cb) {
    this._onData = cb;
    return this;
  }

  /** Subscribe to connection teardown (guest RST/SHUTDOWN or host close). */
  onClose(cb) {
    this._onClose = cb;
    return this;
  }

  /** Bytes the guest will currently accept (its advertised window minus inflight). */
  creditAvailable() {
    const inflight = (this.txCnt - this.peerFwdCnt) >>> 0;
    return Math.max(0, this.peerBufAlloc - inflight);
  }

  /** Queue payload bytes to the guest as OP_RW packets, honoring guest credit. */
  write(bytes) {
    if (!this.open) return false;
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this._pendingTx.push(buf);
    this._dev._flushConnection(this);
    return true;
  }

  /** Half/full close: SHUTDOWN both directions then RST. */
  close() {
    if (!this.open) return;
    this._dev._closeConnection(this, true);
  }

  /** Internal: deliver received payload to the consumer + advance rx fwd_cnt. */
  _deliver(payload) {
    this.rxFwdCnt = (this.rxFwdCnt + payload.length) >>> 0;
    if (this._onData) this._onData(payload);
  }
}

export class VsockVirtioDevice extends VirtioWasmDevice {
  /**
   * Extends the base VirtioWasmDevice opts with:
   * - `guestCid` (number): CID served in config space (default VSOCK_GUEST_CID=3).
   * - `forwardNotify` ((dev, q) => void): WORKER only — forwards the kick to the
   *   main thread (where the socket callbacks live) instead of servicing here.
   *
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & { guestCid?: number, forwardNotify?: (dev: number, q: number) => void }} opts
   */
  constructor(opts) {
    super(opts);
    this.guestCid = BigInt((opts.guestCid ?? VSOCK_GUEST_CID) >>> 0);
    this.forwardNotify = opts.forwardNotify || null;
    // Host-side listeners: port -> (connection) => void.
    /** @type {Map<number, (conn: VsockConnection) => void>} */
    this._listeners = new Map();
    // Active connections keyed by `${hostPort}:${guestPort}`.
    /** @type {Map<string, VsockConnection>} */
    this._conns = new Map();
    // Re-entrancy guard on the tx drain (a kick mid-drain re-scans).
    this._servicingTx = false;
    this._rearmTx = false;
    // Next host-initiated local port (for connect()).
    this._nextHostPort = 1024;
  }

  getFeatures() {
    // VIRTIO_F_VERSION_1 only. STREAM is the mandatory baseline transport mode;
    // we do not offer the optional SEQPACKET/DGRAM features, so the guest driver
    // negotiates plain stream sockets.
    return 1n << VIRTIO_F_VERSION_1;
  }

  // struct virtio_vsock_config { __le64 guest_cid; } — serve the guest CID at
  // offset 0, zero past the end.
  configRead(offset, bytes) {
    const cfg = new Uint8Array(8);
    new DataView(cfg.buffer).setBigUint64(0, this.guestCid, true);
    for (let i = 0; i < bytes.length; i++) {
      const src = offset + i;
      bytes[i] = src < cfg.length ? cfg[src] : 0;
    }
  }

  // ---- host-side socket API (the surface pc's /Ctl consumer plugs into) ----

  /**
   * Listen for guest-initiated stream connections to `port`. `onConnection` is
   * invoked with a VsockConnection once the guest completes the OP_REQUEST →
   * OP_RESPONSE handshake. The future pc /Ctl consumer calls
   * `dev.listen(CTL_PORT, conn => …)` and reads/writes /Ctl messages on `conn`.
   * @param {number} port
   * @param {(conn: VsockConnection) => void} onConnection
   */
  listen(port, onConnection) {
    this._listeners.set(port >>> 0, onConnection);
  }

  /** Stop listening on a port. */
  unlisten(port) {
    this._listeners.delete(port >>> 0);
  }

  /**
   * Host-initiated connect to a guest-side listening `port`. Returns a
   * VsockConnection immediately; it becomes usable once the guest replies
   * OP_RESPONSE (the caller should wait on onData/onClose). Mostly for tests and
   * symmetry — /Ctl is guest-initiated.
   * @param {number} guestPort
   */
  connect(guestPort) {
    const hostPort = this._nextHostPort++;
    const conn = new VsockConnection(this, hostPort, guestPort >>> 0);
    this._conns.set(this._key(conn), conn);
    conn.peerBufAlloc = HOST_BUF_ALLOC; // optimistic; corrected by the guest's reply
    this._sendCtl(conn, VIRTIO_VSOCK_OP_REQUEST);
    return conn;
  }

  _key(conn) {
    return `${conn.hostPort}:${conn.guestPort}`;
  }

  // ---- notify / tx drain ----

  onNotify(q) {
    const qi = q >>> 0;
    if (this.forwardNotify) {
      // Worker side: the socket callbacks are on the main thread — forward.
      this.forwardNotify(this.dev, qi);
      return;
    }
    if (qi === VSOCK_VQ_TX) {
      this._serviceTx();
    } else if (qi === VSOCK_VQ_RX) {
      // The guest refilled the rx ring with empty buffers — flush any host→guest
      // packets we deferred for lack of a free rx buffer.
      this._flushAll();
    } else if (qi === VSOCK_VQ_EVENT) {
      // The guest posted event buffers. We never emit a transport-reset event,
      // so leave them parked (do not push them used — that would complete a
      // buffer the guest is waiting to receive an event on).
    }
  }

  /**
   * Drain the tx vq (guest→host packets): read each virtio_vsock_hdr + payload,
   * run the protocol (handshake / RW / credit / shutdown), push the chain used,
   * and raise the IRQ. Re-entrancy-safe (a kick mid-drain re-scans). Synchronous:
   * the protocol work is pure shared-memory + JS callback dispatch.
   */
  _serviceTx() {
    const vr = this.vring(VSOCK_VQ_TX);
    if (!vr) {
      this.log("[virtio-vsock] tx notify before queue setup");
      return;
    }
    if (this._servicingTx) {
      this._rearmTx = true;
      return;
    }
    this._servicingTx = true;
    try {
      do {
        this._rearmTx = false;
        let chain;
        let serviced = 0;
        while ((chain = vr.next())) {
          const pkt = vr.readOut(chain);
          try {
            this._handleTxPacket(pkt);
          } catch (e) {
            this.log(`[virtio-vsock] tx packet error: ${e}`);
          }
          vr.pushUsed(chain.head, 0); // tx buffers are read-only; used len = 0
          serviced++;
        }
        if (serviced) this.raiseIrq();
      } while (this._rearmTx);
    } finally {
      this._servicingTx = false;
    }
  }

  /** Parse + dispatch one guest→host packet. */
  _handleTxPacket(pkt) {
    if (pkt.length < VSOCK_HDR_LEN) {
      this.log(`[virtio-vsock] short tx packet (${pkt.length} < ${VSOCK_HDR_LEN})`);
      return;
    }
    const hdr = decodeHdr(pkt, 0);
    // On the guest→host path src=guest, dst=host. Our connection key is
    // (hostPort, guestPort) = (hdr.dstPort, hdr.srcPort).
    const hostPort = hdr.dstPort;
    const guestPort = hdr.srcPort;
    const key = `${hostPort}:${guestPort}`;
    let conn = this._conns.get(key);

    switch (hdr.op) {
      case VIRTIO_VSOCK_OP_REQUEST: {
        // Guest is connecting to host `hostPort`. Accept iff a listener exists.
        const onConn = this._listeners.get(hostPort);
        if (!onConn) {
          // No listener: reject with RST.
          this._sendRst(hostPort, guestPort);
          return;
        }
        conn = new VsockConnection(this, hostPort, guestPort);
        conn.peerBufAlloc = hdr.bufAlloc;
        conn.peerFwdCnt = hdr.fwdCnt;
        this._conns.set(key, conn);
        this._sendCtl(conn, VIRTIO_VSOCK_OP_RESPONSE);
        try {
          onConn(conn);
        } catch (e) {
          this.log(`[virtio-vsock] listener threw: ${e}`);
        }
        return;
      }
      case VIRTIO_VSOCK_OP_RESPONSE: {
        // Reply to a host-initiated connect() — the connection is now open.
        if (!conn) return;
        conn.peerBufAlloc = hdr.bufAlloc;
        conn.peerFwdCnt = hdr.fwdCnt;
        conn.open = true;
        this._flushConnection(conn);
        return;
      }
      case VIRTIO_VSOCK_OP_RW: {
        if (!conn) {
          this._sendRst(hostPort, guestPort);
          return;
        }
        // Credit bookkeeping: the guest piggybacks its buf_alloc/fwd_cnt.
        conn.peerBufAlloc = hdr.bufAlloc;
        conn.peerFwdCnt = hdr.fwdCnt;
        const payload = pkt.subarray(VSOCK_HDR_LEN, VSOCK_HDR_LEN + hdr.len);
        // Copy out of the (shared) vring buffer before handing to the consumer.
        conn._deliver(Uint8Array.from(payload));
        // Acknowledge consumption so the guest can reclaim its tx window.
        this._sendCtl(conn, VIRTIO_VSOCK_OP_CREDIT_UPDATE);
        // Drain anything we had queued (the guest's window may have grown).
        this._flushConnection(conn);
        return;
      }
      case VIRTIO_VSOCK_OP_CREDIT_UPDATE: {
        if (!conn) return;
        conn.peerBufAlloc = hdr.bufAlloc;
        conn.peerFwdCnt = hdr.fwdCnt;
        this._flushConnection(conn);
        return;
      }
      case VIRTIO_VSOCK_OP_CREDIT_REQUEST: {
        if (!conn) return;
        this._sendCtl(conn, VIRTIO_VSOCK_OP_CREDIT_UPDATE);
        return;
      }
      case VIRTIO_VSOCK_OP_SHUTDOWN: {
        if (!conn) return;
        // Guest is shutting the stream down; both bits ⇒ full close → RST.
        const both = VIRTIO_VSOCK_SHUTDOWN_RCV | VIRTIO_VSOCK_SHUTDOWN_SEND;
        if ((hdr.flags & both) === both) {
          this._closeConnection(conn, true);
        }
        return;
      }
      case VIRTIO_VSOCK_OP_RST: {
        if (conn) this._closeConnection(conn, false);
        return;
      }
      default:
        this.log(`[virtio-vsock] unhandled op ${hdr.op}`);
    }
  }

  // ---- host→guest packet emission (rx vq) ----

  /**
   * Build a virtio_vsock_hdr (+ optional payload) and push it onto the rx vq,
   * raising the IRQ. Returns false if no rx buffer is available (the caller
   * should retry on the next VSOCK_VQ_RX kick). src=host (CID 2), dst=guest.
   */
  _pushRx(srcPort, dstPort, op, payload, flags, conn) {
    const vr = this.vring(VSOCK_VQ_RX);
    if (!vr) return false;
    const chain = vr.next();
    if (!chain) return false; // no free rx buffer — defer
    const plen = payload ? payload.length : 0;
    const pkt = new Uint8Array(VSOCK_HDR_LEN + plen);
    const dv = new DataView(pkt.buffer);
    dv.setBigUint64(0, BigInt(VMADDR_CID_HOST), true); // src_cid = host
    dv.setBigUint64(8, this.guestCid, true); // dst_cid = guest
    dv.setUint32(16, srcPort >>> 0, true);
    dv.setUint32(20, dstPort >>> 0, true);
    dv.setUint32(24, plen, true);
    dv.setUint16(28, VIRTIO_VSOCK_TYPE_STREAM, true);
    dv.setUint16(30, op, true);
    dv.setUint32(32, (flags || 0) >>> 0, true);
    // Credit fields: advertise our rx window + the bytes we've consumed so the
    // guest can size its tx. buf_alloc/fwd_cnt are per-connection where we have
    // one, else defaults (handshake/RST before a connection object exists).
    dv.setUint32(36, HOST_BUF_ALLOC, true); // buf_alloc (host rx window)
    dv.setUint32(40, conn ? conn.rxFwdCnt >>> 0 : 0, true); // fwd_cnt
    if (payload) pkt.set(payload, VSOCK_HDR_LEN);
    if (vr.inCapacity(chain) < pkt.length) {
      vr.pushUsed(chain.head, 0); // recycle; buffer too small (shouldn't happen)
      return false;
    }
    const written = vr.writeIn(chain, pkt);
    vr.pushUsed(chain.head, written);
    this.raiseIrq();
    return true;
  }

  /** Emit a control packet (no payload) on a connection (host→guest). */
  _sendCtl(conn, op, flags) {
    return this._pushRx(conn.hostPort, conn.guestPort, op, null, flags, conn);
  }

  /** Emit a bare RST for an (hostPort, guestPort) with no connection object. */
  _sendRst(hostPort, guestPort) {
    return this._pushRx(hostPort, guestPort, VIRTIO_VSOCK_OP_RST, null, 0, null);
  }

  /**
   * Flush a connection's pending tx bytes to the guest as OP_RW packets, bounded
   * by the guest's advertised credit and rx-buffer availability. Bytes that
   * don't fit stay queued for the next credit update / rx refill.
   */
  _flushConnection(conn) {
    if (!conn.open) return;
    while (conn._pendingTx.length) {
      const credit = conn.creditAvailable();
      if (credit <= 0) break; // guest window full — wait for a credit update
      const head = conn._pendingTx[0];
      const n = Math.min(head.length, credit);
      const slice = head.subarray(0, n);
      const ok = this._pushRx(conn.hostPort, conn.guestPort, VIRTIO_VSOCK_OP_RW, slice, 0, conn);
      if (!ok) break; // no rx buffer — defer until VSOCK_VQ_RX refill
      conn.txCnt = (conn.txCnt + n) >>> 0;
      if (n >= head.length) conn._pendingTx.shift();
      else conn._pendingTx[0] = head.subarray(n);
    }
  }

  /** Re-flush every connection (called on an rx-ring refill). */
  _flushAll() {
    for (const conn of this._conns.values()) this._flushConnection(conn);
  }

  /**
   * Tear a connection down. If `sendShutdown`, emit SHUTDOWN(both)+RST to the
   * guest first (host-initiated/full close); otherwise it's an ack of a guest
   * RST. Fires onClose and forgets the connection.
   */
  _closeConnection(conn, sendShutdown) {
    if (!conn.open && !this._conns.has(this._key(conn))) return;
    if (sendShutdown) {
      this._sendCtl(
        conn,
        VIRTIO_VSOCK_OP_SHUTDOWN,
        VIRTIO_VSOCK_SHUTDOWN_RCV | VIRTIO_VSOCK_SHUTDOWN_SEND,
      );
      this._sendCtl(conn, VIRTIO_VSOCK_OP_RST);
    }
    conn.open = false;
    conn._pendingTx = [];
    this._conns.delete(this._key(conn));
    if (conn._onClose) {
      try {
        conn._onClose();
      } catch (e) {
        this.log(`[virtio-vsock] onClose threw: ${e}`);
      }
    }
  }
}

export { VsockConnection };
