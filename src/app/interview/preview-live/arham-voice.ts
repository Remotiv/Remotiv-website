import type { MockVoice } from "../[token]/_live/mock-lines";
import type { MockStep } from "../[token]/_live/mock-voxagent";
import type { ReplayScript } from "./arham-replay";

/**
 * The "Real Sarah voice" script's two loaders (live screen demo only): the
 * replay steps and Sarah's recorded clips, from the dev-only routes, fetched
 * once. The clips are keyed by clip id, so each turn plays its own recording.
 * The Samantha clips are kept alongside for the one line Arham's session never
 * recorded: the demo's "Of course, here it is again." on Ask to repeat.
 */
export function arhamReplayLoaders(
  samantha: () => Promise<MockVoice>,
  fetchImpl: typeof fetch = fetch,
): { steps: () => Promise<MockStep[]>; voice: () => Promise<MockVoice> } {
  let script: Promise<ReplayScript> | null = null;
  const load = () => {
    script ??= fetchImpl("/interview/preview-live/arham/script", { cache: "no-store" }).then(
      async (res) => {
        if (!res.ok) throw new Error("no replay script");
        return (await res.json()) as ReplayScript;
      },
    );
    return script;
  };
  return {
    steps: async () => (await load()).steps,
    voice: async () => {
      const { clips } = await load();
      const voice = new Map(await samantha().catch(() => new Map<string, Int16Array>()));
      await Promise.all(
        clips.map(async (id) => {
          try {
            const res = await fetchImpl(`/interview/preview-live/arham/clip/${id}`, {
              cache: "no-store",
            });
            if (!res.ok) return;
            const bytes = await res.arrayBuffer();
            if (bytes.byteLength > 0 && bytes.byteLength % 2 === 0) {
              voice.set(id, new Int16Array(bytes));
            }
          } catch {
            // That turn plays the tone.
          }
        }),
      );
      return voice;
    },
  };
}
