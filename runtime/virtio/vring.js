// vring.js — split-virtqueue accessor for the `virtio_wasm` transport
// (Linux/Wasm, "pc" Wayland Phase 1). Factored out of the 1a echo spike so the
// echo device and the virtio-wl device share one correct vring implementation.
//
// No DMA: the guest transport withholds VIRTIO_F_ACCESS_PLATFORM, so the vring
// desc/avail/used "dma" addresses are raw WebAssembly.Memory byte offsets (nommu
// virt_to_phys is identity). We index `memory.buffer` directly at those offsets.
//
// Split vring layout (virtio 1.x, little-endian):
//   desc[num]: each 16 bytes — u64 addr, u32 len, u16 flags, u16 next
//   avail:     u16 flags, u16 idx, u16 ring[num], (u16 used_event)
//   used:      u16 flags, u16 idx, { u32 id, u32 len } ring[num], (u16 avail_event)

export const VRING_DESC_F_NEXT = 1;
export const VRING_DESC_F_WRITE = 2;

/**
 * One split virtqueue the host services. Wraps the desc/avail/used offsets the
 * guest passed via wasm_virtio_setup_queue and tracks the host-side avail index.
 */
export class Vring {
  /**
   * @param {WebAssembly.Memory} memory  shared kernel memory (buffer may detach on grow)
   * @param {{desc:number, avail:number, used:number, num:number}} layout
   * @param {{load:()=>number, store:(v:number)=>void}} [cursor]
   *   external host-side avail cursor (shared across workers); defaults to a
   *   per-instance counter.
   */
  constructor(memory, layout, cursor) {
    this.memory = memory;
    this.desc = layout.desc;
    this.avail = layout.avail;
    this.used = layout.used;
    this.num = layout.num;
    if (cursor) {
      Object.defineProperty(this, "lastAvail", {
        get: () => cursor.load(),
        set: (v) => cursor.store(v),
      });
    } else {
      this.lastAvail = 0; // host-side index into the avail ring
    }
  }

  // Re-fetch the DataView: memory.buffer detaches when the wasm memory grows.
  _dv() {
    return new DataView(this.memory.buffer);
  }

  /** Read avail.idx (the guest's producer index). */
  availIdx() {
    return this._dv().getUint16(this.avail + 2, true);
  }

  /** Whether the guest has exposed buffers the host hasn't taken yet. */
  hasAvail() {
    return this.lastAvail !== this.availIdx();
  }

  /**
   * Pop the next available descriptor chain. Returns { head, out, in } where
   * out/in are arrays of {addr,len} readable/writable segments, or null if none.
   */
  next() {
    const v = this._dv();
    if (this.lastAvail === v.getUint16(this.avail + 2, true)) return null;

    const ringSlot = this.lastAvail % this.num;
    const head = v.getUint16(this.avail + 4 + ringSlot * 2, true);
    const { out, in: in_ } = this._readChain(head);
    this.lastAvail = (this.lastAvail + 1) & 0xffff;
    return { head, out, in: in_ };
  }

  _readChain(head) {
    const v = this._dv();
    const out = [];
    const in_ = [];
    let i = head;
    for (let guard = 0; guard <= this.num; guard++) {
      const d = this.desc + i * 16;
      const addr = Number(v.getBigUint64(d, true));
      const len = v.getUint32(d + 8, true);
      const flags = v.getUint16(d + 12, true);
      const next = v.getUint16(d + 14, true);
      (flags & VRING_DESC_F_WRITE ? in_ : out).push({ addr, len });
      if (!(flags & VRING_DESC_F_NEXT)) return { out, in: in_ };
      i = next;
    }
    throw new Error("[vring] descriptor chain too long (corrupt vring?)");
  }

  /** Read a chain's readable (out) segments as one flat Uint8Array. */
  readOut(chain) {
    const v = this._dv();
    let total = 0;
    for (const s of chain.out) total += s.len;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const s of chain.out) {
      for (let b = 0; b < s.len; b++) buf[off++] = v.getUint8(s.addr + b);
    }
    return buf;
  }

  /**
   * Write `bytes` into a chain's writable (in) segments, truncating to the
   * available writable space. Returns the number of bytes written.
   */
  writeIn(chain, bytes) {
    const v = this._dv();
    let si = 0;
    for (const s of chain.in) {
      for (let b = 0; b < s.len && si < bytes.length; b++) {
        v.setUint8(s.addr + b, bytes[si++]);
      }
      if (si >= bytes.length) break;
    }
    return si;
  }

  /** Total writable byte capacity of a chain. */
  inCapacity(chain) {
    let n = 0;
    for (const s of chain.in) n += s.len;
    return n;
  }

  /** Publish a used-buffer: used.ring[idx % num] = {id: head, len}; used.idx++. */
  pushUsed(head, len) {
    const u = this._dv();
    const usedIdx = u.getUint16(this.used + 2, true);
    const slot = usedIdx % this.num;
    const elem = this.used + 4 + slot * 8;
    u.setUint32(elem, head, true); // id
    u.setUint32(elem + 4, len, true); // len
    // Single-threaded worker: writes are already ordered before the idx bump.
    u.setUint16(this.used + 2, (usedIdx + 1) & 0xffff, true);
  }
}
