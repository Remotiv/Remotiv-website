import { MOCK_INTERVIEWER, MOCK_LINES, type MockVoice } from "../[token]/_live/mock-lines";

/**
 * The demo's spoken clips (preview-live only), fetched from the dev-only
 * route and keyed by the exact words of each line, so MockVoxAgent plays a
 * clip only for the very text its caption shows. A clip that fails to load
 * is left out, and that line falls back to the tone.
 */
export const PREVIEW_INTERVIEWER = MOCK_INTERVIEWER;

export async function loadPreviewVoice(fetchImpl: typeof fetch = fetch): Promise<MockVoice> {
  const voice = new Map<string, Int16Array>();
  await Promise.all(
    Object.entries(MOCK_LINES).map(async ([id, text]) => {
      try {
        const res = await fetchImpl(`/interview/preview-live/voice/${id}`, { cache: "no-store" });
        if (!res.ok) return;
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return;
        voice.set(text, new Int16Array(bytes));
      } catch {
        // This line stays a tone.
      }
    }),
  );
  return voice;
}
