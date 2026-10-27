import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildReplayScript, isPlaybackFormat, type ReplayScript, readWav } from "./arham-replay";

/**
 * Arham's recorded test session, on this machine only, for the live screen
 * demo's "Real Sarah voice" script (development only).
 *
 * ── Where it comes from ──────────────────────────────────────
 *
 * PREVIEW_ARHAM_SESSION_DIR (in .env.local) names the session folder: its
 * session.json and interviewer_turn_NNN.wav files. Unset, missing, without a
 * readable session.json, or in a production build: there is no replay, and
 * the demo does not offer it. Nothing from the folder is ever copied into the
 * repository or a static path.
 *
 * ── Served, never stored ─────────────────────────────────────
 *
 * Only the interviewer clips the session JSON names are read, by their clip
 * id, through the dev-only routes under /interview/preview-live/arham. A clip
 * already in the playback format (24 kHz mono 16-bit) is sent as its PCM
 * samples. Any other is converted with macOS afconvert into a cache in the
 * system temp folder, outside the repository, keyed by the folder. Candidate
 * audio is never read.
 */

export const ARHAM_SESSION_ENV = "PREVIEW_ARHAM_SESSION_DIR";

const run = promisify(execFile);

/** The session folder, or null: never in production, never without session.json. */
export function arhamSessionDir(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const raw = process.env[ARHAM_SESSION_ENV]?.trim();
  if (!raw) return null;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(expanded)) return null;
  const dir = resolve(expanded);
  try {
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "session.json"))) return null;
  } catch {
    return null;
  }
  return dir;
}

export function arhamReplayAvailable(): boolean {
  return arhamSessionDir() !== null;
}

/** The replay script of the session in the folder, or null. */
export async function readArhamScript(): Promise<ReplayScript | null> {
  const dir = arhamSessionDir();
  if (!dir) return null;
  try {
    return buildReplayScript(JSON.parse(await readFile(join(dir, "session.json"), "utf8")));
  } catch {
    return null;
  }
}

/** One interviewer clip the session names, as 24 kHz mono s16le samples, or null. */
export async function readArhamClip(clip: string): Promise<Uint8Array | null> {
  const dir = arhamSessionDir();
  const script = await readArhamScript();
  if (!dir || !script?.clips.includes(clip)) return null;
  // The id is checked against the session's own names; basename keeps it inside the folder regardless.
  const file = join(dir, `${basename(clip)}.wav`);
  try {
    const wav = readWav(new Uint8Array(await readFile(file)));
    if (!wav) return null;
    if (isPlaybackFormat(wav)) return wav.data;
    const cache = join(
      tmpdir(),
      "remotiv-preview-arham",
      createHash("sha256").update(dir).digest("hex").slice(0, 16),
    );
    await mkdir(cache, { recursive: true });
    const converted = join(cache, `${basename(clip)}.wav`);
    if (!existsSync(converted)) {
      await run("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", file, converted]);
    }
    const again = readWav(new Uint8Array(await readFile(converted)));
    return again && isPlaybackFormat(again) ? again.data : null;
  } catch {
    return null;
  }
}
