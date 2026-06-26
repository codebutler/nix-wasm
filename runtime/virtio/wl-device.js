// @ts-nocheck -- vendored linux-wasm runtime (browser-isms; not pc-typed), like
// kernel-host.js / kernel-worker.js. Pulled into the typecheck graph once
// kernel-host.js began importing WlDevice for host-side idle-wake injection.
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
// probe /dev/wl0 and create a context VFD (VIRTWL_IOCTL_NEW_CTX). For 1d we now
// also parse the wayland bytes carried by a VFD_SEND, run them through a minimal
// host Wayland SERVER (wl-server.js — registry handshake only, no compositor),
// and push the server's reply bytes BACK to the guest over the IN queue as a
// VFD_RECV addressed to the same ctx vfd_id. The driver's vq_handle_recv routes
// that to the ctx's read queue, waylandproxyd's VIRTWL_IOCTL_RECV reads it, and
// forwards it to the client socket — completing wl_display_roundtrip(). Real
// compositing (surfaces/buffers/pixels) is still Phase 2 / Greenfield.

import { VirtioWasmDevice } from "./device.js";
import { WlServer } from "./wl-server.js";

// virtio_wl ctrl types (uapi/linux/virtio_wl.h).
const VIRTIO_WL_CMD_VFD_NEW = 0x100;
const VIRTIO_WL_CMD_VFD_CLOSE = 0x101;
const VIRTIO_WL_CMD_VFD_SEND = 0x102;
const VIRTIO_WL_CMD_VFD_RECV = 0x103;
const VIRTIO_WL_CMD_VFD_NEW_CTX = 0x104;
const VIRTIO_WL_CMD_VFD_NEW_PIPE = 0x105;
const _VIRTIO_WL_CMD_VFD_HUP = 0x106; // (host->guest HUP; not emitted yet)
const VIRTIO_WL_CMD_VFD_NEW_CTX_NAMED = 0x10a;

const VIRTIO_WL_RESP_OK = 0x1000;
const VIRTIO_WL_RESP_VFD_NEW = 0x1001;
const VIRTIO_WL_RESP_INVALID_TYPE = 0x1103;

const VIRTIO_WL_VFD_WRITE = 0x1;
const VIRTIO_WL_VFD_READ = 0x2;

// Host-allocated vfd ids carry this bit (uapi VFD_ID_HOST_MASK); the guest
// virtio_wl driver REQUIRES it on any VFD_NEW it receives from the host
// (vq_handle_new rejects ids without it) and must NOT have the illegal sign bit.
const VFD_HOST_ID_BIT = 0x40000000;
const VFD_ILLEGAL_SIGN_BIT = 0x80000000;

const VIRTWL_VQ_IN = 0;
const VIRTWL_VQ_OUT = 1;

