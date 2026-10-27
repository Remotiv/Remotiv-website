// The mock interviewer's spoken clips, for the live screen demo only
// (/interview/preview-live, AVI commit 10). Never part of the app bundle:
// the preview fetches them through a development-only route that answers
// 404 in production.
//
// Each line in src/app/interview/[token]/_live/mock-lines.ts is spoken with
// macOS `say` (voice Samantha), converted by `afconvert` to 24 kHz mono
// 16-bit little-endian PCM (what the playback path expects), and written as
// <id>.pcm with the WAV header removed. manifest.json records the exact
// words of every clip, so a test can prove the clips match the captions.
//
//   node dev-assets/mock-voice/generate.mjs
//
// macOS only (say, afconvert). Rerun it whenever a line changes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const { MOCK_LINES } = await import(
  new URL("../../src/app/interview/[token]/_live/mock-lines.ts", import.meta.url).href
);

const VOICE = "Samantha";
const RATE = 24_000;

/** The PCM samples of a WAV file: checks the format, returns the data chunk. */
function pcmOf(wav, id) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${id}: not a WAV file`);
  }
  let fmt = null;
  for (let at = 12; at + 8 <= wav.length; ) {
    const name = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (name === "fmt ") {
      fmt = {
        format: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        rate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    }
    if (name === "data") {
      if (fmt?.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) {
        throw new Error(`${id}: expected 24 kHz mono 16-bit PCM, got ${JSON.stringify(fmt)}`);
      }
      return wav.subarray(body, body + size);
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${id}: no data chunk`);
}

const work = mkdtempSync(join(tmpdir(), "mock-voice-"));
const manifest = { voice: VOICE, sampleRate: RATE, encoding: "s16le", channels: 1, clips: {} };
let total = 0;
try {
  for (const [id, text] of Object.entries(MOCK_LINES)) {
    const aiff = join(work, `${id}.aiff`);
    const wav = join(work, `${id}.wav`);
    execFileSync("say", ["-v", VOICE, "-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", aiff, wav]);
    const pcm = pcmOf(readFileSync(wav), id);
    writeFileSync(join(here, `${id}.pcm`), pcm);
    manifest.clips[id] = {
      text,
      bytes: pcm.length,
      ms: Math.round((pcm.length / 2 / RATE) * 1000),
    };
    total += pcm.length;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(here, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${Object.keys(manifest.clips).length} clips, ${total} bytes`);
