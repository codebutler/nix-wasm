// snd-device.js — host (JS) model of a virtio-snd device on the `virtio_wasm`
// transport (issue #145: give the guest a sound card). This is the device the
// guest's STOCK mainline virtio-snd driver (sound/virtio/, CONFIG_SND_VIRTIO)
// talks to, so ALSA userspace (alsa-lib "hw:0,0", libcanberra event sounds)
// works unmodified — the same "everything is a virtio device" pattern as the
// console/blk/9p/vsock devices (#10).
//
// SCOPE (issue #145): PLAYBACK ONLY, one PCM output stream, no jacks, no
// channel maps, no capture. The device consumes guest PCM frames and hands them
// to a host-side SINK (`setSink`) — in pc that's an AudioWorklet fed through
// js/audio.js; in the node harness it's the smoke test's assertion buffer. The
// device itself never touches an AudioContext, so it is fully headless-testable.
//
// FOUR VIRTQUEUES (virtio spec §5.14.2; mainline virtio_snd.c binds exactly
// these, in order):
//   q0 = controlq  driver→device control requests (info/params/prepare/…);
//                  each buffer is [request (out)] + [response space (in)]
//   q1 = eventq    device→driver async events. The driver posts empty buffers;
//                  we never emit an event, so they stay parked (do not complete
//                  them — the driver waits to *receive* an event on each).
//   q2 = txq       playback: [virtio_snd_pcm_xfer (out)] + [PCM frames (out)] +
//                  [virtio_snd_pcm_status (in space)] per period
//   q3 = rxq       capture — unused (no capture streams); kicks are ignored
//
// CONFIG SPACE: struct virtio_snd_config { __le32 jacks; __le32 streams;
// __le32 chmaps; } = { 0, 1, 0 }. (A 4th `controls` field exists only behind
// VIRTIO_SND_F_CTLS, which we do not offer.)
//
// STREAM 0 (the one PCM stream): direction OUTPUT, s16 only
// (VIRTIO_SND_PCM_FMT_S16), 48kHz only (VIRTIO_SND_PCM_RATE_48000), 1..2
// channels. Event-sound latency tolerance is generous (issue #145); a single
// fixed rate keeps the host sink trivial (the pc worklet resamples to the
// AudioContext rate if it differs).
//
// COMPLETION MODEL (both rules hard-won by BOOTING the real guest driver, not
// spec-reading — see the git history of the first boot's two -EIO failures):
//
// 1. Buffers queued BEFORE the stream starts are HELD in the vring (not
//    popped) until VIRTIO_SND_R_PCM_START. The guest driver pre-queues the
//    whole ALSA buffer (buffer_bytes/period_bytes messages) before triggering
//    START, and only counts a period elapsed on a completion that arrives
//    while xfer_enabled. Completing those pre-START messages immediately left
//    the driver with ZERO outstanding messages at START, so no period-elapsed
//    could ever arrive — the next snd_pcm_writei blocked to its 10s timeout
//    and failed with -EIO.
//
// 2. While RUNNING, the PCM payload is handed to the sink immediately (so the
//    pc worklet can buffer ahead), but each buffer is COMPLETED against a
//    real-time playback clock (frames/48000 apart, _pumpTx). Completing a
//    whole buffer's worth in one burst wraps ALSA's hw_ptr exactly back onto
//    itself (pointer looks stalled → same 10s -EIO), and paced completions
//    are also what makes snd_pcm_writei block like real hardware, bounding
//    how far ahead of real time the guest can run.
//
// On VIRTIO_SND_R_PCM_RELEASE all pending buffers complete immediately (the
// driver's sync_stop waits for ALL messages — wait_event on msg_empty —
// before hw_free). latency_bytes reports whatever the sink says it has
// buffered (sink.bufferedBytes?()), else 0.
//
// WORKER→MAIN INVERSION (mirrors vsock-device.js): the sink (AudioWorklet /
// smoke assertions) is main-thread-bound, but the guest's vq kick
// (wasm_virtio_notify) lands on whichever task worker issued the syscall. A
// worker-side instance only answers the synchronous transport probes (features
// / config / queue setup) and FORWARDS the notify (virtiosnd_notify) to the
// main thread; the main-thread instance parses the control/tx traffic, runs
// the sink, and raises the completion IRQ via the SAME raised_irqs self-wake
// path 9p/vsock/console use.

import { VirtioWasmDevice } from "./device.js";

const VIRTIO_F_VERSION_1 = 32n; // modern (v1) device

