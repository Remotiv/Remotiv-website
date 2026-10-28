/**
 * The Messages list — its rows, their order, its pages and its total — is
 * scoped through the join, not through an application-id allow-list.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/list-scope.test.ts"
 *
 * ── The bug this locks down ──────────────────────────────────
 *
 * build() used to narrow with `.in("application_id", allowedApps)`, where
 * allowedApps was every application id the member could see — unbounded.
 * Measured against production: one uuid costs 37 bytes in a PostgREST query
 * string, and the request line stops being answered between 668 and 675 ids
 * (~25 kB), where PostgREST replies 400. supabase-js reports that as an
 * `error` beside a null count rather than throwing, so `count ?? 0` read 0 and
 * `data ?? []` read empty. Both halves of this function carried the same
 * filter, so the page and its total went wrong together and agreed with each
 * other: "No messages", for a company with thousands.
 *
 * ── Why this file carries a row-returning evaluator ──────────
 *
 * fake-postgrest.mjs RECORDS calls and lets the responder decide each answer;
 * its own docblock says "filters are recorded, not applied". The aggregates
 * test next door evaluates counts. This site returns ROWS, so a count is not
 * enough: the same number of rows in a different order, or a page boundary that
 * repeats a row, is still a regression. `queryLogs` below therefore evaluates
 * the query and returns rows — ordered, paged and projected.
 *
 * The PostgREST semantics it implements, each measured read-only against
 * production rather than assumed:
 *
 *   - an unprefixed filter binds to the TOP-LEVEL resource, even when the
 *     embedded table has a column of the same name
 *   - a `job_applications.`-prefixed filter binds to the EMBED, and it
 *     restricts: an impossible needle through the embed counts 0, not the base
 *     population
 *   - `!inner` makes the embed restrict the parent, and drops a parent row
 *     whose FK is null or unmatched — 231 parent rows − 85 orphans = 146,
 *     equal to both query shapes
 *   - a PLAIN embed is a LEFT join: the embedded filters stop restricting the
 *     parent entirely (231 instead of 146)
 *   - an `or()` spanning a parent column and an embedded one is a PARSE ERROR
 *     (PGRST100, http 400) — so the applicant-name search cannot be expressed
 *     through the embed and keeps its own id list. The evaluator throws on that
 *     shape rather than inventing an answer for it.
 *   - a count comes back only if `count: "exact"` was asked for
 *
 * And measured for the ROWS specifically, which is this site's addition: the
 * embed changes neither the returned id sequence nor the page boundaries. Eight
 * comparisons — four scopes, two pages each — were byte-identical before and
 * after, and stitched page 1 + page 2 equalled a single 40-row fetch with no
 * row on both pages.
 *
 * So this file proves the CODE returns the right rows in the right order given
 * those semantics. It does not re-prove the semantics; production did that.
 */
// @ts-nocheck — same reason as aggregates-scope.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
// Nothing ships from this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchMessages } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const JOB_C = "c0000000-0000-0000-0000-00000000000c";
const JOB_F = "f0000000-0000-0000-0000-00000000000f";
const MEMBER = "11111111-1111-1111-1111-111111111111";

const EMBED_PREFIX = "job_applications.";

/**
 * Four applicants in our company across three jobs, plus two that must never
 * appear. `app-drift` is the one that matters most: it sits on one of OUR jobs,
 * so the job-id filter admits it, and only the embedded company_id_snapshot
 * filter excludes it.
 */
const APPLICATIONS = [
  {
    id: "app-a1",
    job_id: JOB_A,
    company_id_snapshot: CO,
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.test",
    job_title_snapshot: null,
    jobs: { title: "Backend Engineer" },
  },
  {
    id: "app-a2",
    job_id: JOB_A,
    company_id_snapshot: CO,
    first_name: "Alan",
    last_name: "Turing",
    email: "alan@example.test",
    job_title_snapshot: null,
    jobs: { title: "Backend Engineer" },
  },
  {
    id: "app-b1",
    job_id: JOB_B,
    company_id_snapshot: CO,
    first_name: "Grace",
    last_name: "Hopper",
    email: "grace@example.test",
    job_title_snapshot: null,
    jobs: { title: "Compiler Lead" },
  },
  {
    id: "app-c1",
    job_id: JOB_C,
    company_id_snapshot: CO,
    first_name: "Linus",
    last_name: "Torvalds",
    email: "linus@example.test",
    job_title_snapshot: null,
    jobs: { title: "Kernel Hacker" },
  },
  {
    id: "app-drift",
    job_id: JOB_A,
    company_id_snapshot: OTHER_CO,
    first_name: "Mallory",
    last_name: "Drift",
    email: "mallory@other.test",
    job_title_snapshot: null,
    jobs: { title: "Backend Engineer" },
  },
  {
    id: "app-foreign",
    job_id: JOB_F,
    company_id_snapshot: OTHER_CO,
    first_name: "Eve",
    last_name: "Foreign",
    email: "eve@other.test",
    job_title_snapshot: null,
    jobs: { title: "Other Role" },
  },
];

/**
 * The subject shared by every "special" log below.
 *
 * It contains a candidate's FIRST NAME on purpose. Searching "grace" therefore
 * matches app-b1 by name AND these rows by subject, which is the only way to
 * exercise both sides of the `.or()` at once — and the only way to prove that
 * the subject side does not escape the job scope or the tenant boundary.
 */
const GRACE = "Grace period for your offer";

/** Which application each of the 24 ordinary logs hangs off. P01 is newest. */
const PLAIN_OWNERS = [
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-b1",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-c1",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
  "app-a1",
  "app-a2",
];

/**
 * 24 ordinary logs, newest first, one per February day from the 24th down.
 *
 * More than one page of them deliberately: MESSAGES_PAGE_SIZE is 20, so a page
 * boundary only exists at all above 20 visible rows. P05 is the single JOB_B
 * log and P10 the single JOB_C one, which is what makes each scope a strict
 * subset with a hand-checkable hole in it.
 */
const PLAIN = PLAIN_OWNERS.map((application_id, i) => {
  const at = `2026-02-${String(24 - i).padStart(2, "0")}T12:00:00.000Z`;
  return {
    id: `P${String(i + 1).padStart(2, "0")}`,
    company_id: CO,
    application_id,
    event: i % 2 === 0 ? "interview_invite" : "manual",
    status: "sent",
    to_address: "stored@example.test",
    subject: i % 3 === 0 ? "Interview invitation" : "Your application",
    body: "<p>hello</p>",
    scheduled_for: null,
    sent_at: at,
    sent_by_name: null,
    created_at: at,
  };
});

