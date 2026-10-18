/**
 * Consent and privacy-notice versions: the constants are pinned to the words
 * on screen, the consent endpoint writes the version once alongside
 * consent_at, and the apply insert writes the privacy-notice version and
 * nothing else changed. The database, next/server, the rate limiter and the
 * session lookup are fakes; nothing leaves the machine.
 *
 *   node --test src/lib/consent-version.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "next/server": `export const NextResponse = {
  json(body, init) { return { status: init?.status ?? 200, body }; },
};`,
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
  "@/lib/interviews/session": `export async function resolveSessionByToken(token) {
  return globalThis.__consentResolved?.[token] ?? null;
}`,
  "@/lib/supabase/server": `export function createServiceClient() {
  const make = globalThis.__consentFakeService;
  if (!make) throw new Error("test: no fake service installed");
  return make();
}`,
};
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { INTERVIEW_CONSENT_SENTENCE, INTERVIEW_CONSENT_VERSION } = await import(
  "./interviews/consent.ts"
);
const { PRIVACY_NOTICE_VERSION } = await import("./privacy-version.ts");
const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const { POST } = await import("../app/api/interview/consent/route.ts");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── the constants are pinned to the words on screen ──────────── */

test("INTERVIEW_CONSENT_VERSION v2 stands for the processor sentence the consent screen shows", () => {
  assert.equal(INTERVIEW_CONSENT_VERSION, "v2");
  const flow = src("../app/interview/[token]/_flow.tsx");
  assert.ok(
    flow.includes(INTERVIEW_CONSENT_SENTENCE),
    "the consent screen's sentence differs from the one the version documents: change both together",
  );
  assert.match(INTERVIEW_CONSENT_SENTENCE, /OpenAI or Anthropic/);
});

test("PRIVACY_NOTICE_VERSION is the privacy page's LAST_UPDATED date, as an ISO date", () => {
  const page = src("../app/privacy/page.tsx");
  const shown = page.match(/const LAST_UPDATED = "([^"]+)";/)[1];
  const iso = new Date(`${shown} 12:00 UTC`).toISOString().slice(0, 10);
  assert.equal(PRIVACY_NOTICE_VERSION, iso, `page says "${shown}"`);
  assert.match(PRIVACY_NOTICE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

/* ── the consent endpoint ───────────────────────────────────────── */

function runConsent(row) {
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  globalThis.__consentResolved = { [token]: { session: { state: "ready" }, row } };
  const service = fakeService(() => ({ data: null, error: null }));
  globalThis.__consentFakeService = () => service;
  return POST({ json: async () => ({ token }) }).then((res) => ({
    res,
    updates: service.queries
      .filter((q) => q.table === "interview_sessions")
      .map((q) => Object.fromEntries(q.calls.map((c) => [c[0], c.slice(1)]))),
  }));
}

test("first consent: consent_at and consent_version are written together, only where consent_at is still null", async () => {
  const before = Date.now();
  const { res, updates } = await runConsent({ id: "s1", consent_at: null });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(updates.length, 1);
  const [u] = updates;
  const [payload] = u.update;
  assert.deepEqual(Object.keys(payload).sort(), ["consent_at", "consent_version"]);
  assert.equal(payload.consent_version, "v2");
  assert.ok(Date.parse(payload.consent_at) >= before - 1000, "a fresh ISO timestamp");
  assert.deepEqual(u.eq, ["id", "s1"]);
  assert.deepEqual(u.is, ["consent_at", null]);
});

test("a second consent changes nothing: no UPDATE at all", async () => {
  const { res, updates } = await runConsent({ id: "s1", consent_at: "2026-10-01T10:00:00.000Z" });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(updates.length, 0);
});

/* ── the apply insert ───────────────────────────────────────────── */

test("the job_applications insert gained exactly privacy_notice_version, from the server constant", () => {
  const route = src("../app/api/apply/route.ts");
  const anchor = route.indexOf("company_id_snapshot: companyIdSnapshot");
  assert.ok(anchor > 0);
  const start = route.lastIndexOf(".insert({", anchor);
  const end = route.indexOf("})", anchor);
  const block = route.slice(start, end);
  const keys = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith(".insert"))
    .map((l) => l.match(/^([a-z_]+)\s*[:,]/)?.[1])
    .filter(Boolean);
  // HEAD's 34 columns, in order, plus the new one at the end.
  assert.deepEqual(keys, [
    "job_id",
    "first_name",
    "last_name",
    "email",
    "phone",
    "linkedin_url",
    "cv_url",
    "cv_path",
    "cv_text",
    "cv_text_status",
    "cv_text_error",
    "status",
    "source",
    "notes",
    "applicant_job_title",
    "role_category",
    "years_experience",
    "degree",
    "institution",
    "city",
    "country",
    "availability",
    "work_type",
    "notice_period",
    "work_location",
    "summary",
    "skills",
    "employment_history",
    "screening_answers",
    "company_id_snapshot",
    "cv_delete_after",
    "source_detail",
    "referrer",
    "landing_path",
    "privacy_notice_version",
  ]);
  assert.match(block, /privacy_notice_version: PRIVACY_NOTICE_VERSION,/);
  assert.match(route, /import \{ PRIVACY_NOTICE_VERSION \} from "@\/lib\/privacy-version";/);
  // Never from the request body.
  assert.doesNotMatch(route, /privacy_notice_version:\s*(body|form|payload|req)/);
});

test("schema.sql carries both columns, nullable and without a default", () => {
  const schema = src("../../schema.sql");
  assert.match(schema, /^\s*consent_version text,/m);
  assert.match(schema, /^\s*privacy_notice_version text,/m);
  assert.doesNotMatch(schema, /consent_version text (NOT NULL|DEFAULT)/);
  assert.doesNotMatch(schema, /privacy_notice_version text (NOT NULL|DEFAULT)/);
});
