/**
 * The company-side CV open, run as shipped against a fake database (#97).
 *
 *   node --test "src/app/api/cv/company-application/[id]/route.test.ts"
 *
 * ── What is tested ───────────────────────────────────────────
 *
 * Two checks, in order, before anything is signed or logged: the application
 * belongs to the viewer's company, and the viewer may see its job. The second
 * is the one #97 found missing. The context and the database are fakes
 * (applicants-test-hook.mjs); job-scope is NOT faked, so canAccessJob resolves
 * the hiring team against the fake rows for real, and what is tested is the
 * actual role -> team -> refusal chain.
 *
 * The fake records every table call and every signed-URL request, so the
 * refusals assert the thing the tenant-isolation scanner lists as unprovable
 * from source for this route: that a refused request mints NO signed URL and
 * writes NO signed_url_logs row.
 *
 * ── Fixtures ─────────────────────────────────────────────────
 *
 *   A1  on Job A, company CO     the recruiter's own job
 *   B1  on Job B, company CO     a colleague's job in the same company
 *   C1  on Job C, company CO2    another company
 *   N1  no job, company CO       job deleted (job_id is ON DELETE SET NULL on
 *                                production) or added by hand
 *
 * The recruiter and the hiring manager are on Job A's team only. Synthetic
 * data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../../test-support/applicants-test-hook.mjs", import.meta.url));
// The route builds NextResponse objects; the real module needs a Next runtime.
// This stand-in keeps status, body and headers, which is all the assertions read.
// rate-limit is stubbed as chat/route.test.ts does: its cleanup setInterval
// would keep a bare Node process alive after the last test, and the limit is
// not what this file tests.
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "next/server": [
    "export class NextResponse {",
    "  constructor(body, init) {",
    "    this.status = init?.status ?? 200;",
    "    this.body = body ?? '';",
    "    this.headers = new Map(Object.entries(init?.headers ?? {}));",
    "  }",
    "  static redirect(url, status) {",
    "    const r = new NextResponse('', { status: status ?? 307 });",
    "    r.headers.set('location', String(url));",
    "    return r;",
    "  }",
    "  static json(body, init) { return new NextResponse(JSON.stringify(body), init); }",
    "}",
  ].join("\\n"),
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../../test-support/fake-postgrest.mjs");
const { GET } = await import("./route.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const CO2 = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const JOB_C = "c0000000-0000-0000-0000-00000000000c";
const MEMBER = "m-1";

const APPS = {
  A1: {
    id: "app-a1",
    company_id_snapshot: CO,
    job_id: JOB_A,
    cv_path: "x/a1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
  B1: {
    id: "app-b1",
    company_id_snapshot: CO,
    job_id: JOB_B,
    cv_path: "x/b1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
  C1: {
    id: "app-c1",
    company_id_snapshot: CO2,
    job_id: JOB_C,
    cv_path: "x/c1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
  N1: {
    id: "app-n1",
    company_id_snapshot: CO,
    job_id: null,
    cv_path: "x/n1.pdf",
    cv_url: null,
    cv_delete_after: null,
  },
};

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: MEMBER,
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
  mustChangePassword: false,
});

const eqMap = (calls) =>
  Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));

/**
 * One request as `role`, whose hiring team is `teamJobs`. The responder applies
 * the filters the route and canAccessJob actually send, so dropping either check
 * from the route changes an answer here.
 */