const special = (id, over) => ({
  id,
  company_id: CO,
  application_id: "app-a1",
  event: "rejection",
  status: "sent",
  to_address: "stored@example.test",
  subject: GRACE,
  body: "<p>hello</p>",
  scheduled_for: null,
  sent_at: null,
  sent_by_name: null,
  ...over,
});

/**
 * Eight logs chosen so that each filter in build() is the ONLY thing excluding
 * at least one of them, and all eight share the GRACE subject (bar the queued
 * one) so the search path has to exclude them too rather than inheriting the
 * exclusion from a filter the `.or()` happens to sit beside.
 */
const SPECIALS = [
  // Visible. Ours, on JOB_A.
  special("S-GRACE-A", {
    created_at: "2026-01-10T12:00:00.000Z",
    sent_at: "2026-01-10T12:00:00.000Z",
  }),
  // Visible. Ours, on JOB_B — out of a JOB_A recruiter's scope.
  special("S-GRACE-B", {
    application_id: "app-b1",
    created_at: "2026-01-09T12:00:00.000Z",
    sent_at: "2026-01-09T12:00:00.000Z",
  }),
  // Drift: our log, our job, ANOTHER company's application. Excluded only by
  // the embedded company_id_snapshot filter.
  special("S-DRIFT", {
    application_id: "app-drift",
    created_at: "2026-01-08T12:00:00.000Z",
  }),
  // Cross-wired: another company's log pointing at OUR application. The
  // embedded filter admits it, so the PARENT company_id filter is the only
  // thing excluding it.
  special("S-XWIRE", {
    company_id: OTHER_CO,
    created_at: "2026-01-07T12:00:00.000Z",
  }),
  // Orphan: ON DELETE SET NULL left the FK null. `!inner` drops it, as the
  // explicit .not(application_id, "is", null) does.
  special("S-ORPHAN", {
    application_id: null,
    created_at: "2026-01-06T12:00:00.000Z",
  }),
  // Tombstone for a message that never sent. Excluded by status != cancelled.
  special("S-CANCELLED", {
    status: "cancelled",
    created_at: "2026-01-05T12:00:00.000Z",
  }),
  // Visible, and the only row on the Scheduled tab.
  special("S-QUEUED", {
    application_id: "app-b1",
    event: "manual",
    status: "queued",
    subject: "Scheduled rejection",
    scheduled_for: "2026-03-01T09:00:00.000Z",
    created_at: "2026-01-04T12:00:00.000Z",
  }),
  // Another company's log entirely, on their own application.
  special("S-FOREIGN", {
    company_id: OTHER_CO,
    application_id: "app-foreign",
    created_at: "2026-01-03T12:00:00.000Z",
  }),
];

/**
 * SPECIALS first, deliberately.
 *
 * Insertion order is what the evaluator returns when the query carries no
 * `order`, standing in for the unspecified order PostgREST would give. Putting
 * the oldest rows first makes that order differ from created_at DESC, which is
 * what lets negative control (f) — remove the ordering — actually fail a test
 * instead of passing by accident.
 */
const LOGS = [...SPECIALS, ...PLAIN];

/* ── the join evaluator ──────────────────────────────────────── */

function toFilter(method, args) {
  if (method === "eq") return { op: "eq", col: args[0], val: args[1] };
  if (method === "neq") return { op: "neq", col: args[0], val: args[1] };
  if (method === "gte") return { op: "gte", col: args[0], val: args[1] };
  if (method === "in") return { op: "in", col: args[0], val: args[1] };
  if (method === "ilike") return { op: "ilike", col: args[0], val: args[1] };
  if (method === "not" && args[1] === "is" && args[2] === null) {
    return { op: "notnull", col: args[0] };
  }
  throw new Error(`test: evaluator does not model .${method}(${args.join(", ")})`);
}

/** Split on commas that are not inside parentheses — `in.(a,b)` is one term. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** `subject.ilike.%x%,application_id.in.(a,b)` -> two applicable filters. */
function parseOr(expression) {
  return splitTop(expression).map((raw) => {
    const term = raw.trim();
    if (term.startsWith(EMBED_PREFIX)) {
      // Measured: PostgREST answers PGRST100 "failed to parse logic tree" for
      // an or() mixing a parent column with an embedded one. Refusing to
      // evaluate it is the honest model — the request would never run.
      throw new Error(`test: PostgREST cannot parse an embedded column in or(): ${term}`);
    }
    const dot = term.indexOf(".");
    const col = term.slice(0, dot);
    const rest = term.slice(dot + 1);
    const dot2 = rest.indexOf(".");
    const op = rest.slice(0, dot2);
    const val = rest.slice(dot2 + 1);
    if (op === "in") {
      return {
        op: "in",
        col,
        val: val
          .replace(/^\(|\)$/g, "")
          .split(",")
          .filter(Boolean),
      };
    }
    if (op === "ilike") return { op: "ilike", col, val };
    throw new Error(`test: evaluator does not model or() term ${term}`);
  });
}

function parseCalls(calls) {
  const parent = [];
  const embedded = [];
  const ors = [];
  // Every .order() call, in the order given: PostgREST sorts by the first and
  // breaks its ties with the next. #23 added .order("id") after created_at,
  // and an evaluator that kept only the LAST key would sort by id alone.
  const orders = [];
  let range = null;

  for (const [method, ...args] of calls) {
    if (method === "select") continue;
    // A page size, not a filter. The applications read sets limit(1000), and the
    // largest seed in this file is 620 rows, so no page can truncate it and
    // ignoring it is exact. Recorded either way — the SCALE tests read it back
    // to tell the applicant pre-query from hydrate's read of the same table.
    if (method === "limit") continue;
    if (method === "order") {
      orders.push({ col: args[0], ascending: args[1]?.ascending !== false });
      continue;
    }
    if (method === "range") {
      range = { from: args[0], to: args[1] };
      continue;
    }
    if (method === "or") {
      ors.push(parseOr(String(args[0])));
      continue;
    }
    const f = toFilter(method, args);
    const isEmbedded = f.col.startsWith(EMBED_PREFIX);
    (isEmbedded ? embedded : parent).push({
      ...f,
      col: isEmbedded ? f.col.slice(EMBED_PREFIX.length) : f.col,
    });
  }
  return { parent, embedded, ors, order: orders[0] ?? null, orders, range };
}

function matches(row, f) {
  const v = row[f.col];
  if (f.op === "eq") return v === f.val;
  if (f.op === "neq") return v !== f.val;
  if (f.op === "in") return f.val.includes(v);
  if (f.op === "notnull") return v !== null && v !== undefined;
  if (f.op === "ilike") {
    if (v === null || v === undefined) return false;
    const rx = new RegExp(
      `^${String(f.val)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")}$`,
      "i",
    );
    return rx.test(String(v));
  }
  // A null timestamp is not >= anything, as in SQL.
  if (f.op === "gte") return v !== null && v !== undefined && String(v) >= String(f.val);
  throw new Error(`test: unhandled op ${f.op}`);
}

