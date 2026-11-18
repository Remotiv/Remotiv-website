/**
 * sendManualMessage's job gate sees the applicant's real job.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/manual-message-scope.test.ts"
 *
 * The application read did not select job_id, so roleAllowsJobAction got ""
 * and refused every recruiter and hiring manager, on their own jobs too, while
 * owners and admins (never job-scoped) were let through.
 *
 * sendManualMessage and the real job-scope module run as shipped. The session
 * is messages-test-hook's; the database is fake-postgrest.mjs. The test stops
 * at the job gate: any read after it (the company lookup comes first) throws
 * PAST_GATE, so "allowed" means the action got past the gate into the send
 * path, and nothing is sent. fetch is blocked. Synthetic data only.
 */
// @ts-nocheck - same reason as the other Messages tests: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { sendManualMessage } = await import("./actions.ts");

globalThis.fetch = async () => {
  throw new Error("network blocked in this test");
};

const CO = "c0000000-0000-4000-8000-000000000001";
const OTHER_CO = "c0000000-0000-4000-8000-000000000002";
const MEMBER = "m0000000-0000-4000-8000-000000000001";
const JOB_A = "a0000000-0000-4000-8000-00000000000a";
const JOB_B = "b0000000-0000-4000-8000-00000000000b";

const APPS = [
  { id: "app-a", company_id_snapshot: CO, job_id: JOB_A },
  { id: "app-b", company_id_snapshot: CO, job_id: JOB_B },
  { id: "app-other", company_id_snapshot: OTHER_CO, job_id: JOB_A },
];
const PAST_GATE = "PAST_GATE";
const NOT_YOURS = "That applicant isn't in your workspace.";

function install(role) {
  const service = fakeService((table, calls) => {
    const eq = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
    if (table === "job_applications") {
      const row = APPS.find(
        (a) =>
          a.id === eq("id") &&
          (eq("company_id_snapshot") === undefined ||
            a.company_id_snapshot === eq("company_id_snapshot")),
      );
      if (!row) return { data: null, error: null };
      // Only the columns the code asked for, as PostgREST returns them.
      const cols = (calls.find((c) => c[0] === "select")?.[1] ?? "")
        .split(",")
        .map((c) => c.trim().replace(/\(.*$/, ""));
      const full = {
        ...row,
        first_name: "Syn",
        last_name: "Thetic",
        email: "s@example.test",
        job_title_snapshot: "Role",
        jobs: { title: "Role" },
      };
      return {
        data: Object.fromEntries(Object.entries(full).filter(([k]) => cols.includes(k))),
        error: null,
      };
    }
    if (table === "job_hiring_team") {
      // The member is on JOB_A's hiring team, in this company only. Answered
      // as .maybeSingle() answers: one row, or null (an empty array is truthy).
      const onTeam =
        eq("company_id") === CO && eq("member_id") === MEMBER && eq("job_id") === JOB_A;
      return { data: onTeam ? { id: "t1" } : null, error: null };
    }
    throw new Error(PAST_GATE);
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = {
    companyId: CO,
    memberId: MEMBER,
    role,
    memberName: "Member",
    company: { id: CO, name: "Acme" },
  };
}

async function attempt(role, applicationId) {
  install(role);
  try {
    const r = await sendManualMessage({
      applicationId,
      subject: "Hello",
      body: "A synthetic message.",
    });
    return r.success === false ? r.error : "returned without refusing";
  } catch (err) {
    return err.message === PAST_GATE ? "allowed" : `threw: ${err.message}`;
  }
}

// Negative control: take job_id back out of the application select and both own-job rows say NOT_YOURS.
for (const role of ["recruiter", "hiring_manager"]) {
  test(`a ${role} can send to an applicant on their own job`, async () => {
    assert.equal(await attempt(role, "app-a"), "allowed");
  });
  test(`a ${role} is refused for an applicant on another job`, async () => {
    assert.equal(await attempt(role, "app-b"), NOT_YOURS);
  });
}

test("an owner is unchanged: any job in the company, never another company's applicant", async () => {
  assert.equal(await attempt("owner", "app-a"), "allowed");
  assert.equal(await attempt("owner", "app-b"), "allowed");
  assert.equal(await attempt("owner", "app-other"), NOT_YOURS);
});
