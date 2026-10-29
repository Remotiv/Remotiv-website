/**
 * Final interview recordings, as the privacy page and the recording notice
 * describe them, checked against the code that makes each statement true.
 * Recording step 6b, in the pattern of privacy-google-data.test.ts.
 *
 *   node --test src/lib/privacy-final-interview.test.ts
 *
 * Statements this cannot check (provider regions, Recall.ai's own handling,
 * how Google Meet admits guests) are listed in the step 6b report for legal
 * review; they are not pinned here because no code decides them.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const {
  FINAL_RECORDING_PLAYBACK_TTL_SECONDS,
  RECORDING_BOT_NAME,
  RECORDING_BOT_RETENTION_HOURS,
  RECORDING_HOST_HEADS_UP,
  RECORDING_NOTICE_VERSION,
  RECORDING_PRIVACY_HREF,
  RECORDING_RETENTION_MONTHS,
  recordingNoticeText,
} = await import("./final-interviews/constants.ts");

const PAGE = read("src/app/privacy/page.tsx");
const BOOKING_PAGE = read("src/app/book/[token]/_booking-client.tsx");
const ROUTE = read("src/app/api/book/[token]/route.ts");
const BOTS = read("src/lib/final-interviews/bots.ts");
const IMPORT = read("src/lib/final-interviews/import.ts");
const ALERTS = read("src/lib/final-interviews/alerts.ts");
const ACTIONS = read("src/app/ai-dashboard/(gated)/applicants/final-interview-actions.ts");
const APPLICANT_ACTIONS = read("src/app/ai-dashboard/(gated)/applicants/actions.ts");

/** What a reader sees: tags dropped, entities decoded, whitespace collapsed. */
const visible = (jsx) =>
  jsx
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .trim();

/** Section 14, from its anchor to Contact. */
const SECTION = (() => {
  const start = PAGE.indexOf('<section id="final-interviews"');
  const end = PAGE.indexOf("<H2>15. Contact</H2>");
  assert.ok(start > 0 && end > start, "the final-interviews section must sit before Contact");
  return PAGE.slice(start, end);
})();
const TEXT = visible(SECTION);
const PAGE_TEXT = visible(PAGE);
const NOTICE = recordingNoticeText("Acme");

const monthsIn = (text) => [...text.matchAll(/(\d+) months/g)].map((m) => Number(m[1]));
const EM_DASH = String.fromCharCode(0x2014);

/* ── the anchor and the link ────────────────────────────────────── */

test("the section is anchored at #final-interviews and the notice links to it", () => {
  assert.equal(RECORDING_PRIVACY_HREF, "/privacy#final-interviews");
  assert.match(PAGE, /<section id="final-interviews"/);
  assert.match(SECTION, /<H2>14\. Final interview recordings<\/H2>/);
  assert.match(
    code(BOOKING_PAGE),
    /<Link\s+href=\{RECORDING_PRIVACY_HREF\}[\s\S]*?>\s*How we handle interview recordings\s*<\/Link>/,
  );
  // The video-interview part of section 1 links here too.
  assert.match(code(PAGE), /href="#final-interviews"/);
});

/* ── retention ──────────────────────────────────────────────────── */

test("every month figure for final recordings is RECORDING_RETENTION_MONTHS", () => {
  assert.equal(RECORDING_RETENTION_MONTHS, 3);
  assert.deepEqual(monthsIn(TEXT), [RECORDING_RETENTION_MONTHS], "section 14");
  assert.match(
    TEXT,
    new RegExp(`deleted automatically ${RECORDING_RETENTION_MONTHS} months after the interview`),
  );
  assert.deepEqual(monthsIn(NOTICE), [RECORDING_RETENTION_MONTHS], "the notice");
  assert.ok(NOTICE.includes(`deleted ${RECORDING_RETENTION_MONTHS} months after the interview`));
  assert.ok(
    PAGE_TEXT.includes(`Final interview recordings: ${RECORDING_RETENTION_MONTHS} months`),
    "section 3",
  );
  assert.ok(
    PAGE_TEXT.includes(`are deleted ${RECORDING_RETENTION_MONTHS} months after the interview`),
    "section 3 body",
  );
  // The ready bell states the same number, from the constant, not a literal.
  assert.match(ALERTS, /deleted \$\{RECORDING_RETENTION_MONTHS\} months after the interview/);
  assert.doesNotMatch(code(ALERTS), /RECORDING_KEEP_MONTHS|\b6 months\b/);
});