/** The top-level columns the select asks for, the embed excluded. */
function projection(columns) {
  return splitTop(columns)
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith("job_applications"));
}

function project(row, columns, apps) {
  const out = {};
  for (const name of projection(columns)) out[name] = row[name] ?? null;
  if (/job_applications/.test(columns)) {
    // PostgREST returns the embed alongside the row. hydrate ignores it; it is
    // included so the test sees exactly what the code is handed.
    const app = apps.find((a) => a.id === row.application_id);
    out.job_applications = app
      ? { job_id: app.job_id, company_id_snapshot: app.company_id_snapshot }
      : null;
  }
  return out;
}

/**
 * What PostgREST would answer for a query against communication_logs.
 *
 * `logs` and `apps` are parameters rather than closed-over constants so the
 * EXACTNESS tests below can drive the same evaluator with a 620-application
 * seed. Defaulting them keeps every existing caller unchanged.
 */
function queryLogs(calls, logs = LOGS, apps = APPLICATIONS) {
  const select = calls.find((c) => c[0] === "select");
  assert.ok(select, "the list and its count must both go through .select()");
  const columns = String(select[1] ?? "");
  const options = select[2] ?? {};

  const inner = /job_applications!inner\s*\(/.test(columns);
  const plainEmbed = !inner && /job_applications\s*\(/.test(columns);

  const { parent, embedded, ors, order, orders, range } = parseCalls(calls);
  if (embedded.length && !inner && !plainEmbed) {
    throw new Error("test: a job_applications.* filter with no job_applications embed");
  }

  let rows = logs.filter((l) => parent.every((f) => matches(l, f)));

  if (inner) {
    rows = rows.filter((l) => {
      const app = apps.find((a) => a.id === l.application_id);
      // An inner join drops a parent row with a null or unmatched FK.
      if (!app) return false;
      return embedded.every((f) => matches(app, f));
    });
  }
  // A plain embed is a LEFT join: the embedded filters null out the embed and
  // leave every parent row standing. Deliberately NOT applied here — that is
  // the cv-purge.ts:309 leak, and negative control (c) depends on it.

  for (const group of ors) rows = rows.filter((l) => group.some((f) => matches(l, f)));

  if (order) {
    rows = [...rows].sort((x, y) => {
      for (const key of orders) {
        const dir = key.ascending ? 1 : -1;
        const a = String(x[key.col] ?? "");
        const b = String(y[key.col] ?? "");
        if (a !== b) return (a < b ? -1 : 1) * dir;
      }
      return 0;
    });
  }

  // The count is the total BEFORE paging, which is what `matching` means.
  if (options.count === "exact") {
    assert.equal(options.head, true, "a count on this surface must stay head-only");
    return { data: null, count: rows.length, error: null };
  }
  const page = range ? rows.slice(range.from, range.to + 1) : rows;
  return { data: page.map((l) => project(l, columns, apps)), count: null, error: null };
}

const ctxFor = (role, companyId = CO) => ({
  companyId,
  role,
  memberId: MEMBER,
  memberName: "Test Member",
  user: { id: "u-1", email: "member@example.test" },
  company: { name: "Acme" },
});

/** Run the real action as `role`, with `assignments` as the hiring-team rows. */
async function listFor(role, assignments = [], input = {}, companyId = CO) {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") {
      return { data: assignments.map((job_id) => ({ job_id })), error: null };
    }
    if (table === "communication_logs") return queryLogs(calls);
    if (table === "job_applications") {
      // Two readers land here: the search/job-filter pre-query, and hydrate.
      // Both have their filters HONOURED, which matters — a responder handing
      // back every row would make the search look like it leaked when the
      // leak was the harness.
      const { parent } = parseCalls(calls);
      return {
        data: APPLICATIONS.filter((a) => parent.every((f) => matches(a, f))),
        error: null,
      };
    }
    throw new Error(`test: unexpected table ${table}`);
  });

  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor(role, companyId);
  try {
    const read = await fetchMessages({
      tab: "all",
      jobId: "",
      search: "",
      page: 0,
      ...input,
    });
    return { read, service };
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

const pageOf = (read) => {
  assert.ok(read.ok, "fetchMessages returned unavailable");
  return { ids: read.value.rows.map((r) => r.id), matching: read.value.matching };
};

/* ── the expected sequences, hand-written ────────────────────── */

const P = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `P${String(from + i).padStart(2, "0")}`);
const without = (ids, drop) => ids.filter((id) => !drop.includes(id));

/**
 * Every visible row for an unscoped viewer, newest first.
 *
 * The 24 February logs in order, then the three visible January specials. The
 * other five specials are each excluded by exactly one filter: S-DRIFT by the
 * embedded snapshot, S-XWIRE and S-FOREIGN by the parent company, S-ORPHAN by
 * the null FK, S-CANCELLED by the status.
 */
const VISIBLE_UNSCOPED = [...P(1, 24), "S-GRACE-A", "S-GRACE-B", "S-QUEUED"];

/** JOB_A only: P05 is JOB_B's and P10 is JOB_C's, so both drop out. */
const VISIBLE_JOB_A = [...without(P(1, 24), ["P05", "P10"]), "S-GRACE-A"];

/** JOB_A + JOB_B — a strict subset of the three jobs. Only P10 drops out. */
const VISIBLE_JOB_AB = [...without(P(1, 24), ["P10"]), "S-GRACE-A", "S-GRACE-B", "S-QUEUED"];

/** JOB_C, the quietest: one log. */
const VISIBLE_JOB_C = ["P10"];

const PAGE = 20;

/* ── CORRECTNESS ─────────────────────────────────────────────── */

test("CORRECTNESS: an owner's first page is the newest twenty of the whole company", async () => {
  const { read } = await listFor("owner");
  assert.deepEqual(pageOf(read), {
    ids: VISIBLE_UNSCOPED.slice(0, PAGE),
    matching: 27,
  });
});

test("CORRECTNESS: admin reads identically to owner", async () => {
  const owner = pageOf((await listFor("owner")).read);
  const admin = pageOf((await listFor("admin")).read);
  assert.deepEqual(admin, owner);
});

test("CORRECTNESS: a recruiter on the busiest single job sees only its logs", async () => {
  const { read } = await listFor("recruiter", [JOB_A]);
  assert.deepEqual(pageOf(read), {
    ids: VISIBLE_JOB_A.slice(0, PAGE),
    matching: 23,
  });
});

