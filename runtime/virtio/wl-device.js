// wl-device.js — host (JS) model of the virtio-wl device for the `virtio_wasm`
// transport (Linux/Wasm, "pc" Wayland Phase 1 1b). This is the device the guest
// virtio_wl driver (drivers/virtio/virtio_wl.c, /dev/wl0) talks to.
//
// Two virtqueues, matching the ChromeOS virtwl protocol:
//   VIRTWL_VQ_IN  = 0  device -> guest unsolicited msgs (VFD_RECV/NEW/HUP).
//                       The guest prefills this with PAGE_SIZE inbufs; the host
//                       fills one and pushes it used to deliver a message.
//   VIRTWL_VQ_OUT = 1  guest -> device requests (NEW_CTX, SEND, CLOSE, ...).
//                       The guest provides an out_sg (the request) followed by
//                       an in_sg (a buffer for the host's response, often the
//                       same buffer). The host parses the request, writes the
//                       response over the in_sg, pushes it used, and raises the
//                       irq -> vq_out_cb completes the guest's wait.
//
// For 1b/M3 we implement the control-message round-trip the guest needs to
// probe /dev/wl0 and create a context VFD (VIRTWL_IOCTL_NEW_CTX). SEND/RECV of
// actual wayland bytes is stubbed enough to round-trip (acks SEND, no real
// compositor yet — that is Phase 1d / Phase 2). In-worker servicing is fine.

import { VirtioWasmDevice } from "./device.js";

// virtio_wl ctrl types (uapi/linux/virtio_wl.h).
const VIRTIO_WL_CMD_VFD_NEW = 0x100;
const VIRTIO_WL_CMD_VFD_CLOSE = 0x101;
const VIRTIO_WL_CMD_VFD_SEND = 0x102;
const VIRTIO_WL_CMD_VFD_RECV = 0x103;
const VIRTIO_WL_CMD_VFD_NEW_CTX = 0x104;
const VIRTIO_WL_CMD_VFD_NEW_PIPE = 0x105;
const VIRTIO_WL_CMD_VFD_HUP = 0x106;
const VIRTIO_WL_CMD_VFD_NEW_CTX_NAMED = 0x10a;

const VIRTIO_WL_RESP_OK = 0x1000;
const VIRTIO_WL_RESP_VFD_NEW = 0x1001;
const VIRTIO_WL_RESP_INVALID_TYPE = 0x1103;

const VIRTIO_WL_VFD_WRITE = 0x1;
const VIRTIO_WL_VFD_READ = 0x2;

const VIRTWL_VQ_IN = 0;
const VIRTWL_VQ_OUT = 1;

// struct virtio_wl_ctrl_vfd_new layout (little-endian):
//   0  u32 hdr.type
//   4  u32 hdr.flags
//   8  u32 vfd_id
//   12 u32 flags
//   16 u64 pfn
//   24 u32 size
//   28 .. union (name[32] / dmabuf) — we only touch the header fields.
const HDR_SIZE = 8;

export class WlDevice extends VirtioWasmDevice {
  constructor(opts) {
    super(opts);
    this._nextVfdId = 1; // host-allocated vfd ids would set the HOST bit; the
    // guest allocates ctx/pipe ids itself, so we only echo them back.
    this.contexts = new Map(); // vfd_id -> { type }
  }

  getFeatures() {
    // VIRTIO_WL_F_TRANS_FLAGS (bit 0) — new flag semantics. We don't claim
    // SEND_FENCES (bit 1; that's the virtgpu path we don't support).
    return 1n; // 1 << VIRTIO_WL_F_TRANS_FLAGS
  }

  // virtio_wl_config is empty; nothing to serve.
  configRead(_offset, bytes) {
    bytes.fill(0);
  }

  onNotify(q) {
    if ((q >>> 0) === VIRTWL_VQ_OUT) {
      this._serviceOut();
    } else if ((q >>> 0) === VIRTWL_VQ_IN) {
      // Guest (re)posted inbufs. Nothing to push yet (no compositor traffic).
      this.log(`[virtio-wl] IN queue refilled (no pending host msgs)`);
    }
  }

  _serviceOut() {
    const vr = this.vring(VIRTWL_VQ_OUT);
    if (!vr) {
      this.log(`[virtio-wl] OUT notify before setup`);
      return;
    }

    let serviced = 0;
    let chain;
    while ((chain = vr.next())) {
      const req = vr.readOut(chain); // the request bytes
      const resp = this._handle(req);
      // Write the response over the in_sg (capped to its capacity).
      const written = vr.writeIn(chain, resp);
      vr.pushUsed(chain.head, written);
      serviced++;
    }

    if (serviced > 0) this.raiseIrq();
  }

  /**
   * Parse one virtwl OUT request and return the response bytes the guest reads
   * back via its in_sg. The guest's response buffer is typically the same
   * struct it sent, so we return a full ctrl_vfd_new-sized reply for NEW_*,
   * else a bare ctrl_hdr.
   */
  _handle(req) {
    if (req.length < HDR_SIZE) return this._hdr(VIRTIO_WL_RESP_INVALID_TYPE);
    const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
    const type = dv.getUint32(0, true);

    switch (type) {
      case VIRTIO_WL_CMD_VFD_NEW_CTX:
      case VIRTIO_WL_CMD_VFD_NEW_CTX_NAMED:
      case VIRTIO_WL_CMD_VFD_NEW_PIPE:
      case VIRTIO_WL_CMD_VFD_NEW: {
        const vfdId = req.length >= 12 ? dv.getUint32(8, true) : 0;
        this.contexts.set(vfdId, { type });
        this.log(`[virtio-wl] NEW (type=0x${type.toString(16)}) vfd_id=${vfdId} -> RESP_VFD_NEW`);
        return this._vfdNew(vfdId, /*size*/ 0, /*pfn*/ 0n, VIRTIO_WL_VFD_WRITE | VIRTIO_WL_VFD_READ);
      }
      case VIRTIO_WL_CMD_VFD_CLOSE: {
        const vfdId = req.length >= 12 ? dv.getUint32(8, true) : 0;
        this.contexts.delete(vfdId);
        this.log(`[virtio-wl] CLOSE vfd_id=${vfdId} -> RESP_OK`);
        return this._hdr(VIRTIO_WL_RESP_OK);
      }
      case VIRTIO_WL_CMD_VFD_SEND: {
        // Ack the send. A real compositor would route the wayland bytes here.
        this.log(`[virtio-wl] SEND ${req.length}B -> RESP_OK (stub, no compositor)`);
        return this._hdr(VIRTIO_WL_RESP_OK);
      }
      default:
        this.log(`[virtio-wl] unhandled type 0x${type.toString(16)} -> INVALID_TYPE`);
        return this._hdr(VIRTIO_WL_RESP_INVALID_TYPE);
    }
  }

  /** A bare ctrl_hdr response (8 bytes: type, flags=0). */
  _hdr(type) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, type, true);
    return b;
  }

  /** A ctrl_vfd_new response (RESP_VFD_NEW), 32 bytes through the union start. */
  _vfdNew(vfdId, size, pfn, flags) {
    const b = new Uint8Array(32);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, VIRTIO_WL_RESP_VFD_NEW, true); // hdr.type
    dv.setUint32(4, 0, true); // hdr.flags
    dv.setUint32(8, vfdId, true); // vfd_id
    dv.setUint32(12, flags, true); // flags
    dv.setBigUint64(16, BigInt(pfn), true); // pfn
    dv.setUint32(24, size, true); // size
    return b;
  }
}
