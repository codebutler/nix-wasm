// ring.js — the kernel↔JS shared-memory contract for the `trans_cb` 9P
// transport (docs/linux.md §9.2). One SharedArrayBuffer, pinned at boot, that
// the kernel's `trans_cb.request()` and the JS 9P-server worker both map. This
// is the *only* struct both sides hardcode; the kernel C (`trans_cb.h`) mirrors
// the same offsets.
//
// It's the V2 analogue of V1's single-slot futex (js/kernel/wasi/futex.js), but
// with N slots + a doorbell so the kernel's many task-workers (one per process,
// §7) issue concurrent 9P requests without serialising on one channel. Each
// request slot is paired with a reply slot of the same index — the transport
// channel — while the 9P `tag` (carried in the frame) multiplexes at the
// protocol layer. (A PoC simplification of the doc's "reply slot per tag":
// slots are bounded and the kernel knows its own slot index to block on.)
//
//   layout (little-endian, 4-byte aligned):
//     header: i32[doorbell, nslots, msize, _rsvd]
//     request[i]: i32[state, tag, len, cid] · u8 payload[msize]
//     reply[i]:   i32[ready, len]            · u8 payload[msize]
//
// `cid` is the connection id (which guest mount issued the request) — the
// kernel's trans_cb passes it through the wasm_driver_9p_request import so the
// JS server can keep per-connection 9P state (msize + fid namespace) when
// several mounts share this one ring (Phase E/N1, docs/linux.md §9.3).
//
//   hot path (one request):
//     kernel: claim FREE slot → write frame → state=FILLED → doorbell++/notify
//             → Atomics.wait(reply.ready)        ── blocks (one worker per task)
//     server: wake on doorbell → scan FILLED → state=INFLIGHT → handle()
//             → write reply → ready=1/notify
//     kernel: wake → read reply → state=FREE      (client frees; see below)
//
// The client frees the slot (state→FREE) only *after* reading its reply, so a
// fresh claimant can't overwrite the reply payload before it's consumed.

// Slot state machine.
const FREE = 0;
const CLAIMED = 1; // kernel owns it, mid-write (not yet visible to server)
const FILLED = 2; // request published; server may claim
const INFLIGHT = 3; // server claimed; handler running

// Header word indices.
const H_DOORBELL = 0;
const H_NSLOTS = 1;
const H_MSIZE = 2;
const HEADER_WORDS = 4;

// Per-slot header words.
const REQ_STATE = 0;
const REQ_TAG = 1;
const REQ_LEN = 2;
const REQ_CID = 3; // connection id (which guest mount) — per-connection 9P state
const REQ_HDR_WORDS = 4;
const REP_READY = 0;
const REP_LEN = 1;
const REP_HDR_WORDS = 2;

const align4 = (n) => (n + 3) & ~3;

export class Ring {
  /**
   * Wrap an existing buffer (the server worker attaches the kernel's memory
   * this way). Reads nslots/msize from the header.
   * @param {SharedArrayBuffer|ArrayBuffer} buffer
   */
  constructor(buffer) {
    this.buffer = buffer;
    this.i32 = new Int32Array(buffer);
    this.u8 = new Uint8Array(buffer);
    this.nslots = this.i32[H_NSLOTS];
    this.msize = this.i32[H_MSIZE];
    const am = align4(this.msize);
    this._reqStride = REQ_HDR_WORDS * 4 + am; // bytes
    this._repStride = REP_HDR_WORDS * 4 + am;
    this._reqBase = HEADER_WORDS * 4;
    this._repBase = this._reqBase + this.nslots * this._reqStride;
  }

  /** Total bytes a ring of (nslots, msize) needs. */
  static bytes(nslots, msize) {
    const am = align4(msize);
    return HEADER_WORDS * 4 + nslots * (REQ_HDR_WORDS * 4 + am + REP_HDR_WORDS * 4 + am);
  }

  /** Allocate a fresh shared ring and stamp its header. */
  static create(nslots = 8, msize = 65536) {
    const sab = new SharedArrayBuffer(Ring.bytes(nslots, msize));
    const i32 = new Int32Array(sab);
    i32[H_DOORBELL] = 0;
    i32[H_NSLOTS] = nslots;
    i32[H_MSIZE] = msize;
    return new Ring(sab);
  }

  static attach(buffer) {
    return new Ring(buffer);
  }

  // ── offset helpers (i32 element indices) ──────────────────────────────
  _reqWord(i, w) {
    return ((this._reqBase + i * this._reqStride) >> 2) + w;
  }
  _repWord(i, w) {
    return ((this._repBase + i * this._repStride) >> 2) + w;
  }
  _reqPayload(i) {
    return this._reqBase + i * this._reqStride + REQ_HDR_WORDS * 4;
  }
  _repPayload(i) {
    return this._repBase + i * this._repStride + REP_HDR_WORDS * 4;
  }