test("CORRECTNESS: a recruiter on a strict subset of jobs sees the union, not a chunk", async () => {
  const { read } = await listFor("recruiter", [JOB_A, JOB_B]);
  assert.deepEqual(pageOf(read), {
    ids: VISIBLE_JOB_AB.slice(0, PAGE),
    matching: 26,
  });
});

test("CORRECTNESS: a hiring manager on the quietest job sees its one log", async () => {
  const { read } = await listFor("hiring_manager", [JOB_C]);
  assert.deepEqual(pageOf(read), { ids: VISIBLE_JOB_C, matching: 1 });
});

test("CORRECTNESS: the drift, orphan, cancelled and cross-company rows never appear", async () => {
  // Each of these is excluded by exactly one filter, so any one of them
  // surfacing names which filter was lost.
  const forbidden = ["S-DRIFT", "S-XWIRE", "S-ORPHAN", "S-CANCELLED", "S-FOREIGN"];
  const scopes = [
    ["owner", []],
    ["admin", []],
    ["recruiter", [JOB_A]],
    ["recruiter", [JOB_A, JOB_B]],
    ["hiring_manager", [JOB_C]],
  ];
  for (const [role, jobs] of scopes) {
    for (const page of [0, 1]) {
      const { ids } = pageOf((await listFor(role, jobs, { page })).read);
      for (const bad of forbidden) {
        assert.ok(
          !ids.includes(bad),
          `${role} ${JSON.stringify(jobs)} page ${page} returned ${bad}`,
        );
      }
    }
  }
});

test("CORRECTNESS: every field of a row survives the embed", async () => {
  // The embed adds a nested job_applications object to each row PostgREST
  // returns. hydrate builds MessageRow field by field, so the shape the UI
  // gets must be unchanged — asserted in full, not by id.
  const { read } = await listFor("owner");
  assert.ok(read.ok);
  assert.deepEqual(read.value.rows[0], {
    id: "P01",
    applicationId: "app-a1",
    candidateName: "Ada Lovelace",
    candidateEmail: "ada@example.test",
    jobId: JOB_A,
    jobTitle: "Backend Engineer",
    subject: "Interview invitation",
    body: "hello",
    event: "interview_invite",
    status: "sent",
    kind: "automatic",
    sentByName: null,
    sentAt: "2026-02-24T12:00:00.000Z",
    scheduledFor: null,
    createdAt: "2026-02-24T12:00:00.000Z",
  });
});

test("CORRECTNESS: a scoped role with no assignments reads empty without querying", async () => {
  const { read, service } = await listFor("recruiter", []);
  assert.deepEqual(pageOf(read), { ids: [], matching: 0 });
  // Fails closed BEFORE the database. `.in(col, [])` would match nothing
  // anyway, but two requests to learn that is two too many.
  assert.equal(
    service.queries.find((q) => q.table === "communication_logs"),
    undefined,
    "an empty scope must not reach communication_logs at all",
  );
});

test("CORRECTNESS: the tab filter still narrows under the join", async () => {
  const { read } = await listFor("owner", [], { tab: "scheduled" });
  assert.deepEqual(pageOf(read), { ids: ["S-QUEUED"], matching: 1 });
});

/* ── TENANT ISOLATION ────────────────────────────────────────── */

test("ISOLATION: the other company sees only its own log, and ours sees none of theirs", async () => {
  // S-XWIRE is OTHER_CO's log pointing at OUR application: the embedded
  // snapshot filter excludes it even for them. S-FOREIGN is genuinely theirs.
  const theirs = pageOf((await listFor("owner", [], {}, OTHER_CO)).read);
  assert.deepEqual(theirs, { ids: ["S-FOREIGN"], matching: 1 });

  const ours = pageOf((await listFor("owner")).read);
  assert.ok(!ours.ids.includes("S-FOREIGN"));
  assert.ok(!ours.ids.includes("S-XWIRE"));
});

test("ISOLATION: both tenant filters are on every log query, for every role", async () => {
  for (const [role, jobs] of [
    ["owner", []],
    ["recruiter", [JOB_A]],
    ["hiring_manager", [JOB_C]],
  ]) {
    const { service } = await listFor(role, jobs, { search: "grace", page: 0 });
    const qs = service.queries.filter((q) => q.table === "communication_logs");
    assert.equal(qs.length, 2, "the count and the page");
    for (const q of qs) {
      assert.ok(
        q.calls.some((c) => c[0] === "eq" && c[1] === "company_id"),
        `${role}: the parent tenant filter is missing`,
      );
      assert.ok(
        q.calls.some((c) => c[0] === "eq" && c[1] === "job_applications.company_id_snapshot"),
        `${role}: the embedded tenant filter is missing`,
      );
    }
  }
});

/* ── ORDERING ────────────────────────────────────────────────── */

test("ORDERING: the two pages, concatenated, are the whole list newest first", async () => {
  const first = pageOf((await listFor("owner", [], { page: 0 })).read);
  const second = pageOf((await listFor("owner", [], { page: 1 })).read);
  // The SEQUENCE, not the set: the same 27 ids in a different order would
  // satisfy a set comparison and still be a regression.
  assert.deepEqual([...first.ids, ...second.ids], VISIBLE_UNSCOPED);
});

test("ORDERING: a scoped recruiter's sequence is the same list with the holes taken out", async () => {
  const first = pageOf((await listFor("recruiter", [JOB_A], { page: 0 })).read);
  const second = pageOf((await listFor("recruiter", [JOB_A], { page: 1 })).read);
  assert.deepEqual([...first.ids, ...second.ids], VISIBLE_JOB_A);
});

test("ORDERING: the list is ordered by created_at descending, explicitly", async () => {
  const { service } = await listFor("owner");
  const listed = service.queries
    .filter((q) => q.table === "communication_logs")
    .find((q) => q.calls.some((c) => c[0] === "order"));
  assert.ok(listed, "the page query must carry an order");
  const order = listed.calls.find((c) => c[0] === "order");
  assert.equal(order[1], "created_at");
  assert.equal(order[2]?.ascending, false);
});

/* ── PAGINATION ──────────────────────────────────────────────── */