// ---- virtio-snd constants (uapi/linux/virtio_snd.h) ----

// queue indices (virtio spec §5.14.2 / sound/virtio/virtio_card.c order)
export const SND_VQ_CONTROL = 0;
export const SND_VQ_EVENT = 1;
export const SND_VQ_TX = 2;
export const SND_VQ_RX = 3;

// jack control request types
export const VIRTIO_SND_R_JACK_INFO = 0x0001;
// PCM control request types
export const VIRTIO_SND_R_PCM_INFO = 0x0100;
export const VIRTIO_SND_R_PCM_SET_PARAMS = 0x0101;
export const VIRTIO_SND_R_PCM_PREPARE = 0x0102;
export const VIRTIO_SND_R_PCM_RELEASE = 0x0103;
export const VIRTIO_SND_R_PCM_START = 0x0104;
export const VIRTIO_SND_R_PCM_STOP = 0x0105;
// channel map control request types
export const VIRTIO_SND_R_CHMAP_INFO = 0x0200;

// common status codes
export const VIRTIO_SND_S_OK = 0x8000;
export const VIRTIO_SND_S_BAD_MSG = 0x8001;
export const VIRTIO_SND_S_NOT_SUPP = 0x8002;
export const VIRTIO_SND_S_IO_ERR = 0x8003;

// dataflow direction
export const VIRTIO_SND_D_OUTPUT = 0;
export const VIRTIO_SND_D_INPUT = 1;

// supported PCM sample format bits (we offer S16 only)
export const VIRTIO_SND_PCM_FMT_S16 = 5;
// supported PCM frame rate bits (we offer 48000 only)
export const VIRTIO_SND_PCM_RATE_48000 = 7;

// struct sizes (all little-endian, fixed layout)
export const SND_HDR_LEN = 4; // struct virtio_snd_hdr { __le32 code; }
export const SND_PCM_INFO_LEN = 32; // struct virtio_snd_pcm_info
export const SND_PCM_XFER_LEN = 4; // struct virtio_snd_pcm_xfer { __le32 stream_id; }
export const SND_PCM_STATUS_LEN = 8; // struct virtio_snd_pcm_status { status, latency_bytes }

// The advertised stream geometry (issue #145 scope).
const STREAMS = 1;
const STREAM_ID = 0;
export const SND_RATE_HZ = 48000;
const CHANNELS_MIN = 1;
const CHANNELS_MAX = 2;

/**
 * @typedef {{
 *   streamId: number,
 *   bufferBytes: number,
 *   periodBytes: number,
 *   channels: number,
 *   format: number,
 *   rate: number,
 *   rateHz: number,
 * }} SndStreamParams
 *
 * The host sink a consumer attaches via setSink(). All callbacks optional:
 * @typedef {{
 *   onParams?: (params: SndStreamParams) => void,
 *   onStart?: (streamId: number) => void,
 *   onStop?: (streamId: number) => void,
 *   onRelease?: (streamId: number) => void,
 *   onPcm?: (streamId: number, bytes: Uint8Array, params: SndStreamParams) => void,
 *   bufferedBytes?: () => number,
 * }} SndSink
 */

export class SndVirtioDevice extends VirtioWasmDevice {
  /**
   * Extends the base VirtioWasmDevice opts with:
   * - `forwardNotify` ((dev, q) => void): WORKER only — forwards the kick to
   *   the main thread (where the sink lives) instead of servicing here.
   * - `sink` (SndSink): optional initial sink (tests); pc attaches later via
   *   setSink() from the snd.onReady boot hook.
   *
   * @param {ConstructorParameters<typeof VirtioWasmDevice>[0] & { forwardNotify?: (dev: number, q: number) => void, sink?: SndSink }} opts
   */
  constructor(opts) {
    super(opts);
    this.forwardNotify = opts.forwardNotify || null;
    /** @type {SndSink | null} */
    this.sink = opts.sink || null;
    // Per-stream state (stream 0 only): last SET_PARAMS + running flag.
    /** @type {SndStreamParams | null} */
    this.params = null;
    this.prepared = false;
    this.running = false;
    // Cumulative PCM bytes the device has consumed (diagnostics / tests).
    this.consumedBytes = 0;
    // Playback-clock completion state (_pumpTx): buffers popped from the tx
    // ring, delivered to the sink, awaiting their paced completion.
    /** @type {{ head: number, chain: any, frames: number, ok: boolean, dueAt: number }[]} */
    this._txPending = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._txTimer = null;
    this._playheadMs = 0;
  }

