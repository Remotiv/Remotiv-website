/**
 * The AI Video Interview's consent text and privacy section (lib/interviews/
 * live-consent.ts), with their REAL text: while any fact in them is a
 * placeholder, no candidate can be shown either, no live invite can be sent,
 * no consent can be recorded, and the public privacy page renders neither
 * section 15 nor its link. The privacy page is rendered with react-dom/server.
 *
 *   node --test src/lib/interviews/live-consent.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
  "@/components/navbar": "export function Navbar() { return null; }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;

const consent = await import("./live-consent.ts");
const {
  LIVE_CONSENT,
  LIVE_PRIVACY_SECTION,
  LIVE_INTERVIEW_CONSENT_VERSION,
  placeholdersIn,
  liveConsentReady,
  livePrivacyReady,
  liveConsentScreen,
  livePrivacySection,
  liveConsentGiven,
} = consent;
const { INTERVIEW_CONSENT_VERSION } = await import("./consent.ts");
const { liveInterviewsAvailableFor } = await import("./live-availability.ts");
const { recordLiveConsent, requireLiveConsent } = await import("./live-consent-record.ts");
const { PRIVACY_NOTICE_VERSION } = await import("../privacy-version.ts");
const { default: PrivacyPage } = await import("../../app/privacy/page.tsx");
const { LiveInterviewsSection } = await import("../../app/privacy/_live-interviews-section.tsx");
const { reservePieceUpload, confirmPiece } = await import("./live-video.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "7aad434d-0000-4000-8000-000000000001";
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000f9";
const DASHES = /[–—]/;

/** The approved live-v1 wording. A change to any word must bump the version and this. */
const LIVE_V1_SHA256 = "772f010f7894c87a589ab34f46e5be15ef510b84865d0f503a384e15e12ede93";

test("live-v1 is its own version, pinned to the approved wording; async v2 is untouched", () => {
  assert.equal(LIVE_INTERVIEW_CONSENT_VERSION, "live-v1");
  assert.equal(INTERVIEW_CONSENT_VERSION, "v2");
  assert.equal(
    createHash("sha256").update(JSON.stringify(LIVE_CONSENT)).digest("hex"),
    LIVE_V1_SHA256,
    "the consent text changed: bump LIVE_INTERVIEW_CONSENT_VERSION and this hash",
  );
});

test("hyphens only: no en or em dash anywhere in the new text", () => {
  assert.doesNotMatch(JSON.stringify(LIVE_CONSENT), DASHES);
  assert.doesNotMatch(JSON.stringify(LIVE_PRIVACY_SECTION), DASHES);
  for (const file of [
    "../../app/privacy/_live-interviews-section.tsx",
    "./live-consent.ts",
    "./live-consent-record.ts",
  ]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), DASHES, file);
  }
});

