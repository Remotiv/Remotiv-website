/**
 * The review page's "Open applicant record" link opens that applicant.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/[sessionId]/review-applicant-link.test.ts"
 *
 * It linked to /ai-dashboard/applicants?open=<id>, a parameter Applicants has
 * never read, so the link landed on the list with nobody open. It now uses
 * ?applicant=, the one deep-link parameter Applicants reads (the drawer flag
 * off; the Split panel or sheet flag on, where the server also picks that
 * applicant's job). ReviewClient is the shipped component, rendered with
 * react-dom/server; its actions, the router and Link are stubbed, as in
 * src/lib/interviews/review-copy.test.ts. Synthetic data only.
 */
// @ts-nocheck - same reason as review-copy.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const noop = "async function noop() { return { ok: true }; }";
const STUBS = {
  "server-only": "",
  "../actions": noop + ["addInterviewNote","adjustAnswerScore","adjustSessionScore","deleteInterview","deleteInterviewNote","getAnswerPlaybackUrl","revertAnswerScore","revertSessionScore","scoreInterview","setInterviewArchived","updateInterviewNote"].map((n) => " export const " + n + " = noop;").join(""),
  "@/app/ai-dashboard/(gated)/applicants/actions": noop + " export const updateApplicationStage = noop;",
  "next/navigation": "export function useRouter() { return { refresh() {}, push() {}, replace() {} }; } export function usePathname() { return '/'; } export function useSearchParams() { return new URLSearchParams(); }",
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
const { ReviewClient } = await import("./_review-client.tsx");

const APP = "a0000000-0000-4000-8000-0000000000a1";

function render({ status, applicationId }) {
  const session = {
    id: "d0000000-0000-4000-8000-0000000000f9",
    applicationId,
    jobId: null,
    candidateName: "Sam Example",
    candidateEmail: "sam@example.test",
    candidateLink: null,
    jobTitle: "Engineer",
    stage: "screening",
    kind: "async",
    status,
    answers: [],
    totalQuestions: 3,
    submittedAt: null,
    startedAt: null,
    expiresAt: "2026-11-04T10:00:00.000Z",
    sentAt: "2026-11-01T09:00:00.000Z",
    deleteAfter: null,
    invitedByName: null,
    archivedAt: null,
    score: null,
    canDelete: false,
    canScore: false,
    purged: false,
    evidenceDeleted: false,
    notes: [],
    viewerMemberId: "m-1",
  };
  return renderToStaticMarkup(createElement(ReviewClient, { session, viewerRole: "owner" }));
}

const applicantLinks = (html) =>
  [...html.matchAll(/href="(\/ai-dashboard\/applicants[^"]*)"/g)].map((m) => m[1]);

for (const status of ["invited", "expired"]) {
  test(`${status}, nothing recorded: the link opens the applicant with ?applicant=`, () => {
    const html = render({ status, applicationId: APP });
    assert.ok(html.includes("Open applicant record"), "the link is not rendered");
    assert.deepEqual(applicantLinks(html), [`/ai-dashboard/applicants?applicant=${APP}`]);
    assert.ok(!html.includes("?open="), "the unread ?open= parameter is back");
  });
}

test("no application behind the session: no link at all", () => {
  const html = render({ status: "invited", applicationId: null });
  assert.equal(applicantLinks(html).length, 0);
  assert.ok(!html.includes("Open applicant record"));
});

test("?applicant= is the parameter Applicants reads; ?open= is not", () => {
  const client = readFileSync(
    new URL("../../applicants/_applicants-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(client, /\.get\("applicant"\)/);
  assert.doesNotMatch(client, /\.get\("open"\)/);
});
