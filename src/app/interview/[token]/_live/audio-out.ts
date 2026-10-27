import { int16ToFloat, PlaybackClock } from "./audio-io";
import type { AudioOut } from "./transport";

/**
 * The interviewer's voice through Web Audio. Chunks play back to back
 * (PlaybackClock); flush() stops every chunk at once, so an interruption is
 * heard as one. The AudioContext is made on the candidate's click, so the
 * browser lets it play.
 */
export function createWebAudioOut(ctx: AudioContext): AudioOut & { close(): void } {
  const clock = new PlaybackClock();
  const playing = new Set<AudioBufferSourceNode>();
  return {
    play(samples, sampleRate) {
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(int16ToFloat(samples) as Float32Array<ArrayBuffer>, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => playing.delete(source);
      playing.add(source);
      source.start(clock.schedule(ctx.currentTime, buffer.duration));
    },
    flush() {
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      playing.clear();
      clock.flush();
    },
    close() {
      this.flush();
    },
  };
}
