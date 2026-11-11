/**
 * Deleting an interview never shows or logs storage or database text (Fix 1).
 * A storage list that throws, a folder whose files will not go, and a row
 * delete the database refuses each answer with deleteInterview's own message
 * and log one line: a fixed label, the session id, and at most an error code.
 * Never the error's message, details, hint or stack.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/delete-db-errors.test.ts"
 *
 * deleteInterview is the shipped code; the database and storage are
 * fake-live-db.mjs, with this file's own failures injected. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__deleteService; }",
  "@/app/ai-dashboard/lib/company-guards": "export async function getCompanyContext() { return globalThis.__deleteCtx; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return { scoped: false, jobIds: [] }; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function roleAllowsJobAction() { return true; }",
    "export const canAccessJob = roleAllowsJobAction;",
  ].join("\\n"),
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return false; }",
  "@/lib/interviews/review": "export async function listInterviewSessions() {} export async function readNotes() {}",
  "@/lib/interviews/scorecard": "export async function readScorecardFacts() {} export async function requestScorecard() {} export function scorecardRecoveryEligibility() {}",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven() { return true; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { deleteInterview } = await import("./actions.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000f2";
const JOB = "b0000000-0000-4000-8000-0000000000f2";
const APP = "a0000000-0000-4000-8000-0000000000f2";
const SOLO = "d0000000-0000-4000-8000-0000000000f2";
const RAW = {
  message: "RAW-DB-MESSAGE permission denied for table interview_sessions",
  details: `RAW-DB-DETAILS Key (application_id)=(${APP}) is still referenced`,
  hint: "RAW-DB-HINT grant delete to service_role",
};
const STORAGE_RAW = "RAW-STORAGE-TEXT bucket interview-videos: upstream timeout at 10.0.0.7";

function world() {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SOLO,
        company_id: CO,
        application_id: APP,
        job_id: JOB,
        kind: "live",
        attempt: 1,
        previous_attempt_id: null,
        status: "invited",
        provider: null,
        provider_session_id: null,
        started_at: null,
        live_ended_at: null,
        delete_after: "2027-04-01T00:00:00.000Z",
      },
    ],
  });
  db.objects.set(`${SOLO}/t1.wav`, {
    bytes: new Uint8Array([1]),
    contentType: "x",
    createdAt: new Date(),
  });
  globalThis.__deleteService = db.service;
  globalThis.__deleteCtx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
  return db;
}

/** Storage: `list` throws its raw text, or `remove` reports it, as Supabase storage does. */
function failStorage(db, op) {
  const from = db.service.storage.from.bind(db.service.storage);
  db.service.storage.from = (bucket) => {
    const b = from(bucket);
    if (op === "list")
      return { ...b, list: async () => ({ data: null, error: { message: STORAGE_RAW } }) };
    return { ...b, remove: async () => ({ data: null, error: { message: STORAGE_RAW } }) };
  };
}

/** The session row's delete answers `{ data: null, error }`. */
function failRowDelete(db, error) {
  const from = db.service.from.bind(db.service);
  db.service.from = (table) => {
    const query = from(table);
    if (table !== "interview_sessions") return query;
    const { calls } = db.service.queries.at(-1);
    const wrapped = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve, reject) =>
              (calls.some((c) => c[0] === "delete")
                ? Promise.resolve({ data: null, error })
                : query
              ).then(resolve, reject);
          }
          return (...args) => {
            query[prop](...args);
            return wrapped;
          };
        },
      },
    );
    return wrapped;
  };
}

async function del() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log =
    console.warn =
    console.error =
      (...a) =>
        lines.push(
          a
            .map((x) =>
              typeof x === "string"
                ? x
                : x instanceof Error
                  ? `${x.message}\n${x.stack}`
                  : JSON.stringify(x),
            )
            .join(" "),
        );
  try {
    return { result: await deleteInterview(SOLO), lines };
  } finally {
    Object.assign(console, saved);
  }
}

function assertClean({ result, lines }, raws, name) {
  const all = `${JSON.stringify(result)}\n${lines.join("\n")}`;
  for (const raw of raws)
    assert.ok(!all.includes(raw), `${name}: no raw text (${raw.slice(0, 30)})`);
  assert.ok(!all.includes(APP), `${name}: no application id`);
  assert.doesNotMatch(lines.join("\n"), /\bat \S+ \(|node:internal/, `${name}: no stack`);
}

test("delete: a storage list that throws shows the app's message and logs only the session", async () => {
  const db = world();
  failStorage(db, "list");
  const out = await del();
  assert.deepEqual(out.result, {
    ok: false,
    error: "Couldn't reach the recording storage. Nothing was deleted - please try again.",
  });
  assertClean(out, [STORAGE_RAW, "RAW-STORAGE"], "list");
  assert.deepEqual(out.lines, [`[interview] delete ${SOLO}: storage list failed`]);
  assert.equal(db.tables.interview_sessions.length, 1, "nothing deleted");
});

test("delete: files that will not go are counted, never described", async () => {
  const db = world();
  failStorage(db, "remove");
  const out = await del();
  assert.deepEqual(out.result, {
    ok: false,
    error: "1 recording couldn't be deleted, so nothing was removed. Please try again.",
  });
  assertClean(out, [STORAGE_RAW, "RAW-STORAGE"], "remove");
  assert.ok(out.lines.includes(`[interview] delete ${SOLO}: 1 object(s) survived`));
});

test("delete: a refused row delete logs its code only, with raw details and hint, or no code at all", async () => {
  for (const [name, error, code] of [
    ["permission", { code: "42501", ...RAW }, "42501"],
    ["PostgREST", { code: "PGRST301", ...RAW }, "PGRST301"],
    ["no usable code", { code: `x'; ${RAW.message}`, ...RAW }, "unknown"],
  ]) {
    const db = world();
    failRowDelete(db, error);
    const out = await del();
    assert.deepEqual(
      out.result,
      {
        ok: false,
        error: "The recordings were deleted but the interview record wasn't. Please try again.",
      },
      name,
    );
    assertClean(out, [RAW.message, RAW.details, RAW.hint, "RAW-DB"], name);
    assert.ok(
      out.lines.includes(`[interview] delete ${SOLO}: row delete failed (${code})`),
      `${name}: ${out.lines.join(" | ")}`,
    );
  }
});

test("delete: success is unchanged", async () => {
  const db = world();
  const out = await del();
  assert.deepEqual(out.result, { ok: true });
  assert.equal(db.tables.interview_sessions.length, 0);
  assert.equal(db.objects.size, 0);
});
