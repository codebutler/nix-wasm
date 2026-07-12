import { describe, it, expect } from "bun:test";
import {
  SndVirtioDevice,
  SND_VQ_CONTROL,
  SND_VQ_EVENT,
  SND_VQ_TX,
  VIRTIO_SND_R_PCM_INFO,
  VIRTIO_SND_R_PCM_SET_PARAMS,
  VIRTIO_SND_R_PCM_PREPARE,
  VIRTIO_SND_R_PCM_RELEASE,
  VIRTIO_SND_R_PCM_START,
  VIRTIO_SND_R_PCM_STOP,
  VIRTIO_SND_R_CHMAP_INFO,
  VIRTIO_SND_S_OK,
  VIRTIO_SND_S_BAD_MSG,
  VIRTIO_SND_S_NOT_SUPP,
  VIRTIO_SND_D_OUTPUT,
  VIRTIO_SND_PCM_FMT_S16,
  VIRTIO_SND_PCM_RATE_48000,
  SND_HDR_LEN,
  SND_PCM_INFO_LEN,
  SND_PCM_STATUS_LEN,
} from "./snd-device.js";
import { SharedQueues, makeSharedQueues } from "./shared-queues.js";
import { VRING_DESC_F_NEXT, VRING_DESC_F_WRITE } from "./vring.js";

// Minimal split-vring builder in flat memory (mirrored from vsock-device.test.js).
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

function makeDev({ forwardNotify, sink } = {}) {
  const memory = /** @type {any} */ ({ buffer: new ArrayBuffer(128 * 1024) });
  const shared = new SharedQueues(makeSharedQueues());
  const irqs = [];
  const dev = new SndVirtioDevice({
    dev: 6,
    irq: 14,
    memory,
    raiseInterrupt: (cpu, irq) => irqs.push([cpu, irq]),
    sharedQueues: shared,
    forwardNotify,
    sink,
  });
  return { dev, memory, shared, irqs };
}

// Build the control + event + tx vqs. Buffers live above 0x8000.
function makeDevWithVqs(opts) {
  const ctx = makeDev(opts);
  const { dev, memory } = ctx;
  const CTL = makeVq(memory, 0x1000, 8);
  const EVT = makeVq(memory, 0x2000, 8);
  const TX = makeVq(memory, 0x3000, 8);
  dev.setupQueue(SND_VQ_CONTROL, CTL.desc, CTL.avail, CTL.used, CTL.num);
  dev.setupQueue(SND_VQ_EVENT, EVT.desc, EVT.avail, EVT.used, EVT.num);
  dev.setupQueue(SND_VQ_TX, TX.desc, TX.avail, TX.used, TX.num);
  return { ...ctx, CTL, EVT, TX };
}

// Push one control request chain: request bytes at reqAddr (out) + respLen
// writable space at respAddr (in). Returns the response bytes reader.
function pushControl(ctx, req, respLen = 64) {
  const { CTL, memory, dev } = ctx;
  const reqAddr = 0x8000;
  const respAddr = 0x9000;
  new Uint8Array(memory.buffer, reqAddr, req.length).set(req);
  CTL.setDesc(0, reqAddr, req.length, false, 1);
  CTL.setDesc(1, respAddr, respLen, true, null);
  CTL.pushAvail(0);
  dev.onNotify(SND_VQ_CONTROL);
  return {
    resp: (n) => new Uint8Array(memory.buffer, respAddr, n),
    respDv: () => new DataView(memory.buffer, respAddr, respLen),
  };
}

// Tx completions are paced by the playback clock — poll for them.
async function waitUntil(pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil timed out");
}

function u32req(fields) {
  const b = new Uint8Array(fields.length * 4);
  const dv = new DataView(b.buffer);
  fields.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return b;
}

