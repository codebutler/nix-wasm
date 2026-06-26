// shared-queues.js — cross-worker storage for virtio_wasm queue layouts
// (Linux/Wasm, "pc" Wayland Phase 1 1b).
//
// WHY: each task/CPU runs in its own Worker with its own kernel-worker.js module
// instance (its own device models). But the guest sets a queue up ONCE (on the
// boot worker, via wasm_virtio_setup_queue) and may KICK it later from a DIFFERENT
// worker (a userspace task on another worker servicing an ioctl). The vring bytes
// live in the shared WebAssembly.Memory, but the per-(dev,q) JS layout (desc/avail/
// used offsets, ring size) and the host-side avail cursor do NOT — they were only
// recorded in the boot worker. This mirrors 9P's problem, solved the same way: a
// small SharedArrayBuffer threaded into every worker via the init message, so any
// worker can reconstruct a queue's layout and share the avail cursor.
//
// Slot layout (one per (dev,q)), 9 x int32:
//   [0] desc_lo  [1] desc_hi  [2] avail_lo  [3] avail_hi
//   [4] used_lo  [5] used_hi  [6] num       [7] lastAvail (Atomics)  [8] valid

const SLOT_WORDS = 9;
// Device-index capacity of the cross-worker table. Must cover every VW_DEV_*
// the transport registers: WL=0, ECHO=1, NET=2, BLK=3, the virtio-9p channels
// 9P_ROOT=4 / 9P_NIXCACHE=5, VSOCK=7, and the issue-#83 block of CONSOLE_DEVICES=8
// single-port virtio-console devices at indices 8..15 (CONSOLE_BASE=8). 16 covers
// indices 0..15.
const MAX_DEVS = 16;
// Per-device queue capacity. A single-port virtio-console uses 2 vqs (rx/tx);
// virtio-vsock uses 3 (rx/tx/event), the ceiling here. 4 is a small safety
// margin. The SAB is MAX_DEVS*MAX_QS*9*4 bytes (2304 B at 16×4), threaded into
// every worker.
const MAX_QS = 4;
const TOTAL_WORDS = MAX_DEVS * MAX_QS * SLOT_WORDS;

export const VIRTIO_QUEUES_BYTES = TOTAL_WORDS * 4;

/** Allocate the shared queue-layout buffer (runtime/boot.js owns one). */
export function makeSharedQueues() {
  return new SharedArrayBuffer(VIRTIO_QUEUES_BYTES);
}

function slotBase(dev, q) {
  if (dev >= MAX_DEVS || q >= MAX_QS) {
    throw new Error(`[virtio] (dev=${dev},q=${q}) exceeds shared-queue table`);
  }
  return (dev * MAX_QS + q) * SLOT_WORDS;
}

/** Cross-worker view over a virtio queues SAB. */
export class SharedQueues {
  /** @param {SharedArrayBuffer} sab */
  constructor(sab) {
    this.i32 = new Int32Array(sab);
  }

  /** Record a queue's vring layout (called from setupQueue, any worker). */
  set(dev, q, desc, avail, used, num) {
    const b = slotBase(dev, q);
    const i = this.i32;
    i[b + 0] = Number(desc) & 0xffffffff;
    i[b + 1] = Math.floor(Number(desc) / 0x100000000);
    i[b + 2] = Number(avail) & 0xffffffff;
    i[b + 3] = Math.floor(Number(avail) / 0x100000000);
    i[b + 4] = Number(used) & 0xffffffff;
    i[b + 5] = Math.floor(Number(used) / 0x100000000);
    i[b + 6] = Number(num);
    Atomics.store(i, b + 7, 0); // reset host avail cursor
    Atomics.store(i, b + 8, 1); // valid
  }

  /** Whether a queue has been set up (in any worker). */
  has(dev, q) {
    return Atomics.load(this.i32, slotBase(dev, q) + 8) === 1;
  }

  /** Read a queue's layout, or null if not set up. */
  get(dev, q) {
    const b = slotBase(dev, q);
    if (Atomics.load(this.i32, b + 8) !== 1) return null;
    const i = this.i32;
    const u32 = (lo, hi) => (i[lo] >>> 0) + (i[hi] >>> 0) * 0x100000000;
    return {
      desc: u32(b + 0, b + 1),
      avail: u32(b + 2, b + 3),
      used: u32(b + 4, b + 5),
      num: i[b + 6],
    };
  }

  /** Read the shared host-side avail cursor. */
  loadLastAvail(dev, q) {
    return Atomics.load(this.i32, slotBase(dev, q) + 7) & 0xffff;
  }

  /** Store the shared host-side avail cursor. */
  storeLastAvail(dev, q, v) {
    Atomics.store(this.i32, slotBase(dev, q) + 7, v & 0xffff);
  }

  /** Forget a queue (reset). */
  clear(dev, q) {
    const b = slotBase(dev, q);
    Atomics.store(this.i32, b + 8, 0);
    Atomics.store(this.i32, b + 7, 0);
  }
}