  /** Attach/replace the host sink (the pc AudioWorklet or a test recorder). */
  setSink(sink) {
    this.sink = sink;
  }

  reset() {
    this._pauseTx();
    this._txPending = [];
    this.params = null;
    this.prepared = false;
    this.running = false;
    super.reset();
  }

  getFeatures() {
    return 1n << VIRTIO_F_VERSION_1;
  }

  // struct virtio_snd_config { __le32 jacks; __le32 streams; __le32 chmaps; }
  configRead(offset, bytes) {
    const cfg = new Uint8Array(12);
    const dv = new DataView(cfg.buffer);
    dv.setUint32(0, 0, true); // jacks
    dv.setUint32(4, STREAMS, true); // streams
    dv.setUint32(8, 0, true); // chmaps
    for (let i = 0; i < bytes.length; i++) {
      const src = offset + i;
      bytes[i] = src < cfg.length ? cfg[src] : 0;
    }
  }

  onNotify(q) {
    const qi = q >>> 0;
    if (this.forwardNotify) {
      // Worker side: the sink is on the main thread — forward the kick.
      this.forwardNotify(this.dev, qi);
      return;
    }
    if (qi === SND_VQ_CONTROL) {
      this._serviceControl();
    } else if (qi === SND_VQ_TX) {
      this._serviceTx();
    } else if (qi === SND_VQ_EVENT) {
      // The driver posted event buffers. We never emit an event, so leave them
      // parked (completing one would deliver a garbage "event" to the driver).
    } else if (qi === SND_VQ_RX) {
      // No capture streams exist, so the driver never posts rx buffers; ignore.
    }
  }

  // ---- controlq ----

  /** Drain the control vq: parse each request, write the response, push used. */
  _serviceControl() {
    const vr = this.vring(SND_VQ_CONTROL);
    if (!vr) {
      this.log("[virtio-snd] control notify before queue setup");
      return;
    }
    let chain;
    let serviced = 0;
    while ((chain = vr.next())) {
      const req = vr.readOut(chain);
      let resp;
      try {
        resp = this._handleControl(req);
      } catch (e) {
        this.log(`[virtio-snd] control request error: ${e}`);
        resp = this._hdr(VIRTIO_SND_S_IO_ERR);
      }
      const written = vr.writeIn(chain, resp);
      vr.pushUsed(chain.head, written);
      serviced++;
    }
    if (serviced) this.raiseIrq();
  }

  /** struct virtio_snd_hdr { __le32 code; } response helper. */
  _hdr(code, extra = 0) {
    const b = new Uint8Array(SND_HDR_LEN + extra);
    new DataView(b.buffer).setUint32(0, code >>> 0, true);
    return b;
  }

