/**
 * PCM for the live conversation, pure so it is tested without a browser.
 *
 * VoxAgent's protocol (test_interview.html): the microphone goes up as
 * 16 kHz mono PCM s16le, the interviewer comes down as 24 kHz mono PCM
 * s16le. The upstream helpers here (downsample, floatToInt16) are for the
 * real transport; the mock and the real one share the downstream path
 * (int16ToFloat, PlaybackClock) through audio-out.ts.
 */

export const UPSTREAM_HZ = 16_000;
export const DOWNSTREAM_HZ = 24_000;

/** Float samples in -1..1 to s16le values, clipped. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] < 0 ? samples[i] / 0x8000 : samples[i] / 0x7fff;
  }
  return out;
}

/** Down to a lower rate by averaging each output sample's span of input. */
export function downsample(samples: Float32Array, fromHz: number, toHz: number): Float32Array {
  if (toHz > fromHz) throw new Error("downsample: target rate is higher");
  if (toHz === fromHz) return samples.slice();
  const ratio = fromHz / toHz;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    out[i] = to > from ? sum / (to - from) : 0;
  }
  return out;
}

/**
 * When the next chunk of the interviewer's voice starts: right after the
 * last one, or now if the queue has run dry. flush() forgets the queue, so
 * after an interruption the next chunk plays at once.
 */
export class PlaybackClock {
  private next = 0;

  schedule(now: number, durationSeconds: number): number {
    const at = Math.max(now, this.next);
    this.next = at + durationSeconds;
    return at;
  }

  /** Seconds of voice still queued after `now`. */
  queued(now: number): number {
    return Math.max(0, this.next - now);
  }

  flush(): void {
    this.next = 0;
  }
}

/**
 * The mock interviewer's voice: a soft voiced tone with a syllable rhythm,
 * long enough for the text. Made up and deterministic; it only has to sound
 * like someone talking so the speaking state and an interruption can be heard.
 */
export function synthVoice(text: string, sampleRate = DOWNSTREAM_HZ): Int16Array {
  const seconds = Math.min(9, Math.max(1.2, text.length * 0.055));
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = 165 + 18 * Math.sin(2 * Math.PI * 0.7 * t);
    const voice =
      Math.sin(2 * Math.PI * f0 * t) +
      0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.25 * Math.sin(2 * Math.PI * 3 * f0 * t);
    const syllable = Math.sin(Math.PI * ((t * 4.2) % 1)) ** 2;
    const fade = Math.min(1, t / 0.05, (seconds - t) / 0.08);
    out[i] = 0.08 * voice * syllable * fade;
  }
  return floatToInt16(out);
}

/** Seconds of audio in `samples` at `sampleRate`. */
export function durationOf(samples: Int16Array, sampleRate: number): number {
  return samples.length / sampleRate;
}
