/**
 * The single Move to Talent pre-fill route (src/app/api/admin/extract-cv/
 * route.ts): a failed extraction answers ok:true, prefill:null and the
 * extraction's own reason, so the client can say why. Auth, the rate limiter,
 * the database and the extraction are fakes installed here.
 *
 *   node --test src/app/api/admin/extract-cv/route.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "server-only": "export {};",
  "next/server": `export const NextResponse = {
  json(body, init) { return { status: init?.status ?? 200, body }; },
};`,
  "@/app/admin/lib/role-guards":
    "export async function requireAdmin() { return { role: 'admin' }; }",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/lib/admin-scope":
    'export async function adminApplicationScope() { return "company_id_snapshot.is.null"; }',
  "@/lib/supabase/server": `export function createServiceClient() {
  const make = globalThis.__extractFakeService;
  if (!make) throw new Error("test: no fake service installed");
  return make();
}`,
  "@/lib/cv-extract": `export async function extractTalentFields(cvText) {
  if (cvText.startsWith("FAIL:")) return { ok: false, reason: cvText.slice(5) };
  return { ok: true, fields: { applicant_job_title: "Engineer", role_category: "Engineering", years_experience: 3, degree: null, institution: null, city: null, country: null, summary: "s", availability: null, work_type: null, notice_period: null, work_location: null, skills: ["TypeScript"], employment_history: [] } };
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

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { POST } = await import("./route.ts");
console.error = () => {};

const APP_ID = "11111111-1111-4111-8111-111111111111";

async function run(row) {
  globalThis.__extractFakeService = () =>
    fakeService((table, calls) => {
      if (table === "job_applications" && calls.some((c) => c[0] === "update"))
        return { data: null, error: null };
      if (table === "job_applications") return { data: row, error: null };
      return { data: null, error: null };
    });
  const res = await POST({ headers: new Headers(), json: async () => ({ applicationId: APP_ID }) });
  return res;
}

test("no CV text: ok, null prefill, reason no_cv", async () => {
  const res = await run({ id: APP_ID, cv_text: "", summary: null, skills: [] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, prefill: null, reason: "no_cv" });
});

test("an extraction failure: ok, null prefill, and the extraction's own reason", async () => {
  for (const reason of [
    "no_key",
    "billing",
    "rate_limited_or_overloaded",
    "timeout",
    "model_error",
    "bad_reply",
  ]) {
    const res = await run({ id: APP_ID, cv_text: `FAIL:${reason}`, summary: null, skills: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, prefill: null, reason }, reason);
  }
});

test("a successful extraction: the prefill, no reason", async () => {
  const res = await run({
    id: APP_ID,
    cv_text: "Senior engineer with eight years of TypeScript.",
    summary: null,
    skills: [],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.prefill.applicant_job_title, "Engineer");
  assert.equal("reason" in res.body, false);
});
