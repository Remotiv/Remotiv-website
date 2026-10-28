/**
 * Whether a candidate turn's audio could hold an answer, measured from the
 * audio itself. Used only when the transcript came back with no real word
 * (live-transcribe.ts, B4): an empty transcript is then a skip only when the
 * turn's audio is measured silent. Anything else (sound that could be speech,
 * or audio this cannot read) is held for a person, never scored 0. Pure.
 *
 * ── Why not Whisper's own signal, or the turn's length ───────
 *
 * Whisper's no_speech_prob is the model's guess that a segment is silence. It
 * is right often enough to discard text Whisper invents over silence
 * (hasRealWords), but it also fires on quiet or accented speech, and an empty
 * transcript comes with no segments at all. It is never taken as proof that
 * nobody spoke. Length is not either: a 1.5-second "yes" is an answer, and a
 * long turn can be silent. Every turn is measured, whatever its length.
 *
 * ── The measure ──────────────────────────────────────────────
 *
 * 16-bit PCM WAV (what the provider exports), in 20 ms frames. A frame is
 * sound when its RMS is at or above SOUND_RMS (about -50 dBFS: below quiet
 * speech, above a quiet room's hiss). Sound frames form a stretch, bridging a
 * single quiet frame inside a word; a stretch shorter than MIN_RUN_MS is a
 * click or a spike and does not count. Speech is plausible once the counted
 * stretches add up to MIN_SOUND_SHORT_MS in a clip under SHORT_CLIP_MS, or
 * MIN_SOUND_MS in a longer one. A cough or a door is sound too, so it is held
 * for a person: uncertain evidence always errs toward review, never toward 0.
 */

/** About -50 dBFS, as a fraction of full scale: a 20 ms frame at or above it is sound. */
export const SOUND_RMS = 0.00316;
/** Under this a clip counts as short, and needs less sound to hold a word. */
export const SHORT_CLIP_MS = 2_000;
/** Sound a short clip needs to hold a word: about one short syllable. */
export const MIN_SOUND_SHORT_MS = 150;
/** Sound a longer clip needs to hold a word. */
export const MIN_SOUND_MS = 250;
/** A stretch of sound shorter than this is a click or a spike, not speech. */
export const MIN_RUN_MS = 60;
const FRAME_MS = 20;

/**
 *   silent    measured, and no stretch of sound that could be a word
 *   sound     measured, and enough sound to be speech
 *   unknown   not 16-bit PCM WAV, so not measured
 */
export type TurnSpeech = "silent" | "sound" | "unknown";

type Pcm16 = { rate: number; channels: number; samples: Int16Array };

/** The samples of a 16-bit PCM WAV, or null for anything else. */
export function readPcm16Wav(bytes: Uint8Array): Pcm16 | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const name = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (name === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    }
    if (name === "data") {
      if (fmt?.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.rate < 1) {
        return null;
      }
      const end = Math.min(bytes.length, body + size);
      const count = Math.floor((end - body) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { rate: fmt.rate, channels: fmt.channels, samples };
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** Each 20 ms frame: at or above SOUND_RMS. */
function soundFrames(pcm: Pcm16): boolean[] {
  const perFrame = Math.max(1, Math.round((pcm.rate * FRAME_MS) / 1000)) * pcm.channels;
  const frames: boolean[] = [];
  for (let start = 0; start < pcm.samples.length; start += perFrame) {
    const end = Math.min(pcm.samples.length, start + perFrame);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = pcm.samples[i] / 32768;
      sum += s * s;
    }
    frames.push(Math.sqrt(sum / (end - start)) >= SOUND_RMS);
  }
  return frames;
}

/** Milliseconds of sound in stretches long enough to be speech (single quiet frames bridged). */
export function speechMs(frames: readonly boolean[]): number {
  let counted = 0;
  for (let i = 0; i < frames.length; ) {
    if (!frames[i]) {
      i++;
      continue;
    }
    const first = i;
    let last = i;
    let sound = 0;
    while (i < frames.length && (frames[i] || frames[i + 1])) {
      if (frames[i]) {
        sound++;
        last = i;
      }
      i++;
    }
    if ((last - first + 1) * FRAME_MS >= MIN_RUN_MS) counted += sound * FRAME_MS;
  }
  return counted;
}

/** What a turn's audio says about speech. */
export function turnSpeech(bytes: Uint8Array): TurnSpeech {
  const pcm = readPcm16Wav(bytes);
  if (!pcm) return "unknown";
  const lengthMs = (pcm.samples.length / pcm.channels / pcm.rate) * 1000;
  const needed = lengthMs < SHORT_CLIP_MS ? MIN_SOUND_SHORT_MS : MIN_SOUND_MS;
  return speechMs(soundFrames(pcm)) >= needed ? "sound" : "silent";
}

/** An empty transcript over this turn could be a missed answer: hold it for a person. */
export function mayHoldAnswer(speech: TurnSpeech): boolean {
  return speech !== "silent";
}