// struct virtio_snd_pcm_set_params for stream 0.
function setParamsReq({
  channels = 2,
  format = VIRTIO_SND_PCM_FMT_S16,
  rate = VIRTIO_SND_PCM_RATE_48000,
  bufferBytes = 16384,
  periodBytes = 4096,
} = {}) {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, VIRTIO_SND_R_PCM_SET_PARAMS, true);
  dv.setUint32(4, 0, true); // stream_id
  dv.setUint32(8, bufferBytes, true);
  dv.setUint32(12, periodBytes, true);
  dv.setUint32(16, 0, true); // features
  b[20] = channels;
  b[21] = format;
  b[22] = rate;
  return b;
}

describe("SndVirtioDevice", () => {
  it("serves config space: 0 jacks, 1 stream, 0 chmaps", () => {
    const { dev } = makeDev();
    const cfg = new Uint8Array(12);
    dev.configRead(0, cfg);
    const dv = new DataView(cfg.buffer);
    expect(dv.getUint32(0, true)).toBe(0);
    expect(dv.getUint32(4, true)).toBe(1);
    expect(dv.getUint32(8, true)).toBe(0);
    // offset reads + past-the-end zeros
    const tail = new Uint8Array(8);
    dev.configRead(8, tail);
    expect(new DataView(tail.buffer).getUint32(0, true)).toBe(0); // chmaps
    expect(new DataView(tail.buffer).getUint32(4, true)).toBe(0); // past end
  });

  it("offers only VIRTIO_F_VERSION_1", () => {
    const { dev } = makeDev();
    expect(dev.getFeatures()).toBe(1n << 32n);
  });

  it("answers PCM_INFO with one s16/48k output stream", () => {
    const ctx = makeDevWithVqs();
    const { CTL, irqs } = ctx;
    // { hdr=PCM_INFO, start_id=0, count=1, size=32 }
    const r = pushControl(ctx, u32req([VIRTIO_SND_R_PCM_INFO, 0, 1, SND_PCM_INFO_LEN]));
    expect(CTL.usedIdx()).toBe(1);
    expect(CTL.usedElem(0).len).toBe(SND_HDR_LEN + SND_PCM_INFO_LEN);
    const dv = r.respDv();
    expect(dv.getUint32(0, true)).toBe(VIRTIO_SND_S_OK);
    expect(dv.getBigUint64(SND_HDR_LEN + 8, true)).toBe(1n << BigInt(VIRTIO_SND_PCM_FMT_S16)); // formats
    expect(dv.getBigUint64(SND_HDR_LEN + 16, true)).toBe(1n << BigInt(VIRTIO_SND_PCM_RATE_48000)); // rates
    expect(dv.getUint8(SND_HDR_LEN + 24)).toBe(VIRTIO_SND_D_OUTPUT);
    expect(dv.getUint8(SND_HDR_LEN + 25)).toBe(1); // channels_min
    expect(dv.getUint8(SND_HDR_LEN + 26)).toBe(2); // channels_max
    expect(irqs.length).toBe(1);
  });

  it("rejects PCM_INFO past the stream count", () => {
    const ctx = makeDevWithVqs();
    const r = pushControl(ctx, u32req([VIRTIO_SND_R_PCM_INFO, 0, 2, SND_PCM_INFO_LEN]));
    expect(r.respDv().getUint32(0, true)).toBe(VIRTIO_SND_S_BAD_MSG);
  });

  it("accepts SET_PARAMS (s16/48k/stereo) and reports them to the sink", () => {
    const params = [];
    const ctx = makeDevWithVqs({ sink: { onParams: (p) => params.push(p) } });
    const r = pushControl(ctx, setParamsReq({ periodBytes: 4096 }));
    expect(r.respDv().getUint32(0, true)).toBe(VIRTIO_SND_S_OK);
    expect(params.length).toBe(1);
    expect(params[0]).toMatchObject({
      streamId: 0,
      channels: 2,
      periodBytes: 4096,
      bufferBytes: 16384,
      rateHz: 48000,
    });
  });

  it("rejects SET_PARAMS with an unsupported rate/format/channels", () => {
    const ctx = makeDevWithVqs();
    const bad = [
      setParamsReq({ rate: 6 /* 44100 */ }),
      setParamsReq({ format: 3 /* S8 */ }),
      setParamsReq({ channels: 3 }),
    ];
    for (const req of bad) {
      const r = pushControl(ctx, req);
      expect(r.respDv().getUint32(0, true)).toBe(VIRTIO_SND_S_NOT_SUPP);
    }
  });

  it("runs the prepare/start/stop/release lifecycle through the sink", () => {
    const events = [];
    const ctx = makeDevWithVqs({
      sink: {
        onStart: (id) => events.push(["start", id]),
        onStop: (id) => events.push(["stop", id]),
        onRelease: (id) => events.push(["release", id]),
      },
    });
    const { dev } = ctx;
    for (const code of [
      VIRTIO_SND_R_PCM_PREPARE,
      VIRTIO_SND_R_PCM_START,
      VIRTIO_SND_R_PCM_STOP,
      VIRTIO_SND_R_PCM_RELEASE,
    ]) {
      const r = pushControl(ctx, u32req([code, 0]));
      expect(r.respDv().getUint32(0, true)).toBe(VIRTIO_SND_S_OK);
    }
    expect(events).toEqual([
      ["start", 0],
      ["stop", 0],
      ["release", 0],
    ]);
    expect(dev.running).toBe(false);
    expect(dev.prepared).toBe(false);
  });

  it("answers CHMAP_INFO (0 chmaps advertised) with BAD_MSG", () => {
    const ctx = makeDevWithVqs();
    const r = pushControl(ctx, u32req([VIRTIO_SND_R_CHMAP_INFO, 0, 1, 8]));
    expect(r.respDv().getUint32(0, true)).toBe(VIRTIO_SND_S_BAD_MSG);
  });

  it("consumes tx PCM frames to the sink and completes with an OK status", async () => {
    const got = [];
    const ctx = makeDevWithVqs({
      sink: {
        onPcm: (id, bytes, params) => got.push({ id, bytes, rate: params.rateHz }),
        bufferedBytes: () => 1234,
      },
    });
    const { TX, memory, dev, irqs } = ctx;
    pushControl(ctx, setParamsReq()); // params must exist before PCM flows
    pushControl(ctx, u32req([VIRTIO_SND_R_PCM_PREPARE, 0]));
    pushControl(ctx, u32req([VIRTIO_SND_R_PCM_START, 0])); // tx only flows while running
    const irqsBefore = irqs.length;

    // Chain: [xfer hdr (out)] + [pcm data (out)] + [status (in)]
    const hdrAddr = 0xa000;
    const pcmAddr = 0xb000;
    const stAddr = 0xc000;
    new DataView(memory.buffer).setUint32(hdrAddr, 0, true); // stream_id 0
    const pcm = new Uint8Array(512);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;
    new Uint8Array(memory.buffer, pcmAddr, pcm.length).set(pcm);
    TX.setDesc(0, hdrAddr, 4, false, 1);
    TX.setDesc(1, pcmAddr, pcm.length, false, 2);
    TX.setDesc(2, stAddr, SND_PCM_STATUS_LEN, true, null);
    TX.pushAvail(0);
    dev.onNotify(SND_VQ_TX);

    // Sink delivery is immediate; completion is paced by the playback clock
    // (512 bytes = 128 frames ≈ 2.7ms at 48kHz).
    expect(got.length).toBe(1);
    await waitUntil(() => TX.usedIdx() === 1);
    expect(TX.usedIdx()).toBe(1);
    expect(TX.usedElem(0).len).toBe(SND_PCM_STATUS_LEN);
    const st = new DataView(memory.buffer, stAddr, SND_PCM_STATUS_LEN);
    expect(st.getUint32(0, true)).toBe(VIRTIO_SND_S_OK);
    expect(st.getUint32(4, true)).toBe(1234); // latency_bytes from the sink
    expect(got.length).toBe(1);
    expect(got[0].id).toBe(0);
    expect(got[0].rate).toBe(48000);
    expect(Array.from(got[0].bytes.subarray(0, 4))).toEqual([0, 1, 2, 3]);
    expect(dev.consumedBytes).toBe(512);
    expect(irqs.length).toBe(irqsBefore + 1);
  });

  it("holds pre-START tx buffers and completes them when START arrives", async () => {
    // The guest driver pre-queues its whole ALSA buffer BEFORE triggering
    // START; completing those early starves the period-elapsed accounting
    // (the first-boot -EIO). The device must hold them until START.
    const got = [];
    const ctx = makeDevWithVqs({ sink: { onPcm: (_id, bytes) => got.push(bytes) } });
    const { TX, memory, dev } = ctx;
    pushControl(ctx, setParamsReq());
    pushControl(ctx, u32req([VIRTIO_SND_R_PCM_PREPARE, 0]));

    new DataView(memory.buffer).setUint32(0xa000, 0, true); // stream_id 0
    new Uint8Array(memory.buffer, 0xb000, 64).fill(0x7f);
    TX.setDesc(0, 0xa000, 4, false, 1);
    TX.setDesc(1, 0xb000, 64, false, 2);
    TX.setDesc(2, 0xc000, SND_PCM_STATUS_LEN, true, null);
    TX.pushAvail(0);
    dev.onNotify(SND_VQ_TX); // pre-START kick: buffer must be HELD
    expect(TX.usedIdx()).toBe(0);
    expect(got.length).toBe(0);

    pushControl(ctx, u32req([VIRTIO_SND_R_PCM_START, 0])); // START drains it
    expect(got.length).toBe(1); // sink delivery is immediate at START
    expect(got[0].length).toBe(64);
    await waitUntil(() => TX.usedIdx() === 1); // completion rides the clock
  });

  it("completes still-held tx buffers at RELEASE without sink delivery", () => {
    const got = [];
    const ctx = makeDevWithVqs({ sink: { onPcm: (_id, bytes) => got.push(bytes) } });
    const { TX, memory, dev } = ctx;
    pushControl(ctx, setParamsReq());
    pushControl(ctx, u32req([VIRTIO_SND_R_PCM_PREPARE, 0]));
    new DataView(memory.buffer).setUint32(0xa000, 0, true);
    TX.setDesc(0, 0xa000, 4, false, 1);
    TX.setDesc(1, 0xb000, 64, false, 2);
    TX.setDesc(2, 0xc000, SND_PCM_STATUS_LEN, true, null);
    TX.pushAvail(0);
    dev.onNotify(SND_VQ_TX); // held (not running)
    expect(TX.usedIdx()).toBe(0);

    pushControl(ctx, u32req([VIRTIO_SND_R_PCM_RELEASE, 0]));
    expect(TX.usedIdx()).toBe(1); // completed so the driver's msg_empty wait finishes
    expect(TX.usedElem(0).len).toBe(SND_PCM_STATUS_LEN);
    expect(got.length).toBe(0); // never delivered — the stream never ran
  });

  it("parks event buffers (no completion on an eventq kick)", () => {
    const ctx = makeDevWithVqs();
    const { EVT, memory, dev, irqs } = ctx;
    new Uint8Array(memory.buffer, 0xd000, 64).fill(0);
    EVT.setDesc(0, 0xd000, 64, true, null);
    EVT.pushAvail(0);
    dev.onNotify(SND_VQ_EVENT);
    expect(EVT.usedIdx()).toBe(0);
    expect(irqs.length).toBe(0);
  });

  it("forwards kicks on the worker side instead of servicing", () => {
    const forwarded = [];
    const ctx = makeDevWithVqs({ forwardNotify: (dev, q) => forwarded.push([dev, q]) });
    ctx.dev.onNotify(SND_VQ_TX);
    ctx.dev.onNotify(SND_VQ_CONTROL);
    expect(forwarded).toEqual([
      [6, SND_VQ_TX],
      [6, SND_VQ_CONTROL],
    ]);
    expect(ctx.TX.usedIdx()).toBe(0);
  });
});
