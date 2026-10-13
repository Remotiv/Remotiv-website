/**
 * A drifted application is refused by the list query, and by hydrate too.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/hydrate-scope.test.ts"
 *
 * ── Two layers, tested separately ────────────────────────────
 *
 * There are now two independent filters between a drifted application and the
 * screen, and a test that only exercised the outer one would stop proving
 * anything about the inner one:
 *
 *   OUTER  fetchMessages' list query embeds `job_applications!inner(...)` and
 *          filters `job_applications.company_id_snapshot`. A log pointing at
 *          another company's application does not come back AT ALL, for any
 *          role — the inner join drops the parent row. That is what the
 *          per-role test below asserts.
 *   INNER  hydrate() reads the candidate through the same company filter, so a
 *          foreign application it is handed anyway renders as "Deleted
 *          applicant" with no name, address or job. Nothing reaches it through
 *          the outer filter any more, which is exactly why one test below
 *          configures the fake to IGNORE the embedded filters: otherwise the
 *          inner layer would be unreachable and silently untested, and a
 *          regression in it would surface only if the outer one broke first.
 *
 * The role split this file used to assert is gone on purpose. It recorded that
 * owner and admin saw the drifted row named generically while a scoped role
 * never received it, because scoping ran through an application-id allow-list
 * read that was itself company-filtered. The list query now carries the tenant
 * filter on the joined side unconditionally, so no role sees the row.
 *
 * ── The state these tests seed ───────────────────────────────
 *
 * A `communication_logs` row belonging to THIS company whose `application_id`
 * points at an application that now belongs to ANOTHER company. Nothing in the
 * database forbids it: the only foreign key on that column is
 * `communication_logs_application_id_fkey`, a single-column reference to
 * `job_applications(id)`, so it proves the application exists and says nothing
 * about whose it is. The agreement between a log's company and its
 * application's `company_id_snapshot` is written by the senders and enforced by
 * no constraint.
 *
 * ── Why the pair ─────────────────────────────────────────────
 *
 * The leak test alone would pass if the filter named a column that matches
 * nothing — no row comes back, so nothing leaks, while every real candidate in
 * the Messages list silently renders as "Deleted applicant". The happy-path
 * test is what fails in that direction. Neither test is meaningful without the
 * other.
 *
 * `fetchMessages`, `fetchApplicationMessages`, `hydrate`, `getJobScope`,
 * `canSeeApplication` and `canAccessJob` all run as shipped. Only the session
 * and the database are fakes, and the responder HONOURS the filters it is
 * handed — including the embedded ones — so an unfiltered read is
 * distinguishable from one that matched nothing.
 */
// @ts-nocheck — same reason as recipients-scope.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
// Nothing ships from this file.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchApplicationMessages, fetchMessages } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_F = "f0000000-0000-0000-0000-00000000000f";
const MEMBER = "11111111-1111-1111-1111-111111111111";

const OURS = {
  id: "app-a1",
  company_id_snapshot: CO,
  job_id: JOB_A,
  first_name: "Ada",
  last_name: "One",
  email: "ada@example.test",
  job_title_snapshot: "Engineer",
  jobs: { title: "Engineer" },
};

/**
 * The drift probe. Returned by the fake only if the read forgot
 * company_id_snapshot, so none of its fields may reach the output.
 */
const DRIFTED = {
  id: "app-drifted",
  company_id_snapshot: OTHER_CO,
  job_id: JOB_F,
  first_name: "Nope",
  last_name: "Nobody",
  email: "nope@other.test",
  job_title_snapshot: "Spy",
  jobs: { title: "Spy" },
};

/**
 * Both logs are OURS — same company_id, same tenant. Only the applications
 * they point at differ, which is the whole point: the log read cannot tell
 * these two rows apart.
 *
 * `to_address` on the drifted row is the foreign candidate's address. It lives
 * on our own log row, so no filter on job_applications can remove it — what
 * must hold is that hydrate does not promote it into `candidateEmail`, which
 * is the `deleted` branch's job.
 */
const LOGS = [
  {
    id: "log-ours",
    company_id: CO,
    application_id: OURS.id,
    event: "manual",
    status: "sent",
    to_address: "ada@example.test",
    subject: "Interview invitation",
    body: "<p>Congratulations</p>",
    scheduled_for: null,
    sent_at: "2026-03-04T00:00:00Z",
    sent_by_name: "Olive Owner",
    created_at: "2026-03-04T00:00:00Z",
  },
  {
    id: "log-drifted",
    company_id: CO,
    application_id: DRIFTED.id,
    event: "manual",
    status: "sent",
    to_address: "nope@other.test",
    subject: "Scheduling",
    body: "<p>Thanks</p>",
    scheduled_for: null,
    sent_at: "2026-03-03T00:00:00Z",
    sent_by_name: "Olive Owner",
    created_at: "2026-03-03T00:00:00Z",
  },
];

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: MEMBER,
  memberName: "Test Member",
  user: { id: "u-1", email: "member@example.test" },
  company: { name: "Acme" },
});

const pick = (calls, method, col) =>
  calls.find((c) => c[0] === method && (col === undefined || c[1] === col));