test("the approved wording, word for word where it matters", () => {
  const all = JSON.stringify(LIVE_CONSENT);
  assert.match(all, /Sarah is an AI interviewer, not a person\./);
  assert.match(
    all,
    /Remotiv schedules the recordings and transcripts for deletion six months after you were invited\./,
  );
  assert.match(
    all,
    /Remotiv's AI interview system receives your first name and your CV with your contact details removed/,
  );
  assert.match(
    all,
    /run on servers from RunPod \(our cloud computing provider\) in the Czech Republic and Iceland/,
  );
  assert.match(
    all,
    /The interview server keeps its copy for 30 days, then deletes it automatically\./,
  );
  const privacy = JSON.stringify(LIVE_PRIVACY_SECTION);
  assert.match(
    privacy,
    /If the interview ended part-way, any overall score is clearly marked as partial\. If it ended very early or because of a technical problem, there is no overall score\./,
  );
  assert.doesNotMatch(privacy, /ended early, there is no overall score/);
  assert.match(
    privacy,
    /The interview server keeps its copy for 30 days, then deletes it automatically\./,
  );
  assert.match(privacy, /In addition to section 5: the Czech Republic and Iceland/);
  const runpod = LIVE_PRIVACY_SECTION.blocks
    .flatMap((b) => (b.kind === "ul" ? b.items : []))
    .find((i) => i.lead === "RunPod");
  assert.match(runpod.text, /cloud computing provider, hosts Remotiv's AI interview system/);
  // The interview system is Remotiv's own: never a partner, never a named third party.
  assert.doesNotMatch(all, /partner/i);
  assert.doesNotMatch(privacy, /partner/i);
  assert.match(
    privacy,
    /Remotiv schedules the recordings, the transcripts and Sarah's words for deletion six months after you were invited/,
  );
});

test("placeholders are still in both texts, so neither can be shown", () => {
  const found = new Set(placeholdersIn([LIVE_CONSENT, LIVE_PRIVACY_SECTION]));
  // Two facts still to confirm; the partner placeholders are gone, replaced by real values.
  assert.deepEqual([...found].sort(), ["[CONFIRM: CAMERA VIDEO]", "[CONFIRM: D4 TRANSCRIPTION]"]);
  assert.equal(liveConsentReady(), false);
  assert.equal(livePrivacyReady(), false);
  assert.equal(liveConsentScreen("Northwind"), null, "the consent screen has nothing to show");
  assert.equal(livePrivacySection(), null);
});

test("live cannot be enabled while a placeholder remains: an allowlisted company is still refused", () => {
  const before = process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
  process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = CO;
  try {
    const enabled = liveInterviewsAvailableFor(CO);
    // The rule itself: live enabled while the consent text has a placeholder is a failure.
    assert.ok(
      !(enabled && placeholdersIn(LIVE_CONSENT).length > 0),
      "live is enabled with a placeholder in the consent text",
    );
    assert.equal(enabled, false);
  } finally {
    if (before === undefined) delete process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
    else process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = before;
  }
});

test("no consent can be recorded, and no provider session proven, while the text is unfinished", async () => {
  const db = fakeLiveDb({
    interview_sessions: [
      { id: SESSION, company_id: CO, kind: "live", consent_at: null, consent_version: null },
    ],
  });
  assert.deepEqual(await recordLiveConsent(db.service, SESSION, { agreed: true }), {
    ok: false,
    reason: "not_ready",
  });
  assert.equal(db.tables.interview_sessions[0].consent_at, null, "nothing written");
  db.tables.interview_sessions[0].consent_at = "2026-10-20T09:00:00.000Z";
  db.tables.interview_sessions[0].consent_version = "live-v1";
  await assert.rejects(requireLiveConsent(db.service, SESSION), (e) => e.code === "not_ready");
  assert.equal(liveConsentGiven(db.tables.interview_sessions[0]), true);
  // Only a time AND live-v1: the async version, or a version with no time, is not live consent.
  assert.equal(
    liveConsentGiven({ consent_at: "2026-10-20T09:00:00.000Z", consent_version: "v2" }),
    false,
  );
  assert.equal(
    liveConsentGiven({ consent_at: "2026-10-20T09:00:00.000Z", consent_version: null }),
    false,
  );
  assert.equal(liveConsentGiven({ consent_at: null, consent_version: "live-v1" }), false);
});

test("the camera video endpoints refuse everything while the text is unfinished, even with live-v1 saved", async () => {
  const token = "live-consent-video-token-0123456789";
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: CO,
        kind: "live",
        status: "started",
        token_hash: hashSessionToken(token),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        live_ended_at: null,
        consent_at: "2026-10-20T09:00:00.000Z",
        consent_version: "live-v1",
      },
    ],
  });
  const deps = { service: db.service, fetchHead: async () => new Uint8Array(16) };
  const piece = { token, piece: 0, mimeType: "video/webm", startedAtMs: 0, durationMs: 1000 };
  assert.equal((await reservePieceUpload(piece, deps)).body.code, "consent_required");
  assert.equal((await confirmPiece(piece, deps)).body.code, "consent_required");
  assert.equal(db.tables.live_video_pieces.length, 0, "nothing reserved");
  assert.equal(db.signedUploads.length, 0, "no upload URL");
});

/* ── the public privacy page ──────────────────────────────────── */

const page = () => renderToStaticMarkup(createElement(PrivacyPage));

test("the privacy page renders no section 15 and no link to it while a placeholder remains", () => {
  const html = page();
  assert.ok(!html.includes(`id="${LIVE_PRIVACY_SECTION.id}"`), "section 15 rendered");
  assert.ok(
    !html.includes(`href="#${LIVE_PRIVACY_SECTION.id}"`),
    "the link from section 1 rendered",
  );
  assert.ok(!html.includes(LIVE_PRIVACY_SECTION.title), "the section title rendered");
  assert.equal(placeholdersIn(html).length, 0, "a placeholder reached the public page");
  assert.match(html, /15\. Contact/, "the page is as it was: Contact is still section 15");
  assert.doesNotMatch(html, /16\. Contact/);
  assert.equal(
    PRIVACY_NOTICE_VERSION,
    "2026-10-25",
    "the notice version moves with a published change (here 047, access-record retention), not with the hidden section 15",
  );
});

test("once the facts are filled in, the section renders every block, and nothing of it is a placeholder", () => {
  const filled = JSON.parse(
    JSON.stringify(LIVE_PRIVACY_SECTION).replace(
      new RegExp(consent.LIVE_TEXT_PLACEHOLDER.source, "g"),
      "FILLED",
    ),
  );
  assert.equal(placeholdersIn(filled).length, 0);
  const html = renderToStaticMarkup(createElement(LiveInterviewsSection, { section: filled }));
  assert.match(html, /id="ai-video-interviews"/);
  assert.match(html, /15\. AI video interviews/);
  for (const b of filled.blocks) {
    const text = b.kind === "ul" ? b.items[0].lead : b.text;
    assert.ok(html.includes(text.replaceAll("'", "&#x27;")), text.slice(0, 40));
  }
  assert.doesNotMatch(html, DASHES);
});