  /** Parse + answer one control request; returns the response bytes. */
  _handleControl(req) {
    if (req.length < SND_HDR_LEN) return this._hdr(VIRTIO_SND_S_BAD_MSG);
    const dv = new DataView(req.buffer, req.byteOffset, req.byteLength);
    const code = dv.getUint32(0, true);
    switch (code) {
      case VIRTIO_SND_R_PCM_INFO: {
        // struct virtio_snd_query_info { hdr; __le32 start_id; __le32 count;
        // __le32 size; } → response: hdr + count entries of `size` bytes each.
        if (req.length < 16) return this._hdr(VIRTIO_SND_S_BAD_MSG);
        const startId = dv.getUint32(4, true);
        const count = dv.getUint32(8, true);
        const size = dv.getUint32(12, true);
        if (startId + count > STREAMS || size < SND_PCM_INFO_LEN) {
          return this._hdr(VIRTIO_SND_S_BAD_MSG);
        }
        const resp = this._hdr(VIRTIO_SND_S_OK, count * size);
        const rdv = new DataView(resp.buffer);
        for (let i = 0; i < count; i++) {
          // struct virtio_snd_pcm_info (one per stream; ours is stream 0):
          const off = SND_HDR_LEN + i * size;
          rdv.setUint32(off + 0, 0, true); // hdr.hda_fn_nid
          rdv.setUint32(off + 4, 0, true); // features (none)
          rdv.setBigUint64(off + 8, 1n << BigInt(VIRTIO_SND_PCM_FMT_S16), true); // formats
          rdv.setBigUint64(off + 16, 1n << BigInt(VIRTIO_SND_PCM_RATE_48000), true); // rates
          resp[off + 24] = VIRTIO_SND_D_OUTPUT; // direction
          resp[off + 25] = CHANNELS_MIN; // channels_min
          resp[off + 26] = CHANNELS_MAX; // channels_max
          // padding[5] already zero
        }
        return resp;
      }
      case VIRTIO_SND_R_PCM_SET_PARAMS: {
        // struct virtio_snd_pcm_set_params { pcm_hdr { hdr, __le32 stream_id };
        // __le32 buffer_bytes; __le32 period_bytes; __le32 features;
        // u8 channels; u8 format; u8 rate; u8 padding; }
        if (req.length < 24) return this._hdr(VIRTIO_SND_S_BAD_MSG);
        const streamId = dv.getUint32(4, true);
        if (streamId !== STREAM_ID) return this._hdr(VIRTIO_SND_S_BAD_MSG);
        const channels = req[20];
        const format = req[21];
        const rate = req[22];
        if (
          channels < CHANNELS_MIN ||
          channels > CHANNELS_MAX ||
          format !== VIRTIO_SND_PCM_FMT_S16 ||
          rate !== VIRTIO_SND_PCM_RATE_48000
        ) {
          return this._hdr(VIRTIO_SND_S_NOT_SUPP);
        }
        this.params = {
          streamId,
          bufferBytes: dv.getUint32(8, true),
          periodBytes: dv.getUint32(12, true),
          channels,
          format,
          rate,
          rateHz: SND_RATE_HZ,
        };
        if (this.sink && this.sink.onParams) this.sink.onParams(this.params);
        return this._hdr(VIRTIO_SND_S_OK);
      }
      case VIRTIO_SND_R_PCM_PREPARE:
      case VIRTIO_SND_R_PCM_RELEASE:
      case VIRTIO_SND_R_PCM_START:
      case VIRTIO_SND_R_PCM_STOP: {
        // struct virtio_snd_pcm_hdr { hdr; __le32 stream_id; }
        if (req.length < 8) return this._hdr(VIRTIO_SND_S_BAD_MSG);
        const streamId = dv.getUint32(4, true);
        if (streamId !== STREAM_ID) return this._hdr(VIRTIO_SND_S_BAD_MSG);
        if (code === VIRTIO_SND_R_PCM_PREPARE) {
          this.prepared = true;
        } else if (code === VIRTIO_SND_R_PCM_START) {
          this.running = true;
          if (this.sink && this.sink.onStart) this.sink.onStart(streamId);
          // Consume the periods the driver pre-queued before triggering START
          // (see the completion-model note in the header — completing them
          // early starves the period-elapsed accounting and hangs writei).
          this._serviceTx();
        } else if (code === VIRTIO_SND_R_PCM_STOP) {
          this.running = false;
          this._pauseTx();
          if (this.sink && this.sink.onStop) this.sink.onStop(streamId);
        } else {
          // RELEASE: the driver's sync_stop waits for ALL pending I/O messages
          // to complete (msg_empty) — complete any still-held tx buffers now,
          // without sink delivery (the stream is stopped; nothing "plays").
          this.prepared = false;
          this.running = false;
          this._completePendingTx();
          if (this.sink && this.sink.onRelease) this.sink.onRelease(streamId);
        }
        return this._hdr(VIRTIO_SND_S_OK);
      }
      case VIRTIO_SND_R_JACK_INFO:
      case VIRTIO_SND_R_CHMAP_INFO:
        // Config space advertises 0 jacks / 0 chmaps, so these never come.
        return this._hdr(VIRTIO_SND_S_BAD_MSG);
      default:
        this.log(`[virtio-snd] unhandled control code 0x${code.toString(16)}`);
        return this._hdr(VIRTIO_SND_S_NOT_SUPP);
    }
  }

  // ---- txq (playback) ----

