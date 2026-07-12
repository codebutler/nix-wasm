/*
 * alsa-tone — in-guest ALSA playback test for the virtio-snd sound card
 * (issue #145). Opens an ALSA PCM device through alsa-lib (the REAL userspace
 * path — snd_pcm_open goes through the alsa.conf config tree, exactly like
 * aplay/libcanberra), sets 48kHz s16 stereo, writes a DETERMINISTIC 440Hz sine
 * (so the host-side smoke can assert the exact samples the device model
 * received), drains, and prints a parseable result line.
 *
 * Usage: alsa-tone [device]   (default "default")
 *
 * The generated signal (both channels identical):
 *   sample[i] = (int16) round(0.5 * 32767 * sin(2*pi*440*i/48000)),
 * TONE_FRAMES frames total. The host smoke (runtime/demo/node/snd-smoke.mjs)
 * regenerates the same series and compares the received PCM prefix
 * byte-for-byte (the tail may be silence-padded by snd_pcm_drain's final
 * partial period — that's why only the prefix is compared).
 *
 * Output markers (grepped by the smoke; see the #96 marker rules — values are
 * printed as expanded numbers and no marker is a substring of another):
 *   ALSA-TONE: card=<name> rate=48000 ch=2 frames=<n>
 *   ALSA-TONE-RESULT: OK | FAIL <step>: <alsa error>
 */
#include <alsa/asoundlib.h>
#include <math.h>
#include <stdio.h>

#define TONE_RATE 48000
#define TONE_CHANNELS 2
#define TONE_HZ 440.0
#define TONE_FRAMES 12000 /* 0.25 s at 48 kHz */

static short buf[TONE_FRAMES * TONE_CHANNELS];

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "default";
	snd_pcm_t *pcm;
	int rc;

	rc = snd_pcm_open(&pcm, dev, SND_PCM_STREAM_PLAYBACK, 0);
	if (rc < 0) {
		printf("ALSA-TONE-RESULT: FAIL open: %s\n", snd_strerror(rc));
		return 1;
	}

	/* 48kHz s16le stereo, interleaved; let alsa-lib pick period/buffer
	 * sizes (500ms max latency). This is the one config the virtio-snd
	 * device model advertises, so no plug-layer conversion happens and the
	 * host receives the exact samples written here. */
	rc = snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE,
				SND_PCM_ACCESS_RW_INTERLEAVED, TONE_CHANNELS,
				TONE_RATE, 0 /* no resample */,
				500000 /* 0.5 s max latency */);
	if (rc < 0) {
		printf("ALSA-TONE-RESULT: FAIL set_params: %s\n",
		       snd_strerror(rc));
		return 1;
	}

	/* The virtio-snd driver submits only FULL periods to the device
	 * (sound/virtio/virtio_pcm_msg.c accumulates until msg->length ==
	 * period_bytes), so a final partial period can never complete and
	 * snd_pcm_drain() would time out (~buffer_size*1.1/rate ms) with -EIO.
	 * Pad the tone to a period boundary with silence, exactly like aplay
	 * does before draining. */
	snd_pcm_uframes_t buffer_size = 0, period_size = 0;
	rc = snd_pcm_get_params(pcm, &buffer_size, &period_size);
	if (rc < 0 || period_size == 0) {
		printf("ALSA-TONE-RESULT: FAIL get_params: %s\n",
		       snd_strerror(rc));
		return 1;
	}

	for (int i = 0; i < TONE_FRAMES; i++) {
		double s = sin(2.0 * M_PI * TONE_HZ * i / TONE_RATE);
		short v = (short)lround(0.5 * 32767.0 * s);
		buf[i * TONE_CHANNELS + 0] = v;
		buf[i * TONE_CHANNELS + 1] = v;
	}

	printf("ALSA-TONE: card=%s rate=%d ch=%d frames=%d\n", dev, TONE_RATE,
	       TONE_CHANNELS, TONE_FRAMES);

	snd_pcm_sframes_t left = TONE_FRAMES;
	const short *p = buf;
	while (left > 0) {
		snd_pcm_sframes_t n = snd_pcm_writei(pcm, p, left);
		if (n == -EPIPE) { /* underrun — never expected here */
			snd_pcm_prepare(pcm);
			continue;
		}
		if (n < 0) {
			printf("ALSA-TONE-RESULT: FAIL writei: %s\n",
			       snd_strerror((int)n));
			return 1;
		}
		p += n * TONE_CHANNELS;
		left -= n;
	}

	/* Silence-pad to the period boundary (see the get_params note). */
	snd_pcm_uframes_t pad = TONE_FRAMES % period_size
		? period_size - (TONE_FRAMES % period_size) : 0;
	if (pad) {
		static short zero[8192 * TONE_CHANNELS];
		while (pad > 0) {
			snd_pcm_uframes_t chunk = pad > 8192 ? 8192 : pad;
			snd_pcm_sframes_t n = snd_pcm_writei(pcm, zero, chunk);
			if (n == -EPIPE) {
				snd_pcm_prepare(pcm);
				continue;
			}
			if (n < 0) {
				printf("ALSA-TONE-RESULT: FAIL pad: %s\n",
				       snd_strerror((int)n));
				return 1;
			}
			pad -= n;
		}
	}

	rc = snd_pcm_drain(pcm);
	if (rc < 0) {
		printf("ALSA-TONE-RESULT: FAIL drain: %s\n", snd_strerror(rc));
		return 1;
	}
	snd_pcm_close(pcm);

	printf("ALSA-TONE-RESULT: OK\n");
	return 0;
}
