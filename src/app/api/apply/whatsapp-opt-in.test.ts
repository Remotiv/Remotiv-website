/**
 * #67: the apply form's WhatsApp box is optional and unticked, and /api/apply
 * stores the candidate's choice with the server's time. No tick, or an admin's
 * bulk upload, stores no consent.
 *
 *   node --test src/app/api/apply/whatsapp-opt-in.test.ts
 *
 * POST runs as shipped against fake-postgrest.mjs, with storage accepting the
 * upload and the job_applications insert captured. Synthetic data only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__optInService; }",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { if (!globalThis.__optInAdmin) throw new Error('not an admin'); }",
  "@/lib/ai/cv-score-request": "export async function requestCvScore() { return { ok: true }; }",
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

const JOB = "a0000000-0000-4000-8000-00000000067a";
const COMPANY = "c0000000-0000-4000-8000-00000000067c";

/** A database that accepts one application and keeps what was inserted. */
function world() {
  const inserts = [];
  const svc = fakeService((table, calls) => {
    const insert = calls.find((c) => c[0] === "insert");
    if (table === "jobs") {
      return {
        data: {
          id: JOB,
          title: "Synthetic role",
          status: "open",
          archived_at: null,
          deleted_at: null,
          company_id: COMPANY,
          screening_questions: [],
        },
        error: null,
      };
    }
    if (table === "job_applications" && insert) {
      inserts.push(insert[1]);
      return { data: { id: "app-67" }, error: null };
    }
    if (table === "job_applications") {
      return { data: calls.some((c) => c[0] === "maybeSingle") ? null : [], error: null };
    }
    return { data: null, error: null };
  });
  svc.storage = {
    from: () => ({ upload: async () => ({ error: null }), remove: async () => ({}) }),
  };
  globalThis.__optInService = svc;
  return inserts;
}

async function apply(fields) {
  const fd = new FormData();
  fd.set("job_id", JOB);
  fd.set("first_name", "Syn");
  fd.set("last_name", "Thetic");
  fd.set("email", "syn@example.test");
  fd.set("phone", "0300 1234567");
  fd.set("linkedin_url", "https://www.linkedin.com/in/synthetic");
  fd.set("cv_text", "synthetic cv text");
  fd.set("cv", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "cv.pdf"));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const saved = { error: console.error, log: console.log };
  console.error = () => {};
  console.log = () => {};
  try {
    const res = await POST(new Request("http://localhost/api/apply", { method: "POST", body: fd }));
    return { status: res.status, body: await res.json() };
  } finally {
    Object.assign(console, saved);
  }
}

test("ticked: consent stored with the server's time, taken during the request", async () => {
  const inserts = world();
  const before = Date.now();
  const r = await apply({ whatsapp_opt_in: "yes" });
  const after = Date.now();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].whatsapp_opt_in, true);
  const at = Date.parse(inserts[0].whatsapp_opt_in_at);
  assert.ok(at >= before && at <= after, "the server's clock, now");
});

test("not ticked: no consent and no time, so email only", async () => {
  const inserts = world();
  const r = await apply({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(inserts[0].whatsapp_opt_in, false);
  assert.equal(inserts[0].whatsapp_opt_in_at, null);
});

test("a client-sent time or any other value is not a tick", async () => {
  for (const v of ["on", "true", "1", "YES"]) {
    const inserts = world();
    await apply({ whatsapp_opt_in: v, whatsapp_opt_in_at: "2020-01-01T00:00:00.000Z" });
    assert.equal(inserts[0].whatsapp_opt_in, false, v);
    assert.equal(inserts[0].whatsapp_opt_in_at, null, v);
  }
});

test("an admin's bulk upload never consents for the candidate", async () => {
  globalThis.__optInAdmin = true;
  try {
    const inserts = world();
    const r = await apply({ source: "manual_upload", whatsapp_opt_in: "yes" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(inserts[0].source, "manual_upload");
    assert.equal(inserts[0].whatsapp_opt_in, false);
    assert.equal(inserts[0].whatsapp_opt_in_at, null);
  } finally {
    delete globalThis.__optInAdmin;
  }
});

test("the apply form: optional, unticked by default, the decided label, posted only when ticked", () => {
  const modal = readFileSync(new URL("../../jobs/_apply-modal.tsx", import.meta.url), "utf8");
  assert.match(modal, /const \[whatsAppOptIn, setWhatsAppOptIn\] = useState\(false\);/);
  assert.match(modal, /type="checkbox"\s+checked=\{whatsAppOptIn\}/);
  assert.match(modal, /<span>\{WHATSAPP_OPT_IN_LABEL\}<\/span>/);
  assert.match(
    modal,
    /if \(whatsAppOptIn\) fd\.append\(WHATSAPP_OPT_IN_FIELD, WHATSAPP_OPT_IN_TICKED\);/,
  );
  // Never required: the submit gate does not know about it.
  const gate = /const BASIC_KEYS = \[([^\]]*)\]/.exec(modal)?.[1] ?? "";
  assert.ok(gate.includes('"phone"'), "the gate was found");
  assert.doesNotMatch(gate, /whatsapp/i);
  assert.doesNotMatch(modal, /required[^>]*apply-whatsapp|apply-whatsapp[^>]*required/);
});