  /**
   * Drain the tx vq: each chain is [virtio_snd_pcm_xfer][PCM frames] (out) +
   * [virtio_snd_pcm_status] (in). The PCM payload is handed to the sink
   * IMMEDIATELY (so the pc worklet can buffer ahead of real time), but the
   * buffer is completed against the PLAYBACK CLOCK (_pumpTx) — see the
   * completion-model header note.
   */
  _serviceTx() {
    const vr = this.vring(SND_VQ_TX);
    if (!vr) {
      this.log("[virtio-snd] tx notify before queue setup");
      return;
    }
    // Not running: HOLD the buffers in the vring (do not pop) — the driver
    // pre-queues its whole ALSA buffer before START, and completions must not
    // arrive until the stream runs (see the completion-model header note).
    // The START handler re-runs this drain.
    if (!this.running) return;
    let chain;
    while ((chain = vr.next())) {
      const buf = vr.readOut(chain);
      let ok = false;
      let frames = 0;
      if (buf.length >= SND_PCM_XFER_LEN) {
        const streamId = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
          0,
          true,
        );
        const pcm = buf.subarray(SND_PCM_XFER_LEN);
        this.consumedBytes += pcm.length;
        const bytesPerFrame = (this.params ? this.params.channels : CHANNELS_MAX) * 2;
        frames = Math.floor(pcm.length / bytesPerFrame);
        ok = true;
        if (streamId === STREAM_ID && this.sink && this.sink.onPcm && this.params) {
          try {
            // Copy out of the (shared) vring buffer before handing to the sink.
            this.sink.onPcm(streamId, Uint8Array.from(pcm), this.params);
          } catch (e) {
            this.log(`[virtio-snd] sink onPcm threw: ${e}`);
          }
        }
      }
      // Assign the buffer's completion time ONCE, on enqueue: it "plays" for
      // frames/48000 starting when the previous buffer finishes (or now, if
      // the playhead lagged real time — a gap between sounds isn't "owed").
      this._playheadMs = Math.max(this._playheadMs, Date.now()) + (frames * 1000) / SND_RATE_HZ;
      this._txPending.push({ head: chain.head, chain, frames, ok, dueAt: this._playheadMs });
    }
    this._pumpTx();
  }

  /**
   * Complete pending tx buffers against the playback clock: each buffer's
   * completion is due `frames / 48000` after the previous one "played". Due
   * buffers complete now (status write + used + IRQ); the head buffer that
   * isn't due yet arms one timer. Spreading completions over real time is
   * LOAD-BEARING, not cosmetic: ALSA advances hw_ptr from the completion
   * callbacks, and a whole buffer completing in one burst wraps hw_ptr exactly
   * back onto itself — the pointer looks stalled, snd_pcm_writei times out
   * with -EIO (the second real-boot failure). It also gives the guest real
   * pacing (writes block until a period "plays"), which bounds how far ahead
   * the sink can buffer.
   */
  _pumpTx() {
    if (this._txTimer != null) return;
    const vr = this.vring(SND_VQ_TX);
    if (!vr) return;
    const now = Date.now();
    let completed = 0;
    while (this._txPending.length) {
      const head = this._txPending[0];
      if (head.dueAt > now + 0.5) {
        this._txTimer = setTimeout(() => {
          this._txTimer = null;
          this._pumpTx();
        }, head.dueAt - now);
        break;
      }
      this._txPending.shift();
      this._completeTx(vr, head);
      completed++;
    }
    if (completed) this.raiseIrq();
  }

  /** Write one tx buffer's virtio_snd_pcm_status and push it used. */
  _completeTx(vr, pending) {
    // struct virtio_snd_pcm_status { __le32 status; __le32 latency_bytes; }
    const st = new Uint8Array(SND_PCM_STATUS_LEN);
    const sdv = new DataView(st.buffer);
    sdv.setUint32(0, pending.ok ? VIRTIO_SND_S_OK : VIRTIO_SND_S_BAD_MSG, true);
    const latency = this.sink && this.sink.bufferedBytes ? this.sink.bufferedBytes() >>> 0 : 0;
    sdv.setUint32(4, latency, true);
    const written = vr.writeIn(pending.chain, st);
    vr.pushUsed(pending.head, written);
  }

  /** STOP: pause the playback clock (pending buffers stay until START/RELEASE). */
  _pauseTx() {
    if (this._txTimer != null) {
      clearTimeout(this._txTimer);
      this._txTimer = null;
    }
  }

  /**
   * RELEASE: complete every pending tx buffer immediately (OK status, no
   * further sink delivery) — the driver's sync_stop waits for ALL messages to
   * complete (msg_empty) before hw_free, so nothing may stay held.
   */
  _completePendingTx() {
    this._pauseTx();
    const vr = this.vring(SND_VQ_TX);
    if (!vr) return;
    let serviced = 0;
    // First the clock queue (already popped from the ring)…
    while (this._txPending.length) {
      this._completeTx(vr, this._txPending.shift());
      serviced++;
    }
    // …then anything still parked in the ring (pre-START buffers).
    let chain;
    while ((chain = vr.next())) {
      this._completeTx(vr, { head: chain.head, chain, frames: 0, ok: true });
      serviced++;
    }
    if (serviced) this.raiseIrq();
  }
}