// struct virtio_wl_ctrl_vfd_send / _recv header (little-endian):
//   0  u32 hdr.type
//   4  u32 hdr.flags
//   8  u32 vfd_id      (the ctx the data belongs to)
//   12 u32 vfd_count   (number of trailing __le32 vfd ids; 0 for the handshake)
//   16 .. vfd ids (vfd_count * 4), then raw wayland data
const SEND_HDR_SIZE = 16;

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
  /**
   * @param {object} opts
   * @param {{
   *   sendOut: (clientId: number, data: Uint8Array, fds: Uint8Array[]) => void
   * }} [opts.waylandBridge]
   *   Phase 4f bridge hook. When present, a VFD_SEND's wayland bytes are routed
   *   OUT to the host (which feeds the main-thread Greenfield compositor) instead
   *   of the in-worker WlServer stub. `clientId` is the per-ctx vfd_id — one
   *   Greenfield client per guest Wayland connection. `sendOut` is FIRE-AND-FORGET
   *   (no return value, no blocking): the guest's SEND completes on the synchronous
   *   OUT ack, and the compositor's server→client response arrives later over the
   *   IN queue via the host's pushIn → host-WlDevice.injectIn (the single async
   *   host→guest path). Without this hook the device falls back to the local
   *   WlServer (Phase 1 1d behavior + tests), which still uses inReply.
   */
  constructor(opts) {
    super(opts);
    this._nextVfdId = 1; // host-allocated vfd ids would set the HOST bit; the
    // guest allocates ctx/pipe ids itself, so we only echo them back.
    // Monotonic counter for HOST-originated vfds (server→client fds, e.g. the
    // wl_keyboard keymap). Each gets VFD_HOST_ID_BIT | n; the guest driver's
    // vq_handle_new requires the host bit, the guest allocates its own ids low.
    this._nextHostVfdId = 1;
    this.contexts = new Map(); // vfd_id -> { type, server }
    this._bridge = opts.waylandBridge || null;
    // Phase 2 2c: log shm region checksums + wire opcodes to prove the pixel
    // path. Off by default; opt in via the bridge for a debug session.
    this._shmDebug = !!opts.shmDebug;
  }

  /** Lazily get (or create) the per-ctx Wayland server for a vfd_id. */
  _serverFor(vfdId) {
    let ctx = this.contexts.get(vfdId);
    if (!ctx) {
      ctx = { type: VIRTIO_WL_CMD_VFD_NEW_CTX };
      this.contexts.set(vfdId, ctx);
    }
    if (!ctx.server) ctx.server = new WlServer((m) => this.log(m));
    return ctx.server;
  }

  getFeatures() {
    // VIRTIO_WL_F_TRANS_FLAGS (bit 0) — new flag semantics. We don't claim
    // SEND_FENCES (bit 1; that's the virtgpu path we don't support).
    return 1n; // 1 << VIRTIO_WL_F_TRANS_FLAGS
  }

  // --- Phase 2 / M3: guest-memory shm pools --------------------------------
  //
  // A VFD_NEW(NEW_ALLOC) is the guest asking for a shared buffer. In the virtwl
  // ABI the host backs the vfd with memory and returns the `pfn` (guest physical
  // frame) the guest mmaps. On this wasm32 NOMMU port "guest physical" is just a
  // byte offset into the single shared `memory.buffer`, so a pfn IS an offset
  // (>> PAGE_SHIFT). Once allocated, the host can hand Greenfield a live
  // `Uint8Array` VIEW over that region as the shm "fd" — Shm.ts createPool takes
  // the fd as a Uint8Array and reads pixels straight out of it, no copy.
  //
  // NOTE (open for 2c): the *ownership* of the backing region — whether the host
  // carves it from a reserved arena or the guest driver pre-allocates the pages
  // and passes the pfn in — depends on the kernel virtio_wl driver's NEW_ALLOC
  // contract (kernel pin 039e5f3e). The pfn↔offset↔view arithmetic below is the
  // resolution the design calls for; the registry handshake (M4) carries no fds,
  // so this path is wired-but-unexercised until the wl-eyes pixel path in 2c.

  /** Record the backing region for a NEW_ALLOC shm vfd.
   *  Returns { offset, size, pfn } or null.
   *
   *  Ownership (settled in 2c): the GUEST allocates the shm buffer in its own RAM
   *  (alloc_pages_exact in the patched virtio_wl driver) and reports
   *  virt_to_phys(buf)>>PAGE_SHIFT as the `pfn` in the NEW_ALLOC request. Because
   *  virt_to_phys is identity on this NOMMU port, that pfn<<PAGE_SHIFT IS the byte
   *  offset of the buffer inside the single shared WebAssembly.Memory — so the
   *  host just records it and views those exact bytes (no host allocation, no
   *  memory.grow, no injected device memory: the earlier host-arena attempt FAILED
   *  because nommu has no MMU to map injected device pages and the guest's mmap
   *  returned MAP_FAILED). See _resolveShmFd. */
  _allocShmRegion(vfdId, size, pfn) {
    if (!this._shmRegions) this._shmRegions = new Map();
    const offset = (pfn >>> 0) * 4096;
    const region = { offset, size: size >>> 0, pfn: pfn >>> 0, pending: false };
    this._shmRegions.set(vfdId, region);
    return region;
  }

  /** Resolve a shm vfd_id to a live Uint8Array VIEW over guest memory for
   *  Greenfield's `fds` array, or null if the region isn't backed yet. */
  _resolveShmFd(vfdId) {
    const ctx = this.contexts.get(vfdId);
    const region = ctx?.region || this._shmRegions?.get(vfdId);
    if (!region || !region.size) return null;
    const offset = region.offset || region.pfn * 4096;
    if (offset <= 0) {
      this.log(`[virtio-wl] shm vfd_id=${vfdId} has no backed offset yet (pfn=${region.pfn})`);
      return null;
    }
    try {
      // Re-view EACH time: memory.grow detaches the old ArrayBuffer, so a view
      // cached across a grow would be stale/zero-length. memory.buffer always
      // returns the current (shared) buffer.
      const view = new Uint8Array(this.memory.buffer, offset, region.size);
      // Instrumentation (2c shm proof): checksum the first row so the log shows
      // whether the host sees the guest's pixels (non-zero) or garbage/zeros.
      if (this._shmDebug) {
        let sum = 0;
        const n = Math.min(view.length, 360 * 4);
        for (let i = 0; i < n; i++) sum = (sum + view[i]) | 0;
        this.log(
          `[virtio-wl] shm vfd_id=${vfdId} view @0x${offset.toString(16)}+${region.size} ` +
            `firstRowSum=${sum >>> 0} head=${view[0]},${view[1]},${view[2]},${view[3]}`,
        );
      }
      return view;
    } catch (e) {
      this.log(`[virtio-wl] shm view failed for vfd_id=${vfdId} @${offset}+${region.size}: ${e}`);
      return null;
    }
  }

  /** Public: inject a server→client wayland message for a client (ctx vfd_id),
   *  delivered to the guest over the IN queue, raising the used-buffer IRQ to wake
   *  a parked guest. This is the SINGLE async host→guest path (Phase 4f): the
   *  main-thread Greenfield bridge calls it from `client.connection.onFlush` for
   *  EVERY server→client event — replies, xdg_surface.configure, wl_pointer.*,
   *  wl_keyboard.*, frame callbacks, wl_buffer.release. Decoupled from the OUT ack
   *  (which the worker sends synchronously); Wayland events are inherently async.
   *  @param {number} clientId  ctx vfd_id
   *  @param {Uint8Array|ArrayBuffer} data  the wire bytes
   *  @param {Uint8Array[]} [fds]  server→client fd payloads (e.g. the keymap),
   *    each materialized as a host→guest vfd (VFD_NEW host-id) referenced by a
   *    single VFD_RECV — the same wire contract the OUT path used to build. */
  injectIn(clientId, data, fds) {
    const id = clientId >>> 0;
    const bytes = data
      ? data instanceof Uint8Array
        ? data
        : new Uint8Array(data)
      : new Uint8Array(0);
    if (fds && fds.length) {
      for (const msg of this._buildFdDelivery(id, bytes, fds)) this._queueRaw(msg);
    } else {
      this._queueIn(id, bytes);
    }
    this._flushPendingIn();
  }

  /** Public: serve a guest VFD_SEND's wayland bytes through the in-process
   *  WlServer (the registry-handshake stub — no compositor) and inject the reply
   *  back over the IN queue. This is the host-side equivalent of the worker's
   *  Phase-1 WlServer fallback, used when NO external compositor bridge (Greenfield)
   *  is wired (the node smoke harness). It runs on the SAME host WlDevice that owns
   *  the IN vring + the raised_irqs self-wake, so the reply travels the real
   *  host→guest delivery path — making the node wl-handshake a true regression gate
   *  rather than a stub bypass. With a compositor bridge present this is never
   *  called (the host routes SENDs to the compositor instead).
   *  @param {number} clientId  ctx vfd_id the SEND came from
   *  @param {Uint8Array|ArrayBuffer} data  the client→server wire bytes */
  serveLocal(clientId, data) {
    const id = clientId >>> 0;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const server = this._serverFor(id);
    const reply = server.handle(bytes);
    if (reply.length) {
      this.log(`[virtio-wl] wl-server produced ${reply.length}B reply -> IN queue`);
      this.injectIn(id, reply);
    }
  }

  /** Public: flush any IN messages deferred for lack of a free guest inbuf. The
   *  host calls this when the guest refills the IN avail ring (a VQ_IN kick the
   *  worker forwards) — the host owns the IN vring but the kick lands on the
   *  worker. A no-op when nothing is pending. */
  flushIn() {
    this._flushPendingIn();
  }

  // virtio_wl_config is empty; nothing to serve.
  configRead(_offset, bytes) {
    bytes.fill(0);
  }

  onNotify(q) {
    if (q >>> 0 === VIRTWL_VQ_OUT) {
      this._serviceOut();
    } else if (q >>> 0 === VIRTWL_VQ_IN) {
      // Guest refilled the IN avail ring. With the Phase 4f bridge the HOST owns
      // IN delivery, so forward the refill to it (the kick lands on the worker but
      // the host's WlDevice holds the deferred queue). The local _pendingIn is only
      // used by the Phase-1 WlServer fallback (no bridge), so flush that directly.
      if (this._bridge && this._bridge.onInRefill) this._bridge.onInRefill();
      else this._flushPendingIn();
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
    // Wayland replies queued while servicing this batch; pushed to the IN queue
    // AFTER all OUT acks so the driver sees the SEND complete first.
    const inReplies = [];
    while ((chain = vr.next())) {
      const req = vr.readOut(chain); // the request bytes
      const { resp, inReply } = this._handle(req);
      // Write the OUT response (the ack) over the in_sg (capped to capacity).
      const written = vr.writeIn(chain, resp);
      vr.pushUsed(chain.head, written);
      serviced++;
      if (inReply) inReplies.push(inReply);
    }

    if (serviced > 0) this.raiseIrq();

    // Deliver any wayland server replies over the IN queue (a separate vring).
    // `inReply` is either { vfdId, data } (one VFD_RECV, the common case) or
    // { raw: [Uint8Array,...] } (pre-built control messages — VFD_NEW(s) then a
    // VFD_RECV carrying server→client fds, e.g. the keymap).
    for (const r of inReplies) {
      if (r.raw) for (const msg of r.raw) this._queueRaw(msg);
      else this._queueIn(r.vfdId, r.data);
    }
    this._flushPendingIn();
  }

  // --- host -> guest IN-queue push (the 1d extension point) -----------------
  //
  // Server->client wayland bytes are delivered as a VFD_RECV on the IN queue,
  // addressed to the same ctx vfd_id the SEND came from. The driver's
  // vq_handle_recv routes it to the ctx's read queue; waylandproxyd's
  // VIRTWL_IOCTL_RECV reads it and writes it to the client socket. The guest
  // prefills the IN queue with PAGE_SIZE write-only buffers; if none is free we
  // stash the reply and flush on the next IN refill notify.

  /** Pending {vfdId, data} replies awaiting a free IN buffer. */
  _pendingIn = [];

  _queueIn(vfdId, data) {
    this._pendingIn.push({ vfdId, data });
  }

  /** Queue a PRE-BUILT virtwl control message (already a full ctrl struct, e.g.
   *  a VFD_NEW or a VFD_RECV carrying fds) for the IN queue verbatim. */
  _queueRaw(msg) {
    this._pendingIn.push({ raw: msg });
  }

  _flushPendingIn() {
    if (this._pendingIn.length === 0) return;
    const vr = this.vring(VIRTWL_VQ_IN);
    if (!vr) {
      this.log(`[virtio-wl] IN push deferred: queue not set up yet`);
      return;
    }
    let pushed = 0;
    while (this._pendingIn.length > 0) {
      if (!vr.hasAvail()) {
        this.log(`[virtio-wl] IN push deferred: no free inbuf (${this._pendingIn.length} pending)`);
        break;
      }
      const chain = vr.next();
      if (!chain) break;
      const entry = this._pendingIn.shift();
      const { vfdId, data } = entry;
      const msg = entry.raw ? entry.raw : this._vfdRecv(vfdId, data);
      const cap = vr.inCapacity(chain);
      if (msg.length > cap) {
        this.log(`[virtio-wl] IN buffer too small (${cap} < ${msg.length}); truncating`);
      }
      const written = vr.writeIn(chain, msg);
      vr.pushUsed(chain.head, written);
      if (entry.raw) {
        const type = new DataView(msg.buffer, msg.byteOffset, msg.byteLength).getUint32(0, true);
        this.log(`[virtio-wl] IN push: raw ctrl type=0x${type.toString(16)} (used ${written}B)`);
      } else {
        this.log(
          `[virtio-wl] IN push: VFD_RECV vfd_id=${vfdId} ${data.length}B wayland (used ${written}B)`,
        );
      }
      if (!entry.raw && this._shmDebug && data.length <= 512) {
        const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const parts = [];
        for (let o = 0; o + 8 <= data.length; ) {
          const obj = ddv.getUint32(o, true);
          const so = ddv.getUint32(o + 4, true);
          parts.push(`obj=${obj} ev=${so & 0xffff} sz=${so >>> 16}`);
          if (so >>> 16 < 8) break;
          o += so >>> 16;
        }
        this.log(`[virtio-wl]   IN wire: ${parts.join(" | ")}`);
      }
      pushed++;
    }
    if (pushed > 0) this.raiseIrq();
  }

  /** Build a VFD_RECV control message: hdr(type,flags) + vfd_id + vfd_count(0)
   *  + raw wayland data. */
  _vfdRecv(vfdId, data) {
    const b = new Uint8Array(SEND_HDR_SIZE + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, VIRTIO_WL_CMD_VFD_RECV, true); // hdr.type
    dv.setUint32(4, 0, true); // hdr.flags
    dv.setUint32(8, vfdId >>> 0, true); // vfd_id
    dv.setUint32(12, 0, true); // vfd_count = 0 (no fds in the handshake)
    b.set(data, SEND_HDR_SIZE);
    return b;
  }

  // --- server→client fd delivery (the keymap path) -------------------------
  //
  // Greenfield ships some events with an fd (wl_keyboard.keymap carries the xkb
  // keymap). On a guest connection that fd must become a virtio_wl vfd the client
  // receives over SCM_RIGHTS. The protocol: emit a host→guest VFD_NEW for each fd
  // (registering it in the driver's idr under a HOST-bit id), then a VFD_RECV
  // whose trailing vfd ids reference them — vq_handle_recv queues it on the ctx
  // and the client's RECV ioctl surfaces the bytes + the new fds together. The
  // VFD_NEW we send has the keymap byte length as `size` so the client's mmap
  // length check passes; we do NOT inject a backing pfn (this NOMMU port has no
  // host-arena path), so the client's mmap of the keymap fails gracefully with
  // EACCES — which the toytoolkit keymap handler tolerates (it closes the fd and
  // continues; weston-flowers never uses the keyboard). That is enough to satisfy
  // the wire contract and unblock the attach/commit → flower render.

  /** Build the ordered [VFD_NEW..., VFD_RECV(bytes + vfd ids)] control messages
   *  for a server→client reply carrying fds. */
  _buildFdDelivery(ctxVfdId, bytes, fdPayloads) {
    const msgs = [];
    const ids = [];
    for (const payload of fdPayloads) {
      const id =
        (VFD_HOST_ID_BIT | (this._nextHostVfdId++ & ~(VFD_HOST_ID_BIT | VFD_ILLEGAL_SIGN_BIT))) >>>
        0;
      ids.push(id);
      msgs.push(this._vfdNewHost(id, payload.length));
    }
    msgs.push(this._vfdRecvWithFds(ctxVfdId, bytes || new Uint8Array(0), ids));
    return msgs;
  }

  /** A host→guest VFD_NEW (the driver's vq_handle_new registers the vfd). 32B
   *  through the union start: hdr + vfd_id + flags + pfn(u64) + size. */
  _vfdNewHost(id, size) {
    const b = new Uint8Array(32);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, VIRTIO_WL_CMD_VFD_NEW, true); // hdr.type
    dv.setUint32(4, 0, true); // hdr.flags
    dv.setUint32(8, id >>> 0, true); // vfd_id (HOST bit set)
    dv.setUint32(12, VIRTIO_WL_VFD_READ, true); // flags: client reads the keymap
    dv.setBigUint64(16, 0n, true); // pfn = 0 (no host backing; mmap fails gracefully)
    dv.setUint32(24, size >>> 0, true); // size = keymap byte length
    return b;
  }

  /** A VFD_RECV carrying bytes + trailing vfd ids (vfd_count = ids.length). */
  _vfdRecvWithFds(ctxVfdId, data, ids) {
    const b = new Uint8Array(SEND_HDR_SIZE + ids.length * 4 + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, VIRTIO_WL_CMD_VFD_RECV, true); // hdr.type
    dv.setUint32(4, 0, true); // hdr.flags
    dv.setUint32(8, ctxVfdId >>> 0, true); // vfd_id (the ctx)
    dv.setUint32(12, ids.length >>> 0, true); // vfd_count
    let off = SEND_HDR_SIZE;
    for (const id of ids) {
      dv.setUint32(off, id >>> 0, true);
      off += 4;
    }
    b.set(data, off);
    return b;
  }

  /**
   * Parse one virtwl OUT request. Returns { resp, inReply } where `resp` is the
   * bytes written back over the OUT in_sg (the ack the driver waits on) and
   * `inReply` (or null) is a wayland reply {vfdId, data} to push via the IN
   * queue. The guest's OUT response buffer is typically the same struct it sent,
   * so NEW_* return a full ctrl_vfd_new-sized reply, else a bare ctrl_hdr.
   */
  _handle(req) {
    if (req.length < HDR_SIZE)
      return { resp: this._hdr(VIRTIO_WL_RESP_INVALID_TYPE), inReply: null };
    const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
    const type = dv.getUint32(0, true);

    switch (type) {
      case VIRTIO_WL_CMD_VFD_NEW: {
        // VFD_NEW (NEW_ALLOC): a guest shm allocation. struct ctrl_vfd_new:
        //   hdr(8) + vfd_id(4) + flags(4) + pfn(u64) + size(u32).
        // The GUEST allocates the buffer in its own RAM and sends its physical
        // pfn (== linear-memory offset >> PAGE_SHIFT, virt_to_phys identity on
        // nommu) + size. We record the region over that offset and ECHO the pfn
        // back unchanged so the driver's vfd->pfn stays correct (do NOT overwrite
        // it with a host-chosen value — that broke the mmap). See _allocShmRegion.
        const vfdId = req.length >= 12 ? dv.getUint32(8, true) : 0;
        const flags = req.length >= 16 ? dv.getUint32(12, true) : 0;
        const pfn = req.length >= 24 ? Number(dv.getBigUint64(16, true)) : 0;
        const size = req.length >= 28 ? dv.getUint32(24, true) : 0;
        const region = size > 0 && pfn > 0 ? this._allocShmRegion(vfdId, size, pfn) : null;
        this.contexts.set(vfdId, { type, flags, size, region });
        this.log(
          `[virtio-wl] NEW_ALLOC vfd_id=${vfdId} size=${size}` +
            (region
              ? ` guest pfn=${region.pfn} (offset 0x${region.offset.toString(16)})`
              : ` (no region: pfn=${pfn})`) +
            ` -> RESP_VFD_NEW`,
        );
        return {
          resp: this._vfdNew(
            vfdId,
            /*size*/ region ? region.size : size,
            /*pfn*/ BigInt(pfn),
            flags || VIRTIO_WL_VFD_WRITE | VIRTIO_WL_VFD_READ,
          ),
          inReply: null,
        };
      }
      case VIRTIO_WL_CMD_VFD_NEW_CTX:
      case VIRTIO_WL_CMD_VFD_NEW_CTX_NAMED:
      case VIRTIO_WL_CMD_VFD_NEW_PIPE: {
        const vfdId = req.length >= 12 ? dv.getUint32(8, true) : 0;
        this.contexts.set(vfdId, { type });
        this.log(`[virtio-wl] NEW (type=0x${type.toString(16)}) vfd_id=${vfdId} -> RESP_VFD_NEW`);
        return {
          resp: this._vfdNew(
            vfdId,
            /*size*/ 0,
            /*pfn*/ 0n,
            VIRTIO_WL_VFD_WRITE | VIRTIO_WL_VFD_READ,
          ),
          inReply: null,
        };
      }
      case VIRTIO_WL_CMD_VFD_CLOSE: {
        const vfdId = req.length >= 12 ? dv.getUint32(8, true) : 0;
        this.contexts.delete(vfdId);
        this.log(`[virtio-wl] CLOSE vfd_id=${vfdId} -> RESP_OK`);
        // Tell the host bridge the guest closed this ctx — e.g. waylandproxyd
        // closing a client's virtwl ctx after that Wayland client exited. The
        // compositor uses it to tear down the matching server-side client now,
        // instead of leaking it (and pumping events to a dead ctx) until a
        // timeout. Fire-and-forget; harmless when no bridge is wired.
        this._bridge?.onClose?.(vfdId);
        return { resp: this._hdr(VIRTIO_WL_RESP_OK), inReply: null };
      }
      case VIRTIO_WL_CMD_VFD_SEND: {
        // ctrl_vfd_send: hdr(8) + vfd_id(4) + vfd_count(4) + [vfd ids] + data.
        const vfdId = dv.getUint32(8, true);
        const vfdCount = dv.getUint32(12, true);
        const dataOff = SEND_HDR_SIZE + vfdCount * 4;
        // Trailing vfd ids (Phase 2 / M3: a wl_shm_create_pool carries the shm
        // vfd here). Resolve each to a host fd surrogate (a Uint8Array VIEW over
        // the guest memory region the vfd backs) for Greenfield's `fds` array.
        const fds = [];
        for (let i = 0; i < vfdCount; i++) {
          const fdVfdId = dv.getUint32(SEND_HDR_SIZE + i * 4, true);
          const fd = this._resolveShmFd(fdVfdId);
          if (fd) fds.push(fd);
          else this.log(`[virtio-wl] SEND carried vfd_id=${fdVfdId} with no resolvable shm region`);
        }
        const data = req.subarray(dataOff);
        this.log(`[virtio-wl] SEND vfd_id=${vfdId} ${data.length}B wayland (${vfdCount} fds)`);
        if (this._shmDebug && data.length <= 512) {
          const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const parts = [];
          for (let o = 0; o + 8 <= data.length; ) {
            const obj = ddv.getUint32(o, true);
            const so = ddv.getUint32(o + 4, true);
            const op = so & 0xffff;
            const sz = so >>> 16;
            parts.push(`obj=${obj} op=${op} sz=${sz}`);
            if (sz < 8) break;
            o += sz;
          }
          this.log(`[virtio-wl]   wire: ${parts.join(" | ")}`);
        }
        if (this._bridge) {
          // Phase 4f: route OUT to the host → main-thread Greenfield, FIRE-AND-
          // FORGET. The guest's SEND completes on the OUT ack returned below
          // (RESP_OK); the server→client response — replies, xdg_surface.configure,
          // wl_pointer/keyboard events, frame callbacks, the keymap fd — arrives
          // LATER, asynchronously, over the IN queue via the host's
          // pushIn → host-WlDevice.injectIn.
          //
          // This replaces the old synchronous SAB round-trip. That round-trip only
          // existed because a parked worker couldn't service an async IN delivery;
          // the self-wake IN path (host writes the IN vring + raises the IRQ on
          // raised_irqs directly) removed that constraint. Wayland events are
          // inherently async — the client never blocks on its own request, it reads
          // responses later from its event loop — so delivering them synchronously
          // as "the reply to this SEND" was a category error: any event that fired
          // after the round-trip's deferred-flush window (notably steady-state
          // frame callbacks) was written to an already-closed reply slot and lost,
          // stalling animation. Single producer per direction now: the worker owns
          // OUT (this synchronous ack), the host owns IN (all async events).
          this._bridge.sendOut(vfdId, data.slice(), fds);
          return { resp: this._hdr(VIRTIO_WL_RESP_OK), inReply: null };
        }
        // Phase 1 fallback: the in-worker WlServer stub (registry handshake).
        const server = this._serverFor(vfdId);
        const reply = server.handle(data);
        const inReply = reply.length ? { vfdId, data: reply } : null;
        if (inReply) this.log(`[virtio-wl] wl-server produced ${reply.length}B reply -> IN queue`);
        // Ack the SEND itself over OUT (the driver's finish_completion).
        return { resp: this._hdr(VIRTIO_WL_RESP_OK), inReply };
      }
      default:
        this.log(`[virtio-wl] unhandled type 0x${type.toString(16)} -> INVALID_TYPE`);
        return { resp: this._hdr(VIRTIO_WL_RESP_INVALID_TYPE), inReply: null };
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
