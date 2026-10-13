/**
 * Recording step 5, the card: status line, Watch and the inline player. The
 * card is a client component with JSX, which Node's type stripping cannot
 * run, so these are source pins, like final-interview-card.test.ts. The words
 * themselves are tested where they are made (recording-status.test.ts).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/final-recording-card.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RAW = readFileSync(new URL("./_final-interview-card.tsx", import.meta.url), "utf8");
/** Code only: comments may describe a rule in words the pins would otherwise match. */
const CARD = RAW.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The body of one function in the card, up to the next function at its level. */
function body(signature) {
  const start = CARD.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = CARD.slice(start + signature.length);
  const next = rest.search(/\n {2}(async )?function |\nfunction |\nexport function /);
  return CARD.slice(start, next >= 0 ? start + signature.length + next : undefined);
}

test("the status line comes from recordingStatusLine and renders nothing for state none", () => {
  assert.match(CARD, /const recordingLine = recordingStatusLine\(row\.recording,/);
  assert.match(CARD, /\{recordingLine && <RecordingStatus line=\{recordingLine\} \/>\}/);
  // Words carry the meaning; the icon is decoration.
  const status = body("function RecordingStatus(");
  assert.match(status, /aria-hidden="true"/);
  assert.match(status, /\{line\.text\}/);
});

test("the playback URL is fetched only on Watch or a player error, never with the list", () => {
  const calls = CARD.match(/getFinalRecordingPlayback\(/g) ?? [];
  assert.equal(calls.length, 1, "one call site");
  assert.match(
    body("async function fetchPlayback("),
    /await getFinalRecordingPlayback\(recordingId\)/,
  );
  const callers = CARD.match(/fetchPlayback\(/g) ?? [];
  assert.equal(callers.length, 3, "defined once, called from watch and onPlayerError");
  assert.match(body("function watch("), /void fetchPlayback\(rowId, recordingId, false\)/);
  assert.match(CARD, /onClick=\{\(\) => watch\(row\.id, recordingId\)\}/);
  assert.doesNotMatch(body("const load = useCallback("), /Playback/);
});

test("a failed player fetches a fresh URL once, then reports the failure", () => {
  const onError = body("function onPlayerError(");
  assert.match(
    onError,
    /if \(!player\.retried\) \{\s*void fetchPlayback\(player\.rowId, player\.recordingId, true\);/,
  );
  assert.match(onError, /setPlayerError\(/);
  assert.match(CARD, /onError=\{onPlayerError\}/);
});

test("the player: controls, metadata preload, the browser's download control hidden, no download link", () => {
  const video = CARD.slice(CARD.indexOf("<video"), CARD.indexOf("/>", CARD.indexOf("<video")));
  assert.match(video, /\bcontrols\b/);
  assert.match(video, /preload="metadata"/);
  assert.match(video, /controlsList="nodownload"/);
  assert.match(video, /playsInline/);
  assert.match(video, /aria-label=/);
  assert.doesNotMatch(CARD, /\bdownload(=|\s|>)/, "no download attribute anywhere");
  // The caption rule is waived with a reason, as the other players do.
  assert.match(
    RAW,
    /biome-ignore lint\/a11y\/useMediaCaption: meeting recordings have no transcript/,
  );
});

test("a Close control, and focus moves into the player and back to Watch", () => {
  assert.match(CARD, /onClick=\{closePlayer\}/);
  assert.match(CARD, /videoRef\.current\?\.focus\(\)/);
  assert.match(CARD, /watchButtons\.current\.get\(back\)\?\.focus\(\)/);
  assert.match(body("function watch("), /returnFocusTo\.current = rowId;/);
});

test("Watch is for everyone who sees the card: no role check on it", () => {
  const at = CARD.indexOf("{recordingId && !playing && (");
  assert.ok(at > 0);
  const guard = CARD.slice(at, CARD.indexOf("<button", at));
  assert.doesNotMatch(guard, /canManage/);
});

test("the card never sees a storage path, and the player works at narrow widths", () => {
  assert.doesNotMatch(CARD, /storage_path|storagePath/);
  assert.match(CARD, /className="block max-h-\[60vh\] w-full rounded-lg bg-black"/);
});

test("hyphens, never em dashes, in the step 5 card copy", () => {
  const from = RAW.indexOf("── The recording (recording step 5)");
  assert.ok(from > 0);
  const added = [
    RAW.slice(from, RAW.indexOf("*/", from)),
    body("function RecordingStatus("),
    body("async function fetchPlayback("),
    body("function onPlayerError("),
    CARD.slice(
      CARD.indexOf("{playing && player && ("),
      CARD.indexOf("{canManage && confirming && ("),
    ),
  ].join("\n");
  assert.ok(!added.includes(String.fromCharCode(0x2014)), "no em dash");
});
