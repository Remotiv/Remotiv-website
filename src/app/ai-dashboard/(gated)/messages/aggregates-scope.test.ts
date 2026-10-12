/**
 * The seven Messages tab counts are scoped through the join, not through an
 * application-id allow-list.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/aggregates-scope.test.ts"
 *
 * ── The bug this locks down ──────────────────────────────────
 *
 * base() used to narrow with `.in("application_id", allowedApps)`, where
 * allowedApps was every application id the member could see — unbounded. One
 * uuid costs 39 bytes in a PostgREST query string, so somewhere between 204 and
 * 415 ids the request line crosses a gateway limit and PostgREST answers 414.
 * supabase-js reports that as an `error` beside a null count rather than
 * throwing, and every `count ?? 0` in fetchMessageAggregates then reads 0. The
 * page would tell a recruiter they have no messages while the list underneath
 * showed some — and it would do it to all seven counts at once.
 *
 * ── Why this file carries a join evaluator ───────────────────
 *
 * fake-postgrest.mjs RECORDS calls and lets the responder decide each answer;
 * its own docblock says "filters are recorded, not applied". A responder that
 * merely accepted the query would prove nothing here, because the whole change
 * is which rows the database returns. So `countLogs` below implements the
 * PostgREST semantics this change depends on:
 *
 *   - an unprefixed filter binds to the TOP-LEVEL resource, even when the
 *     embedded table has a column of the same name
 *   - a `job_applications.`-prefixed filter binds to the EMBED
 *   - `!inner` makes the embed restrict the parent, and drops a parent row
 *     whose FK is null or unmatched
 *   - a PLAIN embed is a LEFT join: the embedded filters stop restricting the
 *     parent entirely
 *   - a count comes back only if `count: "exact"` was asked for
 *
 * ── What this proves, and what it does not ───────────────────
 *
 * Those five rules are not this file's guess. Each was measured read-only
 * against production before the change, and the numbers are in the Phase 2
 * report: 146 logs through the `!inner` embed and 146 through the old
 * `.not("application_id", "is", null)` form; 231 — the unfiltered parent
 * population — once the join is widened to a plain embed; and 0 for
 * `status=eq.new` through the embed, which is impossible on a log and common on
 * an application, which is how the parent binding was established.
 *
 * So this file proves the CODE computes the right seven numbers given those
 * semantics. It does not re-prove the semantics; production did that, and this
 * file does not claim otherwise.
 */
// @ts-nocheck — same reason as recipients-scope.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
// Nothing ships from this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchMessageAggregates } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const JOB_C = "c0000000-0000-0000-0000-00000000000c";
const MEMBER = "11111111-1111-1111-1111-111111111111";

const now = Date.now();
const RECENT = new Date(now - 24 * 3600e3).toISOString();
const OLD = new Date(now - 30 * 864e5).toISOString();

/**
 * `status` here is the APPLICATION status, and it deliberately overlaps the
 * column name the seven counts filter on. Its value domain cannot overlap:
 * job_applications is CHECK-constrained to new|shortlisted|not_a_fit|maybe and
 * communication_logs to queued|sent|failed|cancelled|skipped|delivered|read. So
 * if an unprefixed `status` filter ever bound to the embed, the status-filtered
 * counts would collapse to zero rather than quietly shift.
 */
const APPLICATIONS = [
  { id: "app-a1", job_id: JOB_A, company_id_snapshot: CO, status: "new" },
  { id: "app-a2", job_id: JOB_A, company_id_snapshot: CO, status: "new" },
  { id: "app-b1", job_id: JOB_B, company_id_snapshot: CO, status: "shortlisted" },
  { id: "app-c1", job_id: JOB_C, company_id_snapshot: CO, status: "new" },
  // The drift case: sits on one of OUR jobs, but belongs to another company.
  // Only the embedded company_id_snapshot filter excludes it.
  { id: "app-drift", job_id: JOB_A, company_id_snapshot: OTHER_CO, status: "new" },
  {
    id: "app-foreign",
    job_id: "f0000000-0000-0000-0000-00000000000f",
    company_id_snapshot: OTHER_CO,
    status: "new",
  },
];

/**
 * Ten logs chosen so that each filter in base() is the ONLY thing excluding at
 * least one of them. L2 is a second log on app-a1, which is what makes a join
 * fan-out visible as a count of 6 rather than 5.
 */