test("PAGINATION: no row appears on both pages and none is skipped between them", async () => {
  for (const [role, jobs, expected] of [
    ["owner", [], VISIBLE_UNSCOPED],
    ["recruiter", [JOB_A], VISIBLE_JOB_A],
    ["recruiter", [JOB_A, JOB_B], VISIBLE_JOB_AB],
  ]) {
    const first = pageOf((await listFor(role, jobs, { page: 0 })).read);
    const second = pageOf((await listFor(role, jobs, { page: 1 })).read);

    const overlap = first.ids.filter((id) => second.ids.includes(id));
    assert.deepEqual(overlap, [], `${role}: rows on both pages`);
    assert.equal(first.ids.length, PAGE, `${role}: a full first page`);
    assert.deepEqual(
      [...first.ids, ...second.ids],
      expected,
      `${role}: the stitched pages must equal the whole list`,
    );
    assert.equal(first.matching, expected.length);
    assert.equal(second.matching, expected.length, `${role}: the total must not move by page`);
  }
});

test("PAGINATION: matching is the total, not the page size", async () => {
  const { read } = await listFor("owner");
  assert.ok(read.ok);
  assert.equal(read.value.rows.length, PAGE);
  assert.equal(read.value.matching, 27);
});

test("PAGINATION: a page past the end is empty and still reports the total", async () => {
  const { read } = await listFor("owner", [], { page: 9 });
  assert.deepEqual(pageOf(read), { ids: [], matching: 27 });
});

test("PAGINATION: the requested window reaches the query as offset and limit", async () => {
  const { service } = await listFor("owner", [], { page: 2 });
  const listed = service.queries
    .filter((q) => q.table === "communication_logs")
    .find((q) => q.calls.some((c) => c[0] === "range"));
  const range = listed.calls.find((c) => c[0] === "range");
  assert.deepEqual([range[1], range[2]], [40, 59]);
});

/* ── SEARCH ──────────────────────────────────────────────────── */

test("SEARCH: an unscoped search unions the subject match with the name match", async () => {
  // "grace" matches app-b1 by first name, and the GRACE subject by text. The
  // union is app-b1's three logs plus S-GRACE-A — and NOT S-DRIFT, S-XWIRE,
  // S-ORPHAN or S-CANCELLED, which all carry the same subject.
  const { read } = await listFor("owner", [], { search: "grace" });
  assert.deepEqual(pageOf(read), {
    ids: ["P05", "S-GRACE-A", "S-GRACE-B", "S-QUEUED"],
    matching: 4,
  });
});

test("SEARCH: the subject side of the or() does not escape the job scope", async () => {
  /*
   * The discriminating case for this whole change.
   *
   * A recruiter on JOB_A searching "grace" resolves NO applicant — app-b1 is
   * out of scope, so the pre-query returns nothing and the code falls to a
   * subject-only ilike. Four rows carry that subject and only one is theirs:
   *
   *   S-GRACE-A  JOB_A, ours        -> the answer
   *   S-GRACE-B  JOB_B, ours        -> excluded by the embedded job filter
   *   S-DRIFT    JOB_A, NOT ours    -> excluded ONLY by the embedded snapshot
   *   S-XWIRE    their log, our app -> excluded only by the parent company
   *
   * S-DRIFT is the one that matters: it is on the recruiter's own job, so the
   * job filter admits it. Nothing but the embedded tenant filter keeps it out.
   */
  const { read } = await listFor("recruiter", [JOB_A], { search: "grace" });
  assert.deepEqual(pageOf(read), { ids: ["S-GRACE-A"], matching: 1 });
});

test("SEARCH: a needle matching no applicant still matches subjects", async () => {
  // No name, email or role contains "invitation", so appIds is empty and the
  // code takes the subject-only branch rather than an `.in(col, [])`.
  const { read } = await listFor("owner", [], { search: "invitation" });
  assert.deepEqual(pageOf(read), {
    ids: ["P01", "P04", "P07", "P10", "P13", "P16", "P19", "P22"],
    matching: 8,
  });
});

test("SEARCH: the same needle under scope drops the out-of-scope subject matches", async () => {
  // P10 is JOB_C's. Everything else with that subject is on JOB_A.
  const { read } = await listFor("recruiter", [JOB_A], { search: "invitation" });
  assert.deepEqual(pageOf(read), {
    ids: ["P01", "P04", "P07", "P13", "P16", "P19", "P22"],
    matching: 7,
  });
});

test("SEARCH: a needle matching nothing at all returns nothing", async () => {
  const { read } = await listFor("owner", [], { search: "zzzqqq" });
  assert.deepEqual(pageOf(read), { ids: [], matching: 0 });
});

test("SEARCH: the name search keeps its own application-id list, beside the join", async () => {
  // Part 1 measured that PostgREST cannot parse an or() spanning a parent
  // column and an embedded one (PGRST100, http 400), so this list is not
  // replaceable by the embed. What must be true is that it is the SEARCH's
  // list and not the scope's: scope travels on job ids.
  const { service } = await listFor("recruiter", [JOB_A, JOB_B], { search: "grace" });
  for (const q of service.queries.filter((x) => x.table === "communication_logs")) {
    const or = q.calls.find((c) => c[0] === "or");
    assert.ok(or, "the search must still be an or()");
    assert.match(or[1], /^subject\.ilike\.%grace%,application_id\.in\.\(app-b1\)$/);

    const scopeIn = q.calls.filter((c) => c[0] === "in");
    assert.deepEqual(
      scopeIn.map((c) => c[1]),
      ["job_applications.job_id"],
      "scope must travel on job ids, never on an application-id list",
    );
  }
});

/* ── JOB FILTER ──────────────────────────────────────────────── */

test("JOB FILTER: an owner filtering to one job sees that job's logs", async () => {
  const { read } = await listFor("owner", [], { jobId: JOB_B });
  assert.deepEqual(pageOf(read), {
    ids: ["P05", "S-GRACE-B", "S-QUEUED"],
    matching: 3,
  });
});

test("JOB FILTER: filtering to a job equals being scoped to it", async () => {
  const filtered = pageOf((await listFor("owner", [], { jobId: JOB_A })).read);
  const scoped = pageOf((await listFor("recruiter", [JOB_A])).read);
  assert.deepEqual(filtered.ids, VISIBLE_JOB_A.slice(0, PAGE));
  assert.deepEqual(filtered, scoped);
});

test("JOB FILTER: a job outside the viewer's scope returns nothing, not everything", async () => {
  const { read } = await listFor("recruiter", [JOB_A], { jobId: JOB_B });
  assert.deepEqual(pageOf(read), { ids: [], matching: 0 });
});

test("JOB FILTER: it travels as an embedded predicate, not an application-id list", async () => {
  // It used to be resolved to application ids and passed to
  // .in("application_id", …) under a .slice(0, 500). Both are gone: the
  // predicate is one more filter on the embed that is already there, which is
  // exact at any applicant count and costs no extra round trip.
  const { service } = await listFor("owner", [], { jobId: JOB_B });
  for (const q of service.queries.filter((x) => x.table === "communication_logs")) {
    assert.ok(
      q.calls.some((c) => c[0] === "eq" && c[1] === "job_applications.job_id" && c[2] === JOB_B),
      "the chosen job must be an embedded eq on the builder",
    );
    assert.deepEqual(
      q.calls.filter((c) => c[0] === "in").map((c) => c[1]),
      [],
      "no application-id list may survive on the job-only path",
    );
  }
});