const eqOn = (calls, col) => pick(calls, "eq", col)?.[2];
const inOn = (calls, col) => pick(calls, "in", col)?.[2];

/**
 * PostgREST's embedded-join semantics, enough of them to tell the three
 * plausible mistakes apart.
 *
 * `select("..., job_applications!inner(job_id, company_id_snapshot)")` joins
 * each log to its application and, because the join is INNER, a log with no
 * matching application is dropped and filters named
 * `job_applications.<column>` restrict the LOG rows. Drop the `!inner` and the
 * embed becomes a LEFT join: the parent survives regardless and those same
 * filters narrow only the embedded side, which is a silent no-op from the
 * list's point of view. Remove the embed from the select and there is nothing
 * to filter through at all.
 *
 * Modelling all three is what lets this fake fail when the filter is deleted,
 * when `!inner` is weakened, and when the embed is dropped — rather than only
 * recording that a method was called.
 */
function applyEmbed(rows, calls, apps) {
  const selectText = pick(calls, "select")?.[1];
  const embed = /job_applications(!\w+)?\s*\(/.exec(
    typeof selectText === "string" ? selectText : "",
  );
  if (!embed) return rows;
  if (embed[1] !== "!inner") return rows;

  const byId = new Map(apps.map((a) => [a.id, a]));
  const snapshot = eqOn(calls, "job_applications.company_id_snapshot");
  const jobs = inOn(calls, "job_applications.job_id");
  return rows.filter((r) => {
    const app = byId.get(r.application_id);
    if (!app) return false;
    if (snapshot !== undefined && app.company_id_snapshot !== snapshot) return false;
    if (jobs && !jobs.includes(app.job_id)) return false;
    return true;
  });
}

/**
 * A database that applies the filters it is given.
 *
 * Every narrowing is looked up BY COLUMN NAME rather than by position, so a
 * filter on a mistyped column is simply not found and the read comes back
 * unfiltered — which is what makes the leak test able to fail.
 *
 * `honourEmbed: false` makes the log read ignore the embedded join, which is
 * how the hydrate-layer test reaches hydrate with a row the shipped query
 * would never return. It is a deliberate deviation, used once and named.
 */
function world(assignments = [], { honourEmbed = true } = {}) {
  return fakeService((table, calls) => {
    if (table === "job_hiring_team") {
      let rows = assignments.map((job_id) => ({ job_id }));
      const job = eqOn(calls, "job_id");
      if (job !== undefined) rows = rows.filter((r) => r.job_id === job);
      if (pick(calls, "maybeSingle")) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    if (table === "job_applications") {
      let rows = [OURS, DRIFTED];
      const company = eqOn(calls, "company_id_snapshot");
      if (company !== undefined) rows = rows.filter((r) => r.company_id_snapshot === company);
      const one = eqOn(calls, "id");
      if (one !== undefined) rows = rows.filter((r) => r.id === one);
      const ids = inOn(calls, "id");
      if (ids) rows = rows.filter((r) => ids.includes(r.id));
      const jobs = inOn(calls, "job_id");
      if (jobs) rows = rows.filter((r) => jobs.includes(r.job_id));
      if (pick(calls, "maybeSingle")) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    if (table === "communication_logs") {
      let rows = LOGS;
      const company = eqOn(calls, "company_id");
      if (company !== undefined) rows = rows.filter((r) => r.company_id === company);
      const app = eqOn(calls, "application_id");
      if (app !== undefined) rows = rows.filter((r) => r.application_id === app);
      const allowed = inOn(calls, "application_id");
      if (allowed) rows = rows.filter((r) => allowed.includes(r.application_id));
      if (pick(calls, "not")) rows = rows.filter((r) => r.application_id !== null);
      for (const c of calls.filter((c) => c[0] === "neq")) {
        rows = rows.filter((r) => r[c[1]] !== c[2]);
      }
      if (honourEmbed) rows = applyEmbed(rows, calls, [OURS, DRIFTED]);
      const select = pick(calls, "select");
      if (select?.[2]?.head) return { count: rows.length, error: null };
      return { data: rows, error: null };
    }

    throw new Error(`test: unexpected table ${table}`);
  });
}

async function as(role, act, assignments = [], options) {
  const service = world(assignments, options);
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor(role);
  try {
    return { result: await act(), service };
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

const listFor = (role, assignments, options) =>
  as(
    role,
    () => fetchMessages({ tab: "all", jobId: "", search: "", page: 0 }),
    assignments,
    options,
  );

const rowById = (rows, id) => rows.find((r) => r.id === id);

/** Nothing belonging to the other company's candidate, anywhere in the payload. */
function assertNoForeignTrace(payload, where) {
  const seen = JSON.stringify(payload);
  for (const secret of ["Nope", "Nobody", "nope@other.test", "Spy", JOB_F]) {
    assert.ok(!seen.includes(secret), `${where} carried the other company's "${secret}"`);
  }
}

test("the list does not return a log whose application drifted to another company", async () => {
  const { result } = await listFor("owner");
  assert.equal(result.ok, true);

  assertNoForeignTrace(result.value, "the Messages list");

  // The row is gone, not degraded. The inner join on the tenant column drops
  // it, so there is nothing left for hydrate to name — and the footer total
  // agrees with the rows under it because both queries carry the same filter.
  assert.equal(result.value.rows.length, 1);
  assert.equal(result.value.matching, 1);
  assert.equal(rowById(result.value.rows, "log-drifted"), undefined);
});

test("hydrate still refuses to name a drifted applicant it is handed anyway", async () => {
  // The fake ignores the embedded filters here, and ONLY here. The shipped
  // query no longer lets this row through, so this is the one way to keep the
  // inner layer under test: if the embed were ever weakened or removed, the
  // assertions below are what still stand between a foreign candidate's name
  // and the screen.
  const { result } = await listFor("owner", [], { honourEmbed: false });
  assert.equal(result.ok, true);
  assertNoForeignTrace(result.value, "the Messages list with the embed disabled");

  assert.equal(result.value.rows.length, 2, "the deviation must actually deliver both rows");

  const drifted = rowById(result.value.rows, "log-drifted");
  assert.ok(drifted, "the drifted row must reach hydrate for this test to mean anything");
  assert.equal(drifted.candidateName, "Deleted applicant");
  assert.equal(drifted.candidateEmail, "");
  assert.equal(drifted.jobId, null);
  assert.equal(drifted.jobTitle, "—");
  // Our own log's columns are untouched: the filter narrows the candidate read,
  // not the record of what this company sent.
  assert.equal(drifted.subject, "Scheduling");
  assert.equal(drifted.sentByName, "Olive Owner");
});

test("the list still names this company's own candidate in full", async () => {
  const { result } = await listFor("owner");
  const ours = rowById(result.value.rows, "log-ours");
  assert.ok(ours, "this company's own row must be listed");
  // The direction the leak test cannot see. A filter on a column that matches
  // nothing blanks these three and leaks nothing.
  assert.equal(ours.candidateName, "Ada One");
  assert.equal(ours.candidateEmail, "ada@example.test");
  assert.equal(ours.jobTitle, "Engineer");
  assert.equal(ours.jobId, JOB_A);
});

test("the candidate read is filtered on company and costs no extra query", async () => {
  const { service } = await listFor("owner");
  const reads = service.queries.filter((q) => q.table === "job_applications");
  // Exactly one: hydrate's own batched read. The filter was added to it rather
  // than beside it, so the page issues no round trip it did not issue before.
  assert.equal(reads.length, 1, "hydrate must not add a second applications read");
  assert.equal(eqOn(reads[0].calls, "company_id_snapshot"), CO);
  // One id, because the list query already dropped the drifted log. The filter
  // on this read is asserted all the same: it is the inner layer, and the test
  // above drives it with a row that reaches it.
  assert.deepEqual(inOn(reads[0].calls, "id"), [OURS.id]);
});

test("no role is shown the drifted candidate, and every role still sees its own", async () => {
  for (const [role, assignments] of [
    ["owner", []],
    ["admin", []],
    ["recruiter", [JOB_A]],
    ["hiring_manager", [JOB_A]],
  ]) {
    const { result } = await listFor(role, assignments);
    assert.equal(result.ok, true, `${role} could not read the list`);
    assertNoForeignTrace(result.value, `the list as ${role}`);

    const ours = rowById(result.value.rows, "log-ours");
    assert.ok(ours, `${role} lost sight of its own company's message`);
    assert.equal(ours.candidateName, "Ada One", `${role} lost the candidate's name`);
    assert.equal(ours.candidateEmail, "ada@example.test", `${role} lost the address`);

    /*
     * No role diverges any more, and that is the change this asserts.
     *
     * The embedded tenant filter sits outside the `scope.scoped` branch, so it
     * applies to the site-wide roles too. Owner and admin used to receive this
     * row and render it as "Deleted applicant"; they no longer receive it. A
     * log of this company's pointing at another company's application is a
     * broken record, and an owner has no more business reading one than a
     * recruiter does.
     */
    assert.equal(
      rowById(result.value.rows, "log-drifted"),
      undefined,
      `${role} was shown a message whose application belongs to another company`,
    );
    assert.equal(result.value.rows.length, 1, `${role} saw an unexpected extra row`);
    assert.equal(result.value.matching, 1, `${role} got a total that disagrees with the rows`);
  }
});

test("the drawer refuses a drifted applicant before it reads any message", async () => {
  const { result, service } = await as("owner", () => fetchApplicationMessages(DRIFTED.id));
  // canSeeApplication filters on company, so this caller short-circuits and
  // hydrate is never reached. The drawer was never the exposed path.
  assert.deepEqual(result, { ok: true, rows: [], truncated: false });
  assert.equal(
    service.queries.filter((q) => q.table === "communication_logs").length,
    0,
    "a refused applicant must not have their log read at all",
  );
});

test("the drawer still shows this company's own trail", async () => {
  const { result } = await as("owner", () => fetchApplicationMessages(OURS.id));
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].candidateName, "Ada One");
  assert.equal(result.rows[0].candidateEmail, "ada@example.test");
  assert.equal(result.rows[0].jobTitle, "Engineer");
});