const LOGS = [
  {
    id: "L1",
    company_id: CO,
    application_id: "app-a1",
    event: "interview_invite",
    status: "sent",
    sent_at: RECENT,
  },
  {
    id: "L2",
    company_id: CO,
    application_id: "app-a1",
    event: "interview_invite",
    status: "sent",
    sent_at: OLD,
  },
  {
    id: "L3",
    company_id: CO,
    application_id: "app-a2",
    event: "manual",
    status: "sent",
    sent_at: RECENT,
  },
  {
    id: "L4",
    company_id: CO,
    application_id: "app-b1",
    event: "rejection",
    status: "failed",
    sent_at: null,
  },
  {
    id: "L5",
    company_id: CO,
    application_id: "app-b1",
    event: "manual",
    status: "queued",
    sent_at: null,
  },
  {
    id: "L6",
    company_id: CO,
    application_id: "app-c1",
    event: "rejection",
    status: "sent",
    sent_at: RECENT,
  },
  // Orphan: ON DELETE SET NULL left the FK null. `!inner` is what drops it.
  {
    id: "L7",
    company_id: CO,
    application_id: null,
    event: "rejection",
    status: "sent",
    sent_at: RECENT,
  },
  // Tombstone for a message that never sent. Excluded by status != cancelled.
  {
    id: "L8",
    company_id: CO,
    application_id: "app-a1",
    event: "rejection",
    status: "cancelled",
    sent_at: null,
  },
  // Drift: our log, another company's application. Excluded ONLY by the
  // embedded company_id_snapshot filter.
  {
    id: "L9",
    company_id: CO,
    application_id: "app-drift",
    event: "rejection",
    status: "sent",
    sent_at: RECENT,
  },
  // Another company's log entirely. Excluded by the parent company_id filter.
  {
    id: "L10",
    company_id: OTHER_CO,
    application_id: "app-foreign",
    event: "rejection",
    status: "sent",
    sent_at: RECENT,
  },
  // Cross-wired probe: another company's log pointing at OUR application. The
  // embedded filter admits it, so the PARENT company_id filter is the only
  // thing excluding it. Without that row, removing the parent filter would move
  // no count and the negative control would not discriminate.
  {
    id: "L11",
    company_id: OTHER_CO,
    application_id: "app-a1",
    event: "rejection",
    status: "sent",
    sent_at: RECENT,
  },
];

/* ── the join evaluator ──────────────────────────────────────── */

function toFilter(method, args) {
  if (method === "eq") return { op: "eq", col: args[0], val: args[1] };
  if (method === "neq") return { op: "neq", col: args[0], val: args[1] };
  if (method === "gte") return { op: "gte", col: args[0], val: args[1] };
  if (method === "in") return { op: "in", col: args[0], val: args[1] };
  if (method === "not" && args[1] === "is" && args[2] === null) {
    return { op: "notnull", col: args[0] };
  }
  throw new Error(`test: evaluator does not model .${method}(${args.join(", ")})`);
}

/** `["eq","status","sent"]` and friends -> something that can be applied. */
function parseFilters(calls) {
  const out = [];
  for (const [method, ...args] of calls) {
    if (method === "select") continue;
    // Paging, not filtering. Only the allow-list read under negative control
    // (e) sets these, and the seed is a handful of rows against a page of
    // 1000, so no page can truncate it and ignoring them is exact here.
    if (method === "range" || method === "limit") continue;
    const f = toFilter(method, args);

    const embedded = f.col.startsWith("job_applications.");
    out.push({ ...f, col: embedded ? f.col.slice("job_applications.".length) : f.col, embedded });
  }
  return out;
}

function matches(row, f) {
  const v = row[f.col];
  if (f.op === "eq") return v === f.val;
  if (f.op === "neq") return v !== f.val;
  if (f.op === "in") return f.val.includes(v);
  if (f.op === "notnull") return v !== null && v !== undefined;
  // A null timestamp is not >= anything, as in SQL.
  if (f.op === "gte") return v !== null && v !== undefined && String(v) >= String(f.val);
  throw new Error(`test: unhandled op ${f.op}`);
}