test("the async video interview's own 6 months is untouched", () => {
  assert.ok(PAGE_TEXT.includes("Interview recordings: 6 months"));
  assert.ok(PAGE_TEXT.includes("deleted six months after the interview is issued"));
});

test("'sooner if your application is deleted': the applicant delete removes the files", () => {
  assert.match(TEXT, /or sooner if your application is deleted/);
  assert.match(
    APPLICANT_ACTIONS,
    /await removeApplicationFiles\(service, ctx\.companyId, applicationId, target\.cv_path\)/,
  );
  // ...which removes this application's recordings, this company's only, from their bucket.
  const files = code(read("src/lib/application-files.ts"));
  assert.match(files, /\.from\("final_interview_recordings"\)/);
  assert.match(
    files,
    /\.eq\("application_id", applicationId\)\s*\.eq\("company_id", companyIdSnapshot\)/,
  );
  assert.match(files, /removeConfirmed\(service, FINAL_RECORDING_BUCKET, paths\)/);
});

/* ── Recall.ai's copy ───────────────────────────────────────────── */

test("'within 7 days' covers the retention every bot is created with", () => {
  assert.ok(RECORDING_BOT_RETENTION_HOURS <= 7 * 24, `${RECORDING_BOT_RETENTION_HOURS}h`);
  assert.match(code(BOTS), /retention: \{ type: "timed", hours: RECORDING_BOT_RETENTION_HOURS \}/);
  assert.match(TEXT, /in any case within 7 days/);
  assert.match(PAGE_TEXT, /in any case for no more than 7 days/);
});

test("'deleted as soon as Remotiv has saved its own': the import deletes Recall's copy after the ready row", () => {
  assert.match(TEXT, /Recall\.ai's copy is deleted as soon as Remotiv has saved its own/);
  const flow = code(IMPORT);
  const ready = flow.indexOf("await markReady(run, rec);");
  const finish = flow.indexOf("async function finishWithDelete(");
  const del = flow.indexOf("run.deps.recall.deleteRecording(", finish);
  assert.ok(ready > 0 && finish > 0 && del > finish, "Recall's copy goes in finishWithDelete");
  assert.ok(flow.indexOf("return finishWithDelete(run, rec, key);") > ready, "after the ready row");
});

/* ── who records, who is told, who can watch ────────────────────── */

test("the recorder is named as the code names it, and Recall.ai is named as its processor", () => {
  assert.equal(RECORDING_BOT_NAME, "Remotiv Recorder");
  assert.ok(NOTICE.startsWith(`This interview will be recorded by ${RECORDING_BOT_NAME},`));
  assert.ok(NOTICE.includes("processed by Recall.ai on Remotiv's behalf"));
  assert.match(TEXT, /participant called Remotiv Recorder joins the call/);
  assert.match(PAGE_TEXT, /Recall\.ai - runs Remotiv Recorder/);
});

test("the candidate must confirm before booking; the version they saw is stored", () => {
  assert.match(TEXT, /you must confirm that you understand/);
  assert.match(ROUTE, /if \(isFinal && body\?\.recordingNoticeAcknowledged !== true\)/);
  assert.match(ROUTE, /recordingNotice: isFinal \? \{ version: RECORDING_NOTICE_VERSION \} : null/);
  assert.equal(RECORDING_NOTICE_VERSION, "v2");
});

test("the notice and version the booking page shows are the constants, not a copy", () => {
  assert.match(
    ROUTE,
    /text: recordingNoticeText\(ctx\.company\?\.name \?\? ""\),\s*version: RECORDING_NOTICE_VERSION,/,
  );
  assert.match(code(BOOKING_PAGE), /\{state\.recordingNotice\.text\}/);
  assert.doesNotMatch(
    BOOKING_PAGE,
    /will be recorded by|on Remotiv's behalf/,
    "no second copy of the words",
  );
});

test("v1 acknowledgements stay valid: nothing re-reads the stored version", () => {
  const readers = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
        const text = code(readFileSync(p, "utf8"));
        if (/recording_notice_version/.test(text)) readers.push(relative(ROOT, p));
      }
    });
  walk(join(ROOT, "src"));
  assert.deepEqual(readers, ["src/lib/calendar/bookings.ts"], "written and selected there only");
});

