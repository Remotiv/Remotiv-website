/**
 * #47: an interview status this page does not recognise reads "Needs check",
 * never "invited", and nothing meant for an invited interview accepts it.
 *
 *   node --test src/lib/interviews/review-unknown-status.test.ts
 *
 * deriveStatus, listInterviewSessions, loadInterviewSession and ReviewClient
 * run as shipped. The session client is fake-postgrest.mjs answering the
 * session reads from a seed; every other read answers empty. The list page's
 * row is pinned from source (it is a client module full of server actions).
 * Synthetic data only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__unkService; }",
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return true; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return { scoped: false }; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function canAccessJob() { return true; }",
  ].join("\\n"),
  "@/app/ai-dashboard/(gated)/applicants/actions": "export async function updateApplicationStage() { return { success: true }; }",
  "../actions": [
    "addInterviewNote", "adjustAnswerScore", "adjustSessionScore", "deleteInterview", "deleteInterviewNote",
    "getAnswerPlaybackUrl", "revertAnswerScore", "revertSessionScore", "scoreInterview", "setInterviewArchived",
    "updateInterviewNote",
  ].map((n) => "export async function " + n + "() { return { ok: true }; }").join("\\n"),
  "next/navigation": "export function useRouter() { return { refresh() {}, push() {} }; }",
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
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { deriveStatus, listInterviewSessions, loadInterviewSession } = await import("./review.ts");
const { INTERVIEW_STATUS_LABELS } = await import("./review-types.ts");
const { scorecardRecoveryEligibility } = await import("./scorecard.ts");
const { ReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx"
);

const CO = "c0000000-0000-4000-8000-000000000001";
const ctx = {
  companyId: CO,
  memberId: "m-1",
  role: "owner",
  memberName: "Owner",
  company: { id: CO, name: "Acme" },
};
const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const session = (id, status, expires_at = FUTURE) => ({
  id,
  application_id: null,
  job_id: null,
  kind: "async",
  status,
  started_at: null,
  submitted_at: null,
  expires_at,
  delete_after: null,
  invited_by_name: null,
  questions_snapshot: [],
  scoring_snapshot: null,
  archived_at: null,
  created_at: "2026-11-01T00:00:00.000Z",
  previous_attempt_id: null,
});

function world(sessions) {
  globalThis.__unkService = fakeService((table, calls) => {
    const single = calls.some((c) => c[0] === "maybeSingle" || c[0] === "single");
    if (table === "interview_sessions") {
      const id = calls.find((c) => c[0] === "eq" && c[1] === "id")?.[2];
      if (single) return { data: sessions.find((s) => s.id === id) ?? null, error: null };
      return { data: sessions, error: null };
    }
    if (table === "interview_answers") return { data: [], count: 0, error: null };
    return { data: single ? null : [], error: null };
  });
}

/* ── deriveStatus ─────────────────────────────────────────────── */

// Negative control: put `return "invited"` back as the fallthrough and every unknown row reads invited.
test("an unrecognised status, or none, is unknown, even past its deadline; invited only when stored invited", () => {
  for (const stored of ["paused", "", null, "INVITED", "invited "]) {
    assert.equal(deriveStatus(stored, FUTURE), "unknown", JSON.stringify(stored));
    assert.equal(
      deriveStatus(stored, PAST),
      "unknown",
      `${JSON.stringify(stored)} past its deadline`,
    );
  }
  assert.equal(deriveStatus("invited", FUTURE), "invited");
  assert.equal(
    deriveStatus("invited", PAST),
    "expired",
    "a real invite past its deadline is expired",
  );
  assert.equal(deriveStatus("started", FUTURE), "started");
  assert.equal(deriveStatus("started", PAST), "expired");
  assert.equal(deriveStatus("submitted", PAST), "submitted");
  assert.equal(deriveStatus("expired", FUTURE), "expired");
  assert.equal(deriveStatus("cancelled", FUTURE), "cancelled");
  assert.equal(deriveStatus("abandoned", FUTURE), "cancelled");
  assert.equal(INTERVIEW_STATUS_LABELS.unknown, "Needs check");
});

/* ── the list ─────────────────────────────────────────────────── */

const SEED = [
  session("s-invited", "invited"),
  session("s-unknown", "paused"),
  session("s-null", null, PAST),
  session("s-submitted", "submitted"),
];

// Negative control: drop the unknown bucket and the counts no longer reach 'all'.
test("the list counts an unknown status in its own bucket, never as Not started", async () => {
  world(SEED);
  const read = await listInterviewSessions(ctx, {});
  assert.equal(read.ok, true);
  const res = read.value;
  assert.equal(res.counts.unknown, 2, "the unrecognised status and the null one");
  assert.equal(res.counts.invited, 1, "only the real invite");
  assert.equal(res.counts.expired, 0, "a null status past its deadline is not 'expired' either");
  const statusTotal = ["submitted", "started", "invited", "expired", "cancelled", "unknown"]
    .map((k) => res.counts[k])
    .reduce((a, b) => a + b, 0);
  assert.equal(statusTotal, res.counts.all, "the status chips account for every interview");
});

test("the Not started tab never lists an unknown status; the Needs check tab lists only them", async () => {
  world(SEED);
  const notStarted = (await listInterviewSessions(ctx, { status: "invited" })).value;
  assert.deepEqual(
    notStarted.rows.map((r) => r.id),
    ["s-invited"],
  );
  world(SEED);
  const needsCheck = (await listInterviewSessions(ctx, { status: "unknown" })).value;
  assert.deepEqual(needsCheck.rows.map((r) => r.id).sort(), ["s-null", "s-unknown"]);
  assert.ok(needsCheck.rows.every((r) => r.status === "unknown"));
});

/* ── the review page and invited-only paths ───────────────────── */

// Negative control: drop headerWhen's unknown branch and the header reads "Invited … · due …".
test("the review page says Needs check, with no invite or deadline wording", async () => {
  world(SEED);
  const view = await loadInterviewSession(ctx, "s-unknown");
  assert.equal(view.status, "unknown");
  const html = renderToStaticMarkup(
    createElement(ReviewClient, { session: view, viewerRole: "owner" }),
  );
  assert.match(html, /Needs check/);
  assert.doesNotMatch(html, /Invited [^<]*· due/);
});

test("no invited-only path accepts an unknown status", () => {
  // Scoring an interview needs a submitted one: unknown is refused.
  assert.deepEqual(
    scorecardRecoveryEligibility({
      kind: "async",
      status: "unknown",
      scoringEnabled: true,
      hasScoreRow: false,
      pendingTranscripts: 0,
      liveJob: false,
    }),
    { ok: false, block: "not_submitted" },
  );
  // The list row: "Needs check", decided before the invite's "Due …" fallback.
  const client = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/interviews/_interviews-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    client,
    /row\.status === "unknown"\s*\?\s*"Needs check"\s*:\s*`Due \$\{fmtDate\(row\.expiresAt\)\}`/,
  );
  assert.match(client, /\{ key: "unknown", label: "Needs check" \}/);
  assert.match(
    client,
    /const HIDDEN_AT_ZERO: readonly InterviewTab\[\] = \["cancelled", "unknown", "archived"\];/,
  );
  // The Applicants panel's re-send and re-issue compare the STORED status by exact value.
  const panel = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/applicants/_interview-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    panel,
    /const canReissue = session\?\.status === "invited" \|\| session\?\.status === "started";/,
  );
});