/** What PostgREST would answer for a HEAD count on communication_logs. */
function countLogs(calls) {
  const select = calls.find((c) => c[0] === "select");
  assert.ok(select, "the counts must go through .select()");
  const columns = String(select[1] ?? "");
  const options = select[2] ?? {};

  const inner = /job_applications!inner\s*\(/.test(columns);
  const plainEmbed = !inner && /job_applications\s*\(/.test(columns);

  const filters = parseFilters(calls);
  const parent = filters.filter((f) => !f.embedded);
  const embedded = filters.filter((f) => f.embedded);

  if (embedded.length && !inner && !plainEmbed) {
    throw new Error("test: a job_applications.* filter with no job_applications embed");
  }

  let rows = LOGS.filter((l) => parent.every((f) => matches(l, f)));

  if (inner) {
    rows = rows.filter((l) => {
      const app = APPLICATIONS.find((a) => a.id === l.application_id);
      // An inner join drops a parent row with a null or unmatched FK. This is
      // what replaces the old explicit `.not("application_id", "is", null)`.
      if (!app) return false;
      return embedded.every((f) => matches(app, f));
    });
  }
  // A plain embed is a LEFT join: the embedded filters null out the embed and
  // leave every parent row standing. Deliberately NOT applied here — that is
  // the cv-purge.ts:309 leak, and negative control (c) depends on it.

  // No count asked for, no count returned — which is what supabase-js hands
  // back on a 414 too, and what every `count ?? 0` turns into a zero.
  if (options.count !== "exact") return { data: null, count: null, error: null };
  return { data: null, count: rows.length, error: null };
}

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: MEMBER,
  memberName: "Test Member",
  user: { id: "u-1", email: "member@example.test" },
  company: { name: "Acme" },
});

