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

/** A queue's split-vring byte offsets in linear memory, and its ring size. */
export interface VringLayout {
  desc: number;
  avail: number;
  used: number;
  num: number;
}

/** External host-side avail cursor (shared across workers). */
export interface VringCursor {
  load: () => number;
  store: (v: number) => void;
}

/** One descriptor's buffer: a linear-memory byte offset and length. */
export interface VringSegment {
  addr: number;
  len: number;
}

/** A popped descriptor chain: its head index and readable/writable segments. */
export interface VringChain {
  head: number;
  /** readable (device-read) segments */
  out: VringSegment[];
  /** writable (device-write) segments */
  in: VringSegment[];
}

/**
 * One split virtqueue the host services. Wraps the desc/avail/used offsets the
 * guest passed via wasm_virtio_setup_queue and tracks the host-side avail index.
 */
export class Vring {
  memory: WebAssembly.Memory;
  desc: number;
  avail: number;
  used: number;
  num: number;
  /** Host-side index into the avail ring (backed by `cursor` when given). */
  lastAvail: number;

  /**
   * @param memory  shared kernel memory (buffer may detach on grow)
   * @param layout
   * @param cursor
   *   external host-side avail cursor (shared across workers); defaults to a
   *   per-instance counter.
   */
  constructor(memory: WebAssembly.Memory, layout: VringLayout, cursor?: VringCursor) {
    this.memory = memory;
    this.desc = layout.desc;
    this.avail = layout.avail;
    this.used = layout.used;
    this.num = layout.num;
    if (cursor) {
      Object.defineProperty(this, "lastAvail", {
        get: () => cursor.load(),
        set: (v: number) => cursor.store(v),
      });
    } else {
      this.lastAvail = 0; // host-side index into the avail ring
    }
  }

  // Re-fetch the DataView: memory.buffer detaches when the wasm memory grows.
  _dv(): DataView {
    return new DataView(this.memory.buffer);
  }

  /** Read avail.idx (the guest's producer index). */
  availIdx(): number {
    return this._dv().getUint16(this.avail + 2, true);
  }

  /** Whether the guest has exposed buffers the host hasn't taken yet. */
  hasAvail(): boolean {
    return this.lastAvail !== this.availIdx();
  }

  /**
   * Pop the next available descriptor chain. Returns { head, out, in } where
   * out/in are arrays of {addr,len} readable/writable segments, or null if none.
   */
  next(): VringChain | null {
    const v = this._dv();
    if (this.lastAvail === v.getUint16(this.avail + 2, true)) return null;

    const ringSlot = this.lastAvail % this.num;
    const head = v.getUint16(this.avail + 4 + ringSlot * 2, true);
    const { out, in: in_ } = this._readChain(head);
    this.lastAvail = (this.lastAvail + 1) & 0xffff;
    return { head, out, in: in_ };
  }

  _readChain(head: number): { out: VringSegment[]; in: VringSegment[] } {
    const v = this._dv();
    const out: VringSegment[] = [];
    const in_: VringSegment[] = [];
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
  readOut(chain: VringChain): Uint8Array {
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
  writeIn(chain: VringChain, bytes: ArrayLike<number>): number {
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
  inCapacity(chain: VringChain): number {
    let n = 0;
    for (const s of chain.in) n += s.len;
    return n;
  }

  /** Publish a used-buffer: used.ring[idx % num] = {id: head, len}; used.idx++. */
  pushUsed(head: number, len: number): void {
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
