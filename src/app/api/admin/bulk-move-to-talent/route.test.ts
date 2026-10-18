/**
 * Bulk Move to Talent (src/app/api/admin/bulk-move-to-talent/route.ts): an AI
 * failure is counted apart from "no CV text", carries its reason, and never
 * creates a talent row. Auth, the database, the extraction and the move action
 * are all fakes installed here; nothing leaves the machine.
 *
 *   node --test src/app/api/admin/bulk-move-to-talent/route.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "next/server": `export const NextResponse = {
  json(body, init) { return { status: init?.status ?? 200, body }; },
};`,
  "@/app/admin/lib/role-guards":
    "export async function requireSuperAdmin() { return { role: 'super_admin' }; }",
  "@/lib/admin-scope":
    'export async function adminApplicationScope() { return "company_id_snapshot.is.null"; }',
  "@/lib/supabase/server": `export function createServiceClient() {
  const make = globalThis.__bulkFakeService;
  if (!make) throw new Error("test: no fake service installed");
  return make();
}`,
  "@/app/admin/applications/actions": `export async function moveApplicationToTalent(id, input) {
  (globalThis.__bulkMoves ??= []).push({ id, input });
  return { success: true, data: { talent_id: "t-" + id } };
}`,
  // The extraction answers from the CV text itself: "OK" succeeds, "FAIL:<reason>" fails with that reason.
  "@/lib/cv-extract": `export async function extractTalentFields(cvText) {
  (globalThis.__bulkExtractions ??= []).push(cvText);
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

/** Run the route over `apps` (id, email, cv_text); returns the response body and the recorded moves. */
async function run(apps) {
  globalThis.__bulkMoves = [];
  globalThis.__bulkExtractions = [];
  globalThis.__bulkFakeService = () =>
    fakeService((table) => {
      if (table === "talent_profiles") return { data: [], error: null };
      if (table === "job_applications") return { data: apps, error: null };
      return { data: null, error: null };
    });
  const res = await POST({ json: async () => ({ ids: apps.map((a) => a.id) }) });
  return {
    status: res.status,
    body: res.body,
    moves: globalThis.__bulkMoves,
    extractions: globalThis.__bulkExtractions,
  };
}

test("AI failures are counted apart from missing CV text, with a per-reason breakdown, and create no talent row", async () => {
  const r = await run([
    { id: "a1", email: "a1@example.com", cv_text: "OK text one" },
    { id: "a2", email: "a2@example.com", cv_text: "" },
    { id: "a3", email: "a3@example.com", cv_text: "FAIL:billing" },
    { id: "a4", email: "a4@example.com", cv_text: "FAIL:rate_limited_or_overloaded" },
    { id: "a5", email: "a5@example.com", cv_text: "FAIL:billing" },
    { id: "a6", email: null, cv_text: "OK text six" },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 1);
  assert.equal(r.body.skipped_no_ai, 1, "only the empty CV text");
  assert.equal(r.body.failed_ai, 3);
  assert.deepEqual(r.body.failed_ai_reasons, { billing: 2, rate_limited_or_overloaded: 1 });
  assert.equal(r.body.skipped_no_email, 1);
  assert.equal(r.body.failed, 0);
  assert.deepEqual(
    r.body.results.map((x) => [x.id, x.result, x.reason ?? null]),
    [
      ["a1", "moved", null],
      ["a2", "skipped_no_ai", null],
      ["a3", "failed_ai", "billing"],
      ["a4", "failed_ai", "rate_limited_or_overloaded"],
      ["a5", "failed_ai", "billing"],
      ["a6", "skipped_no_email", null],
    ],
  );
  assert.deepEqual(
    r.moves.map((m) => m.id),
    ["a1"],
    "a talent row only for the extraction that succeeded",
  );
  assert.equal(r.extractions.length, 4, "no extraction call for empty text or a missing email");
});

test("all successes: the old counters are unchanged and the new ones are zero", async () => {
  const r = await run([
    { id: "b1", email: "b1@example.com", cv_text: "OK" },
    { id: "b2", email: "b2@example.com", cv_text: "OK" },
  ]);
  assert.equal(r.body.moved, 2);
  assert.equal(r.body.failed_ai, 0);
  assert.deepEqual(r.body.failed_ai_reasons, {});
  assert.equal(r.body.skipped_no_ai, 0);
  assert.equal(r.moves.length, 2);
});

/* ── the admin screen's words, pinned to the source ─────────────── */

const dashboard = readFileSync(
  new URL("../../../admin/_components/applications-dashboard.tsx", import.meta.url),
  "utf8",
);

test("the dashboard turns every failure class into one of the fixed sentences, and keeps 'Couldn't read CV' for missing text only", () => {
  for (const reason of [
    "no_cv",
    "no_text",
    "no_key",
    "billing",
    "rate_limited_or_overloaded",
    "timeout",
    "model_error",
    "bad_reply",
  ]) {
    assert.match(dashboard, new RegExp(`^\\s*${reason}:`, "m"), `${reason} has a message`);
  }
  for (const sentence of [
    "This CV has no readable text. Please fill the form manually.",
    "AI pre-fill is unavailable (account or key problem). Please fill the form manually and tell the tech team.",
    "AI is busy right now. Try again in a minute, or fill the form manually.",
    "AI pre-fill failed this time. Try again, or fill the form manually.",
  ]) {
    assert.ok(dashboard.includes(sentence), sentence);
  }
  assert.match(dashboard, /setToast\(prefillFailureMessage\(emptyReason\)\)/);
  assert.match(dashboard, /label: "Couldn't read CV", value: totals\.noCv/);
  assert.match(dashboard, /label: "AI pre-fill failed", value: totals\.failedAi, tone: "bad"/);
  assert.match(dashboard, /totals\.failedAi \+= chunkData\.failed_ai \?\? 0/);
  assert.match(dashboard, /totals\.noCv \+= chunkData\.skipped_no_ai \?\? 0/);
});