/** Run the real action as `role`, with `assignments` as the hiring-team rows. */
async function aggregatesFor(role, assignments = []) {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") {
      return { data: assignments.map((job_id) => ({ job_id })), error: null };
    }
    if (table === "communication_logs") return countLogs(calls);
    if (table === "job_applications") {
      /*
       * Reached only if scopedApplicationIds is called again — the overflow
       * this change removed. Answered rather than thrown, so the SCALE tests
       * can report it as a recorded query instead of a crash.
       *
       * Its filters are HONOURED, which matters: a responder that handed back
       * every row would make the old shape look wrong on the scoped counts for
       * harness reasons, and the old shape's scoped counts were not wrong. The
       * old query is supposed to pass the correctness tests — it is a scale
       * defect, not a counting one — and that is only a real result if this
       * responder behaves like the database.
       */
      const filters = parseFilters(calls);
      return {
        data: APPLICATIONS.filter((a) => filters.every((f) => matches(a, f))),
        error: null,
      };
    }
    throw new Error(`test: unexpected table ${table}`);
  });

  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor(role);
  try {
    return { read: await fetchMessageAggregates(), service };
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

const countsOf = (read) => {
  assert.ok(read.ok, "fetchMessageAggregates returned unavailable");
  return read.value;
};

/* ── CORRECTNESS ─────────────────────────────────────────────── */

/*
 * Hand-computed from LOGS. An unscoped role keeps L1-L6: L7 has a null FK, L8 is
 * cancelled, L9's application belongs to another company, L10 and L11 are
 * another company's logs. L1 and L2 both hang off app-a1, so a fan-out would
 * read 5 here instead of 6.
 */
const UNSCOPED = {
  all: 6,
  written: 1,
  automatic: 4,
  scheduled: 1,
  sent: 4,
  failed: 1,
  sentThisWeek: 3,
};

test("CORRECTNESS: owner sees all seven counts over the whole company", async () => {
  const { read } = await aggregatesFor("owner");
  assert.deepEqual(countsOf(read), UNSCOPED);
});

test("CORRECTNESS: admin is counted identically to owner", async () => {
  const { read } = await aggregatesFor("admin");
  assert.deepEqual(countsOf(read), UNSCOPED);
});

test("CORRECTNESS: a recruiter on a strict subset of jobs sees only those", async () => {
  // JOB_A only: L1, L2, L3. L4/L5 are JOB_B, L6 is JOB_C.
  const { read } = await aggregatesFor("recruiter", [JOB_A]);
  assert.deepEqual(countsOf(read), {
    all: 3,
    written: 1,
    automatic: 2,
    scheduled: 0,
    sent: 3,
    failed: 0,
    sentThisWeek: 2,
  });
});

test("CORRECTNESS: a recruiter on several jobs sees the union, not a chunk of it", async () => {
  const { read } = await aggregatesFor("recruiter", [JOB_A, JOB_B]);
  assert.deepEqual(countsOf(read), {
    all: 5,
    written: 1,
    automatic: 3,
    scheduled: 1,
    sent: 3,
    failed: 1,
    sentThisWeek: 2,
  });
});

test("CORRECTNESS: a hiring manager is scoped the same way", async () => {
  const { read } = await aggregatesFor("hiring_manager", [JOB_B]);
  assert.deepEqual(countsOf(read), {
    all: 2,
    written: 0,
    automatic: 1,
    scheduled: 1,
    sent: 0,
    failed: 1,
    sentThisWeek: 0,
  });
});

test("CORRECTNESS: all = written + automatic + scheduled, for every role", async () => {
  const cases = [
    ["owner", []],
    ["admin", []],
    ["recruiter", [JOB_A]],
    ["recruiter", [JOB_A, JOB_B]],
    ["hiring_manager", [JOB_B]],
  ];
  for (const [role, jobs] of cases) {
    const v = countsOf((await aggregatesFor(role, jobs)).read);
    assert.equal(
      v.all,
      v.written + v.automatic + v.scheduled,
      `${role} ${JSON.stringify(jobs)}: the three tabs must partition the total`,
    );
  }
});

test("CORRECTNESS: a log whose application belongs to another company is never counted", async () => {
  // L9 is the drift row: our log, our job, another company's application. It is
  // on JOB_A, so it would land in the recruiter's counts too.
  for (const [role, jobs] of [
    ["owner", []],
    ["recruiter", [JOB_A]],
  ]) {
    const v = countsOf((await aggregatesFor(role, jobs)).read);
    const expected = role === "owner" ? UNSCOPED.all : 3;
    assert.equal(v.all, expected, `${role} counted the drifted log L9`);
  }
});

test("CORRECTNESS: an orphaned log and a cancelled log are both excluded", async () => {
  // L7 (null FK) and L8 (cancelled) both sit in CO on app-a1's job, so dropping
  // either exclusion shows up as 7 or 8 rather than 6.
  const v = countsOf((await aggregatesFor("owner")).read);
  assert.equal(v.all, 6);
});

test("CORRECTNESS: a scoped role with no assignments reads zero without querying", async () => {
  const { read, service } = await aggregatesFor("recruiter", []);
  assert.deepEqual(countsOf(read), {
    all: 0,
    written: 0,
    automatic: 0,
    scheduled: 0,
    sent: 0,
    failed: 0,
    sentThisWeek: 0,
  });
  // Fails closed BEFORE the database. `.in(col, [])` would match nothing
  // anyway, but seven requests to learn that is seven requests too many.
  assert.equal(
    service.queries.find((q) => q.table === "communication_logs"),
    undefined,
    "an empty scope must not reach communication_logs at all",
  );
});

/* ── SCALE ───────────────────────────────────────────────────── */

const logQueries = (service) => service.queries.filter((q) => q.table === "communication_logs");
const flat = (q) => q.calls.map((c) => c[0]);

test("SCALE: scoping is over job ids, never over an application-id list", async () => {
  const { service } = await aggregatesFor("recruiter", [JOB_A, JOB_B]);
  const qs = logQueries(service);
  assert.equal(qs.length, 7, "all seven counts must still be issued");

  for (const q of qs) {
    const ins = q.calls.filter((c) => c[0] === "in");
    assert.equal(ins.length, 1, `expected exactly one .in(), saw ${JSON.stringify(flat(q))}`);
    assert.equal(ins[0][1], "job_applications.job_id", "the .in() must be over job ids");
    assert.deepEqual(ins[0][2], [JOB_A, JOB_B]);
    assert.ok(
      !q.calls.some((c) => c[0] === "in" && c[1] === "application_id"),
      "an application-id .in() is the unbounded filter this change removed",
    );
  }
});

test("SCALE: scopedApplicationIds is not called from this site at all", async () => {
  // Behavioural, not textual: scopedApplicationIds reads job_applications as a
  // top-level table, so if it ran there would be such a query recorded. This is
  // also what removes this site's exposure to its unordered .range() paging.
  for (const [role, jobs] of [
    ["owner", []],
    ["recruiter", [JOB_A, JOB_B]],
    ["hiring_manager", [JOB_B]],
  ]) {
    const { service } = await aggregatesFor(role, jobs);
    assert.equal(
      service.queries.find((q) => q.table === "job_applications"),
      undefined,
      `${role} built an application allow-list; the allow-list is the 414 this fixed`,
    );
  }
});

test("SCALE: an unscoped role carries no job filter at all, not an empty one", async () => {
  const { service } = await aggregatesFor("owner");
  for (const q of logQueries(service)) {
    assert.ok(
      !q.calls.some((c) => c[0] === "in"),
      "an owner must not be narrowed by an `.in()` of any kind",
    );
  }
});

test("SCALE: the request count is seven, independent of how many jobs are in scope", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `job-${i}`);
  const { service } = await aggregatesFor("recruiter", many);
  assert.equal(
    logQueries(service).length,
    7,
    "seven counts stay seven requests — chunking would have multiplied them",
  );
  assert.equal(
    service.queries.find((q) => q.table === "job_applications"),
    undefined,
  );
});