test("JOB FILTER: the job-only path makes no applicant pre-query at all", async () => {
  // Two readers hit job_applications. The pre-query carries .limit(1000);
  // hydrate's read carries .in("id", …) and no limit, so they are told apart
  // behaviourally rather than by matching on source text.
  const { service } = await listFor("owner", [], { jobId: JOB_B });
  const apps = service.queries.filter((q) => q.table === "job_applications");
  assert.deepEqual(
    apps.filter((q) => q.calls.some((c) => c[0] === "limit")),
    [],
    "a job filter with no search must not resolve application ids first",
  );
  // Without this the assertion above would also pass on a page that returned
  // nothing and never reached job_applications for any reason.
  assert.ok(
    apps.some((q) => q.calls.some((c) => c[0] === "in" && c[1] === "id")),
    "hydrate must still read the applicants, so the absence above is the pre-query's",
  );
});

test("JOB FILTER: the pre-query still narrows by job when a search is present", async () => {
  /*
   * The pre-query survives to resolve applicant NAMES, and it keeps its job
   * filter even though the builder's eq is what enforces correctness now.
   *
   * The reason is the two bounds it still carries: .limit(1000) here and
   * .slice(0, 300) on the id list it feeds. Spending those across every
   * application in scope instead of the chosen job's would make the name search
   * begin truncating at a LOWER applicant count than it does today. This test
   * fails if someone later drops that filter as redundant — it is redundant for
   * correctness and load-bearing for the budget.
   */
  const { service } = await listFor("recruiter", [JOB_A, JOB_B], {
    jobId: JOB_B,
    search: "grace",
  });
  const pre = service.queries.filter(
    (q) => q.table === "job_applications" && q.calls.some((c) => c[0] === "limit"),
  );
  assert.equal(pre.length, 1, "exactly one applicant pre-query, for the name search");
  assert.ok(
    pre[0].calls.some((c) => c[0] === "eq" && c[1] === "job_id" && c[2] === JOB_B),
    "the pre-query must stay narrowed to the chosen job",
  );
  assert.ok(
    pre[0].calls.some((c) => c[0] === "in" && c[1] === "job_id"),
    "and still carry the scope, which is what bounds a member",
  );
});

/* ── THE LEAK ────────────────────────────────────────────────── */

test("LEAK: a job filter plus a search returns only the chosen job's messages", async () => {
  /*
   * The named regression for finding 1, and the one case Part 2 deliberately
   * answers differently from the code before it.
   *
   * "grace" matches app-b1 BY NAME, so the pre-query resolves a non-empty list
   * and the code takes the real or() branch:
   *
   *     or(subject.ilike.%grace%, application_id.in.(app-b1))
   *
   * An or() is a disjunction. The id side is JOB_B's; the subject side was
   * bound by nothing, so S-GRACE-A — JOB_A's — came back for a viewer who had
   * asked for JOB_B. Measured on production at 144 rows where 47 were the
   * chosen job's.
   */
  const { read } = await listFor("owner", [], { jobId: JOB_B, search: "grace" });
  const got = pageOf(read);
  assert.deepEqual(got, { ids: ["P05", "S-GRACE-B", "S-QUEUED"], matching: 3 });

  // Stated separately so a failure names the leak rather than a sequence
  // mismatch. S-GRACE-A is JOB_A's and matches the subject: it is precisely
  // what used to escape.
  assert.ok(!got.ids.includes("S-GRACE-A"), "a JOB_A row escaped a JOB_B filter");

  // And the narrowing is real. Before this pass the two calls below returned
  // the SAME four rows — the job filter did nothing whatever once a search was
  // present, which is what makes this cell discriminating rather than
  // confirmatory.
  const unfiltered = pageOf((await listFor("owner", [], { search: "grace" })).read);
  assert.deepEqual(unfiltered.ids, ["P05", "S-GRACE-A", "S-GRACE-B", "S-QUEUED"]);
  assert.notDeepEqual(got.ids, unfiltered.ids);
});

test("LEAK: the subject-only branch is bound by the job filter too", async () => {
  // The other half of the or(). jobId=JOB_A with "grace" resolves NO applicant
  // — neither Ada nor Alan matches — so idList is empty and the code falls to a
  // bare .ilike("subject", …). That branch carried no job predicate at all, so
  // S-GRACE-B, which is JOB_B's, came back for a JOB_A filter.
  const { read } = await listFor("owner", [], { jobId: JOB_A, search: "grace" });
  assert.deepEqual(pageOf(read), { ids: ["S-GRACE-A"], matching: 1 });
});

/* ── SCOPE AND THE FILTER TOGETHER ───────────────────────────── */

test("SCOPE AND FILTER: a job outside the scope is zero rows even with a search", async () => {
  /*
   * The dangerous case. A recruiter on JOB_A asks for JOB_B and searches.
   *
   * Before this pass the pre-query ANDed scope with the chosen job, got an
   * empty set, and so drove the code to the subject-only ilike — a branch that
   * kept the SCOPE filter but had no job filter. The recruiter was served
   * S-GRACE-A: a row from JOB_A, which is not the job they asked for. Wrong in
   * both directions at once.
   */
  const { read } = await listFor("recruiter", [JOB_A], { jobId: JOB_B, search: "grace" });
  assert.deepEqual(pageOf(read), { ids: [], matching: 0 });
});

test("SCOPE AND FILTER: a scope that includes the job yields exactly that job", async () => {
  // Proven against production in Part 1: two filters on one embedded column
  // AND, in either order, so the intersection is what runs and no workaround in
  // JS is needed. Asserted behaviourally AND on the recorded calls, because the
  // rows alone cannot tell an intersection from one filter having won.
  const { read, service } = await listFor("recruiter", [JOB_A, JOB_B], { jobId: JOB_B });
  assert.deepEqual(pageOf(read), { ids: ["P05", "S-GRACE-B", "S-QUEUED"], matching: 3 });
  for (const q of service.queries.filter((x) => x.table === "communication_logs")) {
    const onJob = q.calls.filter((c) => c[1] === "job_applications.job_id");
    assert.deepEqual(
      onJob.map((c) => c[0]),
      ["in", "eq"],
      "the scope list and the chosen job must both be present, neither replacing the other",
    );
  }
});