test("the interviewers are told in the calendar invitation, final rounds only", () => {
  assert.match(TEXT, /The interviewers are told in the calendar invitation/);
  const at = ROUTE.indexOf("description: label");
  assert.ok(at > 0);
  const firstJoin = ROUTE.indexOf("].join(", at);
  const finalBranch = ROUTE.slice(at, firstJoin);
  const screeningBranch = ROUTE.slice(firstJoin + 1, ROUTE.indexOf("].join(", firstJoin + 1));
  assert.match(finalBranch, /RECORDING_HOST_HEADS_UP,/, "final rounds carry the heads-up");
  assert.match(finalBranch, /recordingNoticeText\(companyName\),/, "and the notice");
  assert.match(screeningBranch, /interview with/, "the screening branch was found");
  assert.doesNotMatch(
    screeningBranch,
    /RECORDING_HOST_HEADS_UP|recordingNoticeText/,
    "screening unchanged",
  );
  assert.match(
    ROUTE,
    /\.\.\.\(ctx\.final\?\.interviewerEmails \?\? \[\]\)/,
    "interviewers are invited",
  );
  assert.equal(
    RECORDING_HOST_HEADS_UP,
    "This interview will be recorded. Remotiv Recorder will ask to join - please admit it in Google Meet.",
  );
});

test("'a viewing link request is recorded, who and when; valid for up to 3 hours': a log row per signed URL", () => {
  assert.ok(
    TEXT.includes(
      "When an authorized user requests a viewing link, we record who requested it and when. The link is valid for up to 3 hours.",
    ),
  );
  assert.doesNotMatch(TEXT, /opens the recording to watch it/, "the old per-view claim is gone");
  const playback = code(ACTIONS).slice(
    code(ACTIONS).indexOf("export async function getFinalRecordingPlayback("),
  );
  // The log row is written when the signed URL is issued, with the requester; granted_at defaults to now().
  const sign = playback.indexOf(
    ".createSignedUrl(rec.storage_path, FINAL_RECORDING_PLAYBACK_TTL_SECONDS)",
  );
  const log = playback.indexOf('.from("signed_url_logs").insert({');
  assert.ok(sign > 0 && log > sign, "one log row per issued link");
  assert.match(playback, /\.from\("signed_url_logs"\)\.insert\(\{\s*user_id: ctx\.user\.id,/);
  assert.match(playback, /source_table: "final_interview_recordings"/);
  // "Up to 3 hours" is the link's lifetime.
  assert.equal(FINAL_RECORDING_PLAYBACK_TTL_SECONDS, 3 * 60 * 60);
});

/* ── not transcribed, not scored ────────────────────────────────── */

test("no final-interview recording path reaches transcription or AI", () => {
  assert.match(
    TEXT,
    /Remotiv does not transcribe final interview recordings, does not score them with AI, and does not use them to train AI models\./,
  );
  const paths = [
    ...readdirSync(join(ROOT, "src/lib/final-interviews"))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .map((f) => `src/lib/final-interviews/${f}`),
    ...readdirSync(join(ROOT, "src/lib/recall"))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .map((f) => `src/lib/recall/${f}`),
    "src/lib/storage-s3.ts",
    "src/app/ai-dashboard/(gated)/applicants/final-interview-actions.ts",
    "src/app/ai-dashboard/(gated)/applicants/_final-interview-card.tsx",
  ];
  for (const rel of paths) {
    const imports = [...code(read(rel)).matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.doesNotMatch(
        spec,
        /^@\/lib\/ai\/|interviews\/(transcribe|scorecard)|openai|anthropic/,
        `${rel} imports ${spec}`,
      );
    }
    assert.doesNotMatch(code(read(rel)), /api\.openai\.com|whisper|AI_SCORING_MODEL/, rel);
  }
});

/* ── copy ───────────────────────────────────────────────────────── */

test("hyphens, never em dashes, in the new copy", () => {
  for (const [name, text] of [
    ["section 14", SECTION],
    ["notice", NOTICE],
    ["heads-up", RECORDING_HOST_HEADS_UP],
    [
      "bell",
      ALERTS.slice(
        ALERTS.indexOf("It is kept with the applicant"),
        ALERTS.indexOf("It is kept with the applicant") + 120,
      ),
    ],
    [
      "Recall.ai entry",
      PAGE.slice(PAGE.indexOf("Recall.ai</strong>"), PAGE.indexOf("See section 14.") + 20),
    ],
    [
      "section 3 entry",
      PAGE.slice(
        PAGE.indexOf("<H3>Final interview recordings"),
        PAGE.indexOf("who can see them.") + 20,
      ),
    ],
  ]) {
    assert.ok(text.length > 20, `${name} was found`);
    assert.ok(!text.includes(EM_DASH), name);
  }
});
