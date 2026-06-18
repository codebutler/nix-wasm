// echo-device.js — the JS host side of the minimal `virtio_wasm` transport
// (Linux/Wasm, "pc" Wayland Phase 1 sub-step 1a — the de-risking spike).
//
// The guest kernel's drivers/virtio/virtio_wasm.c registers one virtio device
// with a single split virtqueue and an in-kernel echo self-test driver. This
// module is the matching host device model. It is intentionally tiny: it proves
// the guest<->host vring round-trip and the host->guest used-buffer interrupt.
//
// No DMA: the transport withholds VIRTIO_F_ACCESS_PLATFORM, so vring desc/avail/
// used "dma" addresses are raw WebAssembly.Memory byte offsets (nommu
// virt_to_phys is identity). We index instance.exports.memory.buffer directly.
//
// Split vring layout (virtio 1.x, little-endian), all at the offsets the guest
// passed us via wasm_virtio_setup_queue(q, desc, avail, used, num):
//
//   desc[num]: each 16 bytes — u64 addr, u32 len, u16 flags, u16 next
//   avail:     u16 flags, u16 idx, u16 ring[num], (u16 used_event)
//   used:      u16 flags, u16 idx, struct { u32 id, u32 len } ring[num], ...
//
// VRING_DESC_F_NEXT = 1, VRING_DESC_F_WRITE = 2.

const VRING_DESC_F_NEXT = 1;
const VRING_DESC_F_WRITE = 2;

/**
 * Build the echo virtio device model.
 *
 * @param {object} opts
 * @param {WebAssembly.Memory} opts.memory  the shared kernel memory
 * @param {(cpu:number, irq:number)=>void} opts.raiseInterrupt  guest export
 * @param {number} [opts.irqCpu]  CPU whose idle loop dispatches the irq (IRQ_CPU=1)
 * @param {number} [opts.irq]     irq number the guest request_irq()'d (8)
 * @param {(s:string)=>void} [opts.log]
 * @returns {{ setupQueue: Function, notify: Function }}
 */
export function makeEchoDevice({ memory, raiseInterrupt, irqCpu = 1, irq = 8, log = () => {} }) {
  // Per-queue state: vring offsets + the host's "last seen avail idx".
  const queues = new Map();

  const dv = () => new DataView(memory.buffer); // re-fetch: buffer detaches on grow

  const setupQueue = (q, desc, avail, used, num) => {
    queues.set(q >>> 0, {
      desc: Number(desc),
      avail: Number(avail),
      used: Number(used),
      num: Number(num),
      lastAvail: 0, // host-side index into the avail ring
    });
    log(`[virtio-echo] setup q=${q} desc=${desc} avail=${avail} used=${used} num=${num}`);
  };

  // Walk one descriptor chain starting at head: collect readable (out) and
  // writable (in) segments as {addr,len}.
  const readChain = (st, head) => {
    const v = dv();
    const out = [];
    const in_ = [];
    let i = head;
    // Bound the walk by ring size to avoid a corrupt-chain infinite loop.
    for (let guard = 0; guard <= st.num; guard++) {
      const d = st.desc + i * 16;
      const addr = Number(v.getBigUint64(d, true));
      const len = v.getUint32(d + 8, true);
      const flags = v.getUint16(d + 12, true);
      const next = v.getUint16(d + 14, true);
      (flags & VRING_DESC_F_WRITE ? in_ : out).push({ addr, len });
      if (!(flags & VRING_DESC_F_NEXT)) return { out, in_ };
      i = next;
    }
    throw new Error("[virtio-echo] descriptor chain too long (corrupt vring?)");
  };

  // Service every newly-available descriptor on queue q, then raise the irq.
  const notify = (q) => {
    const st = queues.get(q >>> 0);
    if (!st) {
      log(`[virtio-echo] notify for unknown queue ${q}`);
      return;
    }

    let v = dv();
    const availIdx = v.getUint16(st.avail + 2, true); // avail.idx
    let serviced = 0;

    while (st.lastAvail !== availIdx) {
      const ringSlot = st.lastAvail % st.num;
      const head = v.getUint16(st.avail + 4 + ringSlot * 2, true); // avail.ring[slot]

      const { out, in_ } = readChain(st, head);
      log(`[virtio-echo] notify q=${q} head=${head} out=${out.length} in=${in_.length}`);

      // ECHO: read the guest's out-buffer(s) as a flat byte stream and write the
      // bitwise-inverse into the in-buffer(s). The test driver sends one u32 and
      // expects ~u32 back, so the inverse is a content-sensitive proof that the
      // host read the guest's bytes AND the guest reads the host's reply.
      v = dv();
      const src = [];
      for (const s of out) for (let b = 0; b < s.len; b++) src.push(v.getUint8(s.addr + b));

      let written = 0;
      let si = 0;
      for (const s of in_) {
        for (let b = 0; b < s.len; b++) {
          const byte = si < src.length ? src[si] ^ 0xff : 0;
          v.setUint8(s.addr + b, byte);
          si++;
          written++;
        }
      }
      if (out[0]) {
        const tx = v.getUint32(out[0].addr, true);
        log(`[virtio-echo] echoed ~tx: tx=0x${tx.toString(16)} wrote ${written} bytes`);
      }

      // Advance the USED ring: used.ring[used.idx % num] = {id: head, len: written}
      let u = dv();
      const usedIdx = u.getUint16(st.used + 2, true);
      const slot = usedIdx % st.num;
      const elem = st.used + 4 + slot * 8;
      u.setUint32(elem, head, true); // id
      u.setUint32(elem + 4, written, true); // len
      // A barrier before bumping used.idx is what a real device needs; in this
      // single-threaded worker the writes are already ordered.
      u.setUint16(st.used + 2, (usedIdx + 1) & 0xffff, true); // used.idx++

      st.lastAvail = (st.lastAvail + 1) & 0xffff;
      serviced++;
    }

    if (serviced > 0) {
      // THE CRUX: deliver the used-buffer interrupt back into the guest. The
      // host writes the bit into IRQ_CPU's raised_irqs and memory.atomic.notify's
      // its idle loop; the idle loop dispatches handle_simple_irq -> our irq
      // handler -> vring_interrupt -> the vq callback.
      log(`[virtio-echo] serviced ${serviced}; raise_interrupt(cpu=${irqCpu}, irq=${irq})`);
      raiseInterrupt(irqCpu, irq);
    }
  };

  return { setupQueue, notify };
}
