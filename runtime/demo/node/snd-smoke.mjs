// snd-smoke.mjs — end-to-end proof of the guest sound card (issue #145):
// virtio-snd device (kernel patch 0027, CONFIG_SND_VIRTIO) + cross alsa-lib.
//
// It boots busybox-only (nix:false — kernel + initramfs, no /nix overlay
// needed), attaches a recording sink to the host SndVirtioDevice via the
// `snd.onReady(device)` boot hook, and drives the guest shell to run
// `alsa-tone` (userspace/alsa-tone.c): alsa-lib opens the "default" PCM
// (config tree from the initramfs copy of share/alsa), sets 48kHz s16 stereo,
// and writes a DETERMINISTIC 440Hz sine.
//
// PASS iff:
//   1. the driver probed + negotiated: the sink saw SET_PARAMS (48k/2ch) and
//      START — proving controlq round-trips work;
//   2. the device received at least the full tone's PCM bytes on the tx vq;
//   3. the received samples are BIT-EXACT: the first 2048 samples equal the
//      sine series alsa-tone generates (same formula) — proving the payload
//      crosses the vring unmangled (no plug-layer conversion, right layout);
//   4. the guest's alsa-lib call sequence completed (ALSA-TONE-RESULT: OK).
//
// This is fully headless — "actually audible" is the pc-side sink's concern
// (a manual browser check, like the GTK visual checks).
//
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const TONE_RATE = 48000;
const TONE_CHANNELS = 2;
const TONE_HZ = 440.0;
const TONE_FRAMES = 12000; // 0.25s — MUST match userspace/alsa-tone.c
const EXPECT_BYTES = TONE_FRAMES * TONE_CHANNELS * 2;

// What the recording sink saw.
const seen = { params: null, started: false, stopped: false, chunks: [], bytes: 0 };

const s = await bootNode({
  nix: false,
  snd: {
    onReady: (device) => {
      device.setSink({
        onParams: (p) => {
          seen.params = p;
        },
        onStart: () => {
          seen.started = true;
        },
        onStop: () => {
          seen.stopped = true;
        },
        onPcm: (_id, bytes) => {
          seen.chunks.push(bytes);
          seen.bytes += bytes.length;
        },
      });
    },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + label);
}

let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[snd-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // The driver probes at boot; /dev/snd should exist before we play anything.
  s.send("ls /dev/snd; echo SNDDEV_RC=$?\n");
  if (!(await s.waitForOutput(/pcmC0D0p/, 15000))) {
    throw new Error("/dev/snd/pcmC0D0p missing — virtio-snd probe failed");
  }

  // Play the tone. The busybox-only boot has no /nix, so point alsa-lib at the
  // initramfs copy of its config tree (see initramfs.nix extraShare); on a
  // nix:true boot the compiled-in /nix/store datadir resolves instead.
  s.send(
    "ALSA_CONFIG_DIR=/usr/share/alsa ALSA_CONFIG_PATH=/usr/share/alsa/alsa.conf alsa-tone; echo TONE_EXIT=$?\n",
  );
  if (!(await s.waitForOutput(/ALSA-TONE-RESULT: OK/, 60000))) {
    throw new Error("alsa-tone did not report OK");
  }
  if (!(await s.waitForOutput(/TONE_EXIT=0/, 15000))) {
    throw new Error("alsa-tone exited non-zero");
  }

  // 1. Control path: SET_PARAMS 48k/2ch + START reached the sink.
  await waitFor(() => seen.params && seen.started, 10000, "params+start at the sink");
  if (seen.params.rateHz !== TONE_RATE || seen.params.channels !== TONE_CHANNELS) {
    throw new Error(
      `wrong params at the sink: rate=${seen.params.rateHz} ch=${seen.params.channels}`,
    );
  }

  // 2. Volume: at least the full tone arrived (drain may pad a partial period,
  //    so >=, not ==).
  await waitFor(() => seen.bytes >= EXPECT_BYTES, 15000, "full tone PCM at the sink");

  // 3. Content: bit-exact prefix against the same sine series alsa-tone
  //    generates (s16le interleaved, both channels identical).
  const all = new Uint8Array(seen.bytes);
  {
    let off = 0;
    for (const c of seen.chunks) {
      all.set(c, off);
      off += c.length;
    }
  }
  const got = new Int16Array(all.buffer, 0, 2048);
  // C lround() rounds half AWAY FROM ZERO; JS Math.round rounds half up —
  // they differ on negative .5 values (-16383.5 → -16384 vs -16383).
  const lround = (x) => Math.sign(x) * Math.round(Math.abs(x));
  for (let i = 0; i < got.length; i++) {
    const frame = Math.floor(i / TONE_CHANNELS);
    const v = lround(0.5 * 32767 * Math.sin((2 * Math.PI * TONE_HZ * frame) / TONE_RATE));
    if (got[i] !== v) {
      throw new Error(`PCM mismatch at sample ${i}: got ${got[i]}, expected ${v}`);
    }
  }

  console.log(
    `[snd-smoke] params=${seen.params.rateHz}Hz/${seen.params.channels}ch ` +
      `bytes=${seen.bytes} (expected >= ${EXPECT_BYTES}) prefix bit-exact — all good`,
  );
  pass = true;
} catch (e) {
  console.log("[snd-smoke] " + (e && e.message ? e.message : e));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}

console.log("\n[snd-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