/* ── STRUCTURE ───────────────────────────────────────────────── */

const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

/** Just fetchMessageAggregates. fetchMessages below it still uses the
 *  allow-list by design, so a whole-file search would prove nothing. */
function aggregatesBody() {
  const start = source.indexOf("export async function fetchMessageAggregates");
  const end = source.indexOf("export async function fetchMessages(");
  assert.ok(start !== -1, "fetchMessageAggregates still exists");
  assert.ok(end > start, "fetchMessages still follows it");
  return source.slice(start, end);
}

test("STRUCTURE: base() is a function, not a shared query builder", () => {
  const body = aggregatesBody();

  // postgrest-js filter methods mutate the builder and `return this`
  // (PostgrestFilterBuilder.ts:171 and friends); only .select() clones. One
  // builder shared across the seven callers would therefore accumulate all of
  // their filters — `written` would carry `sent`'s status filter, and every
  // count after the first would be wrong. `.select()` per call is what keeps
  // them independent.
  assert.ok(
    /const base = \(\) =>/.test(body),
    "base must stay a nullary function so each of the seven counts clones its own builder",
  );
  assert.ok(
    !/const base = service\b/.test(body) && !/const base = \w*\.from\(/.test(body),
    "base must not be a shared builder value — the seven counts would pool their filters",
  );
  // The clone happens in .select(), so it has to be inside base().
  assert.ok(
    /const base = \(\) => \{[\s\S]*?\.select\(/.test(body),
    "the .select() that clones the request must live inside base()",
  );
});

test("STRUCTURE: the embed, the two tenant filters and the head count are all present", () => {
  const body = aggregatesBody();

  assert.ok(
    /job_applications!inner\(/.test(body),
    "without !inner the embedded filters do not restrict the logs",
  );
  assert.ok(
    /\.eq\(\s*"company_id",\s*ctx\.companyId\s*\)/.test(body),
    "the tenant boundary on the logs themselves is unchanged",
  );
  assert.ok(
    /\.eq\(\s*"job_applications\.company_id_snapshot",\s*ctx\.companyId\s*\)/.test(body),
    "and the join is pinned to the same tenant, as the allow-list query was",
  );
  // Unconditional, not inside the scoped branch: tenant-isolation.test.ts reads
  // source text and cannot tell a conditional filter from an applied one.
  assert.ok(
    /\.eq\(\s*"job_applications\.company_id_snapshot",\s*ctx\.companyId\s*\);\s*\n\s*return scope\.scoped/.test(
      body,
    ),
    "the embedded tenant filter must be applied before the scoped branch, not inside it",
  );
  assert.ok(
    /count:\s*"exact"/.test(body) && /head:\s*true/.test(body),
    "still a head count — no rows cross the wire for a badge",
  );
  // A CALL, not a mention — the docblock above base() names the function in
  // prose to explain why it is gone, and that prose is worth keeping.
  assert.ok(
    !/scopedApplicationIds\s*\(/.test(body),
    "this site no longer builds an application allow-list",
  );
});