async function open(role, who, { teamJobs = [JOB_A] } = {}) {
  const signed = [];
  const service = fakeService((table, calls) => {
    const eqs = eqMap(calls);
    if (table === "job_applications") {
      const row = Object.values(APPS).find((a) => a.id === eqs.id) ?? null;
      return { data: row, error: null };
    }
    if (table === "job_hiring_team") {
      const onTeam =
        eqs.company_id === CO && eqs.member_id === MEMBER && teamJobs.includes(eqs.job_id);
      return { data: onTeam ? { id: "team-row" } : null, error: null };
    }
    if (table === "signed_url_logs") return { data: null, error: null };
    throw new Error(`unexpected table ${table}`);
  });
  service.storage = {
    from(bucket) {
      return {
        async createSignedUrl(path, ttl, opts) {
          signed.push({ bucket, path, ttl, opts });
          return { data: { signedUrl: `https://signed.test/${path}` }, error: null };
        },
      };
    },
  };
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor(role);

  const id = APPS[who].id;
  const res = await GET(new Request(`https://remotiv.test/api/cv/company-application/${id}`), {
    params: Promise.resolve({ id }),
  });
  const logs = service.queries.filter((q) => q.table === "signed_url_logs");
  return { res, signed, logs };
}

function assertOpened({ res, signed, logs }, who) {
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `https://signed.test/${APPS[who].cv_path}`);
  assert.equal(signed.length, 1, "exactly one signed URL");
  assert.equal(signed[0].path, APPS[who].cv_path);
  assert.equal(logs.length, 1, "exactly one access log row");
  const insert = logs[0].calls.find((c) => c[0] === "insert");
  assert.equal(insert?.[1]?.candidate_id, APPS[who].id);
  assert.equal(insert?.[1]?.was_admin, false);
}

function assertRefused({ res, signed, logs }) {
  assert.equal(res.status, 404);
  assert.match(res.body, /CV not found/);
  assert.match(res.body, /isn't in your workspace, or it no longer exists/);
  assert.equal(signed.length, 0, "a refused request mints no signed URL");
  assert.equal(logs.length, 0, "a refused request writes no signed_url_logs row");
}

test("1. a recruiter on Job A opens A1: 302 to the signed URL, one log row", async () => {
  assertOpened(await open("recruiter", "A1"), "A1");
});

test("2. a recruiter on Job A is refused B1 (same company, another job): 404, nothing signed, nothing logged", async () => {
  assertRefused(await open("recruiter", "B1"));
});

test("3. a hiring manager on Job A is refused B1 the same way", async () => {
  assertRefused(await open("hiring_manager", "B1"));
});

test("4. an owner opens both A1 and B1", async () => {
  assertOpened(await open("owner", "A1"), "A1");
  assertOpened(await open("owner", "B1"), "B1");
});

test("5. every role is refused C1 (another company), nothing signed, nothing logged", async () => {
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    assertRefused(await open(role, "C1"));
  }
});

test("6. an application with no job (job deleted, SET NULL): owner opens it, recruiter is refused", async () => {
  assertOpened(await open("owner", "N1"), "N1");
  assertRefused(await open("recruiter", "N1"));
});

test("7. the wrong-job and wrong-company refusals are byte-identical: the response is not an oracle", async () => {
  const wrongJob = await open("recruiter", "B1");
  const wrongCompany = await open("recruiter", "C1");
  assert.equal(wrongJob.res.status, wrongCompany.res.status);
  assert.equal(wrongJob.res.body, wrongCompany.res.body);
  assert.deepEqual([...wrongJob.res.headers], [...wrongCompany.res.headers]);
});

test("control: the gate is the hiring-team row, not the id - put the recruiter on Job B and B1 opens", async () => {
  assertOpened(await open("recruiter", "B1", { teamJobs: [JOB_A, JOB_B] }), "B1");
});

test("control: the checks run in order - a wrong-company row never reaches the hiring-team read", async () => {
  const reads = [];
  const service = fakeService((table) => {
    reads.push(table);
    if (table === "job_applications") return { data: APPS.C1, error: null };
    return { data: null, error: null };
  });
  service.storage = {
    from: () => ({
      createSignedUrl: async () => {
        throw new Error("must not sign");
      },
    }),
  };
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor("recruiter");
  const res = await GET(new Request("https://remotiv.test/api/cv/company-application/app-c1"), {
    params: Promise.resolve({ id: APPS.C1.id }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(reads, ["job_applications"]);
});
