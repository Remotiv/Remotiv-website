/**
 * POST /api/check-duplicate-bulk: admin-only, every row checked or none
 * reported, and customers' applicants kept out.
 *
 *   node --test src/app/api/check-duplicate-bulk/route.test.ts
 *
 * The route and findContactDuplicate run as shipped. Stubbed: the admin guard,
 * the rate limiter, NextResponse, the admin application scope, and the
 * database (fake-postgrest.mjs, answering `.or()` through fake-or-filter.mjs).
 * Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { if (!globalThis.__dupAdmin) throw new Error('Forbidden'); return { role: 'admin' }; }",
  "@/lib/admin-scope": "export async function adminApplicationScope() { return 'company_id_snapshot.is.null'; }",
  "next/server": [
    "export class NextRequest {}",
    "export class NextResponse {",
    "  constructor(body, init) { this.status = init?.status ?? 200; this.body = body ?? ''; }",
    "  static json(body, init) { return new NextResponse(JSON.stringify(body), init); }",
    "}",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { applyOrFilters } = await import("../../../test-support/fake-or-filter.mjs");
const { POST } = await import("./route.ts");

const person = (id, email, extra = {}) => ({
  id,
  first_name: "Syn",
  last_name: id,
  email,
  phone: null,
  ...extra,
});
const TABLES = {
  client_batch_candidates: [person("b1", "inbatch@example.test")],
  job_applications: [
    person("a1", "applied@example.test", { company_id_snapshot: null }),
    person("cust", "customer@example.test", { company_id_snapshot: "c-customer" }),
  ],
  talent_profiles: [person("t1", "talent@example.test")],
};

function install({ admin = true, fail = null } = {}) {
  globalThis.__dupAdmin = admin;
  const svc = fakeService((table, calls) => {
    if (table === fail) return { data: null, error: { code: "57014", message: "timeout" } };
    const answer = applyOrFilters(TABLES[table] ?? [], calls);
    if (answer.error) return { data: null, error: answer.error };
    return { data: answer.rows[0] ?? null, error: null };
  });
  globalThis.__fakeServiceClientForTests = () => svc;
  return svc;
}
const post = async (rows) => {
  const res = await POST({ json: async () => ({ rows }) });
  return { status: res.status, body: JSON.parse(res.body) };
};

test("each row gets its first match, in batch > application > talent order, with the name", async () => {
  install();
  const { status, body } = await post([
    { email: "inbatch@example.test" },
    { email: "applied@example.test" },
    { email: "talent@example.test" },
    { email: "new@example.test" },
    { email: "Applied@Example.test " },
  ]);
  assert.equal(status, 200);
  assert.deepEqual(body.results, [
    { source: "batch", name: "Syn b1" },
    { source: "application", name: "Syn a1" },
    { source: "talent", name: "Syn t1" },
    { source: null, name: null },
    { source: "application", name: "Syn a1" },
  ]);
});

// Negative control: drop the scope from the call and the customer's applicant is reported.
test("a customer's applicant is never reported: the Remotiv-owned scope still applies", async () => {
  const svc = install();
  const { body } = await post([{ email: "customer@example.test" }]);
  assert.deepEqual(body.results, [{ source: null, name: null }]);
  const read = svc.queries.find((q) => q.table === "job_applications");
  assert.ok(read.calls.some((c) => c[0] === "or" && c[1] === "company_id_snapshot.is.null"));
});

// Negative control: return the partial results instead of 503 and these rows read as new.
for (const fail of ["client_batch_candidates", "job_applications", "talent_profiles"]) {
  test(`a failed ${fail} read fails the whole request: 503, no results`, async () => {
    install({ fail });
    const { status, body } = await post([
      { email: "new@example.test" },
      { email: "talent@example.test" },
    ]);
    assert.equal(status, 503);
    assert.equal(body.results, undefined, "no row is reported as new");
    assert.equal(
      body.error,
      "We couldn't check these candidates for duplicates. Nothing was changed. Try again.",
    );
  });
}

test("an adversarial value is data: it neither matches everyone nor fails the request", async () => {
  install();
  const { status, body } = await post([
    { email: "x@example.test,id.not.is.null" },
    { phone: "(021) 555 0101" },
    { email: 'a"b\\c@example.test' },
  ]);
  assert.equal(status, 200);
  assert.deepEqual(body.results, [
    { source: null, name: null },
    { source: null, name: null },
    { source: null, name: null },
  ]);
});

// Negative control: remove the requireAdmin check and this returns 200 with reads made.
test("a non-admin is refused before any read", async () => {
  const svc = install({ admin: false });
  const { status } = await post([{ email: "inbatch@example.test" }]);
  assert.equal(status, 403);
  assert.equal(svc.queries.length, 0);
});

test("the two stale comments are corrected", () => {
  const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /50 rows/);
  assert.doesNotMatch(src, /public apply flow/);
  assert.match(src, /MAX_ROWS \(100\) rows × 3 = 300 queries/);
  assert.match(src, /This route is admin-only \(requireAdmin/);
});