/* ── FAILURE IS NOT EMPTINESS ────────────────────────────────── */

test("FAILURE: a failed count is unavailable, not a page of zero", async () => {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") return { data: [], error: null };
    if (table === "communication_logs") {
      const select = calls.find((c) => c[0] === "select");
      const head = select[2]?.head === true;
      // Exactly what supabase-js hands back on a 4xx: an error beside a null
      // count, no throw. The old `count ?? 0` turned this into "No messages".
      // 400 and not 414: measured against production, an over-long in.(…) list
      // comes back as a PostgREST 400, not a gateway 414.
      if (head) return { data: null, count: null, error: { message: "400 Bad Request" } };
      return queryLogs(calls);
    }
    if (table === "job_applications") return { data: APPLICATIONS, error: null };
    throw new Error(`test: unexpected table ${table}`);
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor("owner");
  try {
    const read = await fetchMessages({ tab: "all", jobId: "", search: "", page: 0 });
    assert.equal(read.ok, false, "a failed count must not render as an empty list");
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
});

test("FAILURE: a failed page read is unavailable, not an empty page with a total", async () => {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") return { data: [], error: null };
    if (table === "communication_logs") {
      const select = calls.find((c) => c[0] === "select");
      const head = select[2]?.head === true;
      if (!head) return { data: null, count: null, error: { message: "statement timeout" } };
      return queryLogs(calls);
    }
    if (table === "job_applications") return { data: APPLICATIONS, error: null };
    throw new Error(`test: unexpected table ${table}`);
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor("owner");
  try {
    const read = await fetchMessages({ tab: "all", jobId: "", search: "", page: 0 });
    assert.equal(read.ok, false, "27 matching rows and none shown is not an answer");
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
});

test("FAILURE: a failed applicant pre-query is unavailable, not 'no applicant matched'", async () => {
  const service = fakeService((table) => {
    if (table === "job_hiring_team") return { data: [], error: null };
    if (table === "job_applications") {
      return { data: null, error: { message: "statement timeout" } };
    }
    if (table === "communication_logs") throw new Error("test: must not be reached");
    throw new Error(`test: unexpected table ${table}`);
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor("owner");
  try {
    const read = await fetchMessages({ tab: "all", jobId: "", search: "ada", page: 0 });
    assert.equal(read.ok, false, "an unread filter must not read as an empty filter");
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
});

/* ── SCALE ───────────────────────────────────────────────────── */

const logQueries = (service) => service.queries.filter((q) => q.table === "communication_logs");

test("SCALE: scoping is over job ids, never over an application-id list", async () => {
  const { service } = await listFor("recruiter", [JOB_A, JOB_B]);
  const qs = logQueries(service);
  assert.equal(qs.length, 2, "one count and one page");
  for (const q of qs) {
    const ins = q.calls.filter((c) => c[0] === "in");
    assert.equal(
      ins.length,
      1,
      `expected one .in(), saw ${JSON.stringify(q.calls.map((c) => c[0]))}`,
    );
    assert.equal(ins[0][1], "job_applications.job_id");
    assert.deepEqual(ins[0][2], [JOB_A, JOB_B]);
  }
});

test("SCALE: scopedApplicationIds is not called from this site at all", async () => {
  // Behavioural, not textual: scopedApplicationIds is the only reader here that
  // pages job_applications with .range(), so its absence is observable. This is
  // what removes this site's exposure to its unordered .range() paging.
  for (const [role, jobs] of [
    ["owner", []],
    ["recruiter", [JOB_A, JOB_B]],
    ["hiring_manager", [JOB_C]],
  ]) {
    const { service } = await listFor(role, jobs);
    const paged = service.queries.filter(
      (q) => q.table === "job_applications" && q.calls.some((c) => c[0] === "range"),
    );
    assert.deepEqual(
      paged,
      [],
      `${role} paged an application allow-list; the allow-list is the 400 this fixed`,
    );
  }
});

test("SCALE: an unscoped role carries no job filter at all, not an empty one", async () => {
  const { service } = await listFor("owner");
  for (const q of logQueries(service)) {
    assert.ok(
      !q.calls.some((c) => c[0] === "in"),
      "an owner must not be narrowed by an `.in()` of any kind",
    );
  }
});

test("SCALE: the request count is two, independent of how many jobs are in scope", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `job-${i}`);
  const { service } = await listFor("recruiter", many);
  assert.equal(
    logQueries(service).length,
    2,
    "one count and one page — chunking an id list would have multiplied them",
  );
  for (const q of logQueries(service)) {
    const ins = q.calls.filter((c) => c[0] === "in");
    assert.equal(ins[0][1], "job_applications.job_id");
    assert.equal(ins[0][2].length, 40, "the job ids go in one bounded list");
  }
});

/* ── EXACTNESS PAST THE OLD 500-ID SLICE ─────────────────────── */

/**
 * 620 applications on one job, one log each.
 *
 * Above 500 deliberately: the job filter used to slice its id list at 500, and
 * 500 ids is 18.5 kB, which answers fine — so nothing errored. The 501st
 * application's messages were dropped and the count was reported to match.
 *
 * Production cannot demonstrate this. Measured in Part 1: 37 jobs, 142
 * applications in total, the largest single job 44, none above 300. The bug is
 * latent on live data, so a before/after comparison there is FORCED to agree
 * and proves only behaviour-neutrality. This seed is the only evidence the
 * truncation existed, which is why it is hand-built rather than probed.
 */
const BIG_JOB = "d0000000-0000-0000-0000-00000000000d";
const BIG_N = 620;

const BIG_APPS = Array.from({ length: BIG_N }, (_, i) => ({
  id: `big-app-${String(i).padStart(4, "0")}`,
  job_id: BIG_JOB,
  company_id_snapshot: CO,
  first_name: "Cand",
  last_name: String(i),
  email: `cand${i}@example.test`,
  job_title_snapshot: null,
  jobs: { title: "Scale Role" },
}));

const BIG_LOGS = BIG_APPS.map((app, i) => {
  // Descending, so index 0 is the newest row and the expected page is a slice.
  const at = new Date(Date.UTC(2026, 5, 1, 12, 0) - i * 60_000).toISOString();
  return {
    id: `BIG-${String(i).padStart(4, "0")}`,
    company_id: CO,
    application_id: app.id,
    event: "manual",
    status: "sent",
    to_address: "stored@example.test",
    subject: "Your application",
    body: "<p>hello</p>",
    scheduled_for: null,
    sent_at: at,
    sent_by_name: null,
    created_at: at,
  };
});

/** listFor against the 620-application seed, as an owner. */
async function listBig(input = {}) {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") return { data: [], error: null };
    if (table === "communication_logs") return queryLogs(calls, BIG_LOGS, BIG_APPS);
    if (table === "job_applications") {
      const { parent } = parseCalls(calls);
      return { data: BIG_APPS.filter((a) => parent.every((f) => matches(a, f))), error: null };
    }
    throw new Error(`test: unexpected table ${table}`);
  });

  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor("owner");
  try {
    const read = await fetchMessages({ tab: "all", jobId: "", search: "", page: 0, ...input });
    return { read, service };
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

test("EXACTNESS: a job with more than 500 applications reports its true count", async () => {
  const { read } = await listBig({ jobId: BIG_JOB });
  assert.ok(read.ok, "fetchMessages returned unavailable");
  assert.equal(
    read.value.matching,
    BIG_N,
    "the old .slice(0, 500) reported 500 here and dropped the rest in silence",
  );
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    BIG_LOGS.slice(0, PAGE).map((l) => l.id),
    "and the first page is still the newest twenty",
  );
});

test("EXACTNESS: the rows past the old 500 cut are reachable, not just counted", async () => {
  // A correct count over truncated rows would satisfy the test above. Page 30
  // is rows 600-619, every one of them beyond the old slice, so this is the
  // assertion that the data is really there.
  const { read } = await listBig({ jobId: BIG_JOB, page: 30 });
  assert.ok(read.ok, "fetchMessages returned unavailable");
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    BIG_LOGS.slice(600, 620).map((l) => l.id),
  );
  assert.equal(read.value.matching, BIG_N, "the total must not move by page");
});

test("EXACTNESS: at this size the filter is still one request pair and no pre-query", async () => {
  // The id list was also a round trip and a 24 kB query string. Neither is
  // paid now, and at 620 applications the old shape was closest to its
  // measured 668-675 id ceiling.
  const { service } = await listBig({ jobId: BIG_JOB });
  assert.equal(
    service.queries.filter((q) => q.table === "communication_logs").length,
    2,
    "one count and one page",
  );
  assert.deepEqual(
    service.queries.filter(
      (q) => q.table === "job_applications" && q.calls.some((c) => c[0] === "limit"),
    ),
    [],
    "620 application ids must never be resolved to filter by one job",
  );
});

/* ── STRUCTURE ───────────────────────────────────────────────── */

const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

/** Just fetchMessages. The aggregates above it have the same shape, so a
 *  whole-file search would pass on their text alone. */
function messagesBody() {
  const start = source.indexOf("export async function fetchMessages(input:");
  const end = source.indexOf("export async function fetchApplicationMessages");
  assert.ok(start !== -1, "fetchMessages still exists");
  assert.ok(end > start, "fetchApplicationMessages still follows it");
  return source.slice(start, end);
}

/**
 * The same body with its comments removed.
 *
 * Needed for assertions that something is ABSENT. The docblocks here quote the
 * old filters verbatim — `.in("application_id", allowedApps)` appears in prose
 * twice — and that prose is the record of why they are gone, so it is worth
 * keeping. No regex can tell a quoted call from a real one, so the text is cut
 * instead. Block comments first, then whole-line `//` comments only: a trailing
 * `//` could fall inside a string literal, and nothing here needs that case.
 */
function messagesCode() {
  const stripped = messagesBody()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // Guard against the stripping having eaten the code itself.
  assert.ok(/\.from\("communication_logs"\)/.test(stripped), "comment stripping removed too much");
  return stripped;
}

test("STRUCTURE: the embed, the two tenant filters and the head count are all present", () => {
  const body = messagesBody();

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
  // this as source text and cannot tell a conditional filter from an applied
  // one, so a version that only filtered when scoped would show green while
  // owners read the join unguarded.
  assert.ok(
    /\.eq\(\s*"job_applications\.company_id_snapshot",\s*ctx\.companyId\s*\);\s*\n\s*\n?\s*if \(scope\.scoped\)/.test(
      body,
    ),
    "the embedded tenant filter must be applied before the scoped branch, not inside it",
  );
  assert.ok(
    /count:\s*"exact"/.test(body) && /head:\s*true/.test(body),
    "the total must stay a head count — no rows cross the wire to produce a number",
  );
  // A CALL, not a mention — the docblock names the function in prose to explain
  // why it is gone, and that prose is worth keeping.
  assert.ok(
    !/scopedApplicationIds\s*\(/.test(body),
    "this site no longer builds an application allow-list",
  );
});

test("STRUCTURE: the job filter is on the builder and the id-list filter is gone", () => {
  const body = messagesBody();

  assert.ok(
    /\.eq\(\s*"job_applications\.job_id",\s*input\.jobId\s*\)/.test(body),
    "the chosen job must be an embedded predicate on the builder",
  );
  // Unconditional with respect to search. A version that only applied the
  // predicate when no search was present would pass every count test above and
  // leak exactly as before, because the leak only exists when both are set.
  assert.ok(
    !/if \(!search\)[^\n]*job_applications\.job_id/.test(body),
    "the job predicate must not be conditional on the search being absent",
  );
  // Against the comment-stripped body: the docblocks quote both of these in
  // prose on purpose, and that prose is the record of why they went.
  const code = messagesCode();
  assert.ok(
    !/\.in\(\s*"application_id"/.test(code),
    "the job filter no longer resolves to an application-id list",
  );
  assert.ok(!/slice\(0,\s*500\)/.test(code), "and the 500-id truncation it fed is gone with it");
  // Still present, and deliberately: these two bound the NAME search, which is
  // the next pass. Asserted so their removal is a decision, not a drift.
  assert.ok(/\.limit\(1000\)/.test(body) && /slice\(0,\s*300\)/.test(body));
});

test("STRUCTURE: both halves of the page come from one builder function", () => {
  const body = messagesBody();
  // postgrest-js filter methods mutate the builder and return `this`
  // (PostgrestFilterBuilder.ts:171 and friends); only .select() clones. A
  // shared builder would let the count's filters leak into the page query.
  assert.ok(
    /const build = \(head: boolean\) => \{/.test(body),
    "build must stay a function so the count and the page clone their own request",
  );
  assert.ok(/build\(true\)/.test(body) && /build\(false\)/.test(body));
});

test("STRUCTURE: a failed read is never rendered as an empty page", () => {
  const body = messagesBody();
  assert.ok(
    /if \(total\.error \|\| listed\.error \|\| total\.count === null\) return unavailable\(\);/.test(
      body,
    ),
    "the count and the page must both be checked for failure before answering",
  );
  assert.ok(
    !/matching:\s*\w+\.count \?\? 0/.test(body),
    "`count ?? 0` is what made the overflow silent in the first place",
  );
});