  // ── kernel (client) side ──────────────────────────────────────────────

  /** Claim a FREE slot → its index, or -1 if the ring is full. */
  _claim() {
    for (let i = 0; i < this.nslots; i++) {
      if (Atomics.compareExchange(this.i32, this._reqWord(i, REQ_STATE), FREE, CLAIMED) === FREE) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Post a request frame into a claimed slot and ring the doorbell — WITHOUT
   * blocking. Returns the slot index (for clientPoll / clientWaitReply).
   * @param {Uint8Array} frame a full 9P request frame (carries its own tag)
   * @param {number} [cid] connection id (which guest mount); 0 if unspecified
   */
  clientPost(frame, cid = 0) {
    if (frame.length > this.msize)
      throw new Error("9p ring: frame " + frame.length + " > msize " + this.msize);
    const i = this._claim();
    if (i < 0) throw new Error("9p ring: no free slot");
    this.u8.set(frame, this._reqPayload(i));
    const tag = frame.length >= 7 ? frame[5] | (frame[6] << 8) : 0;
    Atomics.store(this.i32, this._reqWord(i, REQ_TAG), tag);
    Atomics.store(this.i32, this._reqWord(i, REQ_LEN), frame.length);
    Atomics.store(this.i32, this._reqWord(i, REQ_CID), cid | 0);
    Atomics.store(this.i32, this._repWord(i, REP_READY), 0); // arm reply
    // Publish (release): everything above is visible once state reads FILLED.
    Atomics.store(this.i32, this._reqWord(i, REQ_STATE), FILLED);
    Atomics.add(this.i32, H_DOORBELL, 1);
    Atomics.notify(this.i32, H_DOORBELL);
    return i;
  }

  /** Non-blocking: return the reply bytes if ready (freeing the slot), else null. */
  clientPoll(i) {
    if (Atomics.load(this.i32, this._repWord(i, REP_READY)) !== 1) return null;
    return this._takeReply(i);
  }

  /** Block the calling thread until slot `i`'s reply is ready. */
  clientWaitReply(i) {
    const idx = this._repWord(i, REP_READY);
    while (Atomics.load(this.i32, idx) === 0) {
      Atomics.wait(this.i32, idx, 0, 5000);
    }
  }

  _takeReply(i) {
    const len = Atomics.load(this.i32, this._repWord(i, REP_LEN));
    const reply = this.u8.slice(this._repPayload(i), this._repPayload(i) + len);
    // Free the slot only now — after reading the reply — so a new claimant
    // can't clobber the reply payload mid-read.
    Atomics.store(this.i32, this._reqWord(i, REQ_STATE), FREE);
    return reply;
  }

  /** One blocking request→reply round-trip (the `trans_cb.request` analogue). */
  clientRequest(frame, cid = 0) {
    const i = this.clientPost(frame, cid);
    this.clientWaitReply(i);
    return this._takeReply(i);
  }

  // ── server side ───────────────────────────────────────────────────────

  doorbell() {
    return Atomics.load(this.i32, H_DOORBELL);
  }

  /** Wait (async) until the doorbell advances past `prev`. */
  waitDoorbell(prev, timeout = 1000) {
    return Atomics.waitAsync(this.i32, H_DOORBELL, prev, timeout);
  }

  /** Claim every FILLED slot (FILLED→INFLIGHT) → their indices. */
  serverScan() {
    const out = [];
    for (let i = 0; i < this.nslots; i++) {
      if (
        Atomics.compareExchange(this.i32, this._reqWord(i, REQ_STATE), FILLED, INFLIGHT) === FILLED
      ) {
        out.push(i);
      }
    }
    return out;
  }

  /** Read the request frame out of an INFLIGHT slot. */
  serverReadRequest(i) {
    const len = Atomics.load(this.i32, this._reqWord(i, REQ_LEN));
    return this.u8.slice(this._reqPayload(i), this._reqPayload(i) + len);
  }

  /** Read the connection id (which guest mount) of an INFLIGHT slot. */
  serverReadCid(i) {
    return Atomics.load(this.i32, this._reqWord(i, REQ_CID));
  }

  /**
   * Write a reply into slot `i` and wake the blocked client. Leaves the slot
   * INFLIGHT — the client frees it once it's read the reply.
   * @param {number} i @param {Uint8Array} reply
   */
  serverWriteReply(i, reply) {
    const n = Math.min(reply.length, this.msize);
    this.u8.set(reply.subarray(0, n), this._repPayload(i));
    Atomics.store(this.i32, this._repWord(i, REP_LEN), n);
    Atomics.store(this.i32, this._repWord(i, REP_READY), 1); // release
    Atomics.notify(this.i32, this._repWord(i, REP_READY));
  }
}
