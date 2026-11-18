/**
 * #53: the public apply route's same-job duplicate check is an exact match,
 * and its answer carries no date or other detail.
 *
 *   node --test src/app/api/apply/duplicate-check.test.ts
 *
 * POST runs as shipped, as an anonymous candidate. The database is
 * fake-postgrest.mjs answering the way PostgREST does: `ilike` treats `%`,
 * `_` and `*` as wildcards and ignores case, `eq` is exact, and
 * `.maybeSingle()` on more than one row is an error with no data. Storage
 * refuses every upload, so a request that gets PAST the duplicate check ends
 * in the route's 500: "not a duplicate". Nothing is written. Synthetic data
 * only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__dupService; }",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { throw new Error('not an admin'); }",
  "@/lib/ai/cv-score-request": "export async function requestCvScore() {}",
  "@/lib/claim-tokens": "export async function mintClaimToken() { return null; }",
  "@/lib/email/candidate/triggers": "export async function queueApplicationReceived() {}",
  "@/lib/pdf-text": "export async function extractPdfTextServer() { return { text: null, status: 'skipped', error: null }; } export function stripInvalidPgChars(s) { return s; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  if (specifier === "next/server") return next("next/server.js", context);
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { POST } = await import("./route.ts");

const JOB = "a0000000-0000-4000-8000-00000000000a";
const OTHER_JOB = "b0000000-0000-4000-8000-00000000000b";
const APPLIED = "2026-11-02T09:30:00.000Z";

/** PostgREST's like/ilike: `%` and `*` any run, `_` one character. */
function likeToRegExp(pattern, flags) {
  const body = [...pattern]
    .map((c) =>
      c === "%" || c === "*" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`, flags);
}

/** `failRead`: true fails every applications read; "phone" fails only the phone-match read. */
function world(apps, { failRead = false } = {}) {
  const svc = fakeService((table, calls) => {
    if (table === "jobs") {
      return { data: { status: "open", archived_at: null, deleted_at: null }, error: null };
    }
    assert.equal(table, "job_applications", `unexpected read of ${table}`);
    const phoneRead = calls.some((c) => c[0] === "not" && c[1] === "phone");
    if (failRead === true || (failRead === "phone" && phoneRead)) {
      return { data: null, error: { code: "57014", message: "timeout" } };
    }
    let rows = apps;
    for (const [op, col, val] of calls) {
      if (op === "eq") rows = rows.filter((r) => r[col] === val);
      if (op === "ilike") rows = rows.filter((r) => likeToRegExp(val, "i").test(r[col] ?? ""));
      if (op === "not" && col === "phone") rows = rows.filter((r) => r.phone !== null);
    }
    const limit = calls.find((c) => c[0] === "limit")?.[1];
    if (limit !== undefined) rows = rows.slice(0, limit);
    if (calls.some((c) => c[0] === "maybeSingle")) {
      if (rows.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      }
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  });
  svc.uploads = 0;
  svc.storage = {
    from: () => ({
      upload: async () => {
        svc.uploads += 1;
        return { error: { message: "stopped by the test" } };
      },
    }),
  };
  globalThis.__dupService = svc;
  return svc;
}

const app = (id, email, job_id = JOB, phone = null) => ({
  id,
  email,
  phone,
  job_id,
  created_at: APPLIED,
});

async function apply({ email, phone = null, jobId = JOB }) {
  const fd = new FormData();
  fd.set("job_id", jobId);
  fd.set("first_name", "Syn");
  fd.set("last_name", "Thetic");
  if (email !== null) fd.set("email", email);
  if (phone !== null) fd.set("phone", phone);
  fd.set("linkedin_url", "https://www.linkedin.com/in/synthetic");
  fd.set("cv_text", "synthetic cv text");
  fd.set("cv", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "cv.pdf"));
  const res = await POST(new Request("http://localhost/api/apply", { method: "POST", body: fd }));
  return { status: res.status, body: await res.json() };
}

const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};

// Negative control: put `.ilike("email", email.trim())` back and both probes answer 409.
test("a wildcard is not a search: % and _ in a typed email never match someone else's application", async () => {
  for (const probe of ["%@victim.example", "jane_doe@victim.example", "j%@victim.example"]) {
    const svc = world([app("a1", "jane.doe@victim.example")]);
    const r = await quiet(() => apply({ email: probe }));
    assert.notEqual(r.body.error, "duplicate_application", probe);
    assert.equal(svc.uploads, 1, `${probe}: got past the duplicate check`);
  }
});

// Negative control: put `appliedAt: dupMatch.created_at` back in the 409.
test("a real duplicate is still refused, with a fixed message and no date or other detail", async () => {
  for (const typed of ["jane.doe@victim.example", "  Jane.Doe@Victim.Example "]) {
    const svc = world([app("a1", "jane.doe@victim.example")]);
    const r = await apply({ email: typed });
    assert.equal(svc.uploads, 0, "refused before the CV is stored");
    assert.equal(r.status, 409, typed);
    assert.deepEqual(r.body, {
      error: "duplicate_application",
      message: "You have already applied to this job.",
    });
    assert.ok(!JSON.stringify(r.body).includes("2026"), "no date in the answer");
  }
});

test("the same phone on the same job is refused the same way, with no date", async () => {
  world([app("a1", null, JOB, "0300 1234567")]);
  const r = await apply({ email: null, phone: "+92 300 1234567" });
  assert.equal(r.status, 409);
  assert.deepEqual(Object.keys(r.body).sort(), ["error", "message"]);
});

// Negative control: drop `.limit(1)` and two earlier rows make maybeSingle error, letting a third in.
test("an email already on the job twice is still a duplicate", async () => {
  world([app("a1", "jane.doe@victim.example"), app("a2", "jane.doe@victim.example")]);
  const r = await apply({ email: "jane.doe@victim.example" });
  assert.equal(r.status, 409);
});

test("the check is per job: the same email on another job applies", async () => {
  const svc = world([app("a1", "jane.doe@victim.example", OTHER_JOB)]);
  await quiet(() => apply({ email: "jane.doe@victim.example" }));
  assert.equal(svc.uploads, 1, "past the duplicate check");
});

// Negative control: ignore the read's error and the application goes ahead unchecked.
test("a failed duplicate read refuses the application rather than skipping the check", async () => {
  const svc = world([], { failRead: true });
  const r = await quiet(() => apply({ email: "jane.doe@victim.example" }));
  assert.equal(r.status, 500);
  assert.ok(r.body.errorId, "the 500 carries its reference");
  assert.equal(svc.uploads, 0, "stopped at the check: no CV stored, nothing inserted");
});

// Negative control: drop the phoneError branch and the application goes ahead unchecked.
test("a failed phone-match read refuses too, with or without an email that matched nothing", async () => {
  for (const email of [null, "someone.new@example.invalid"]) {
    const svc = world([], { failRead: "phone" });
    const r = await quiet(() => apply({ email, phone: "+92 300 1234567" }));
    assert.equal(r.status, 500, `email ${email === null ? "absent" : "unmatched"}`);
    assert.ok(r.body.errorId, "the 500 carries its reference");
    assert.equal(svc.uploads, 0, "stopped at the check: no CV stored, nothing inserted");
  }
});
