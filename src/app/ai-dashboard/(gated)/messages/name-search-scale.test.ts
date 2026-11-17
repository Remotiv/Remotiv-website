/**
 * The Messages name search finds every matching applicant, at the scale target
 * (#22, #75): 2,500 applicants on one job, 10,000 in one company.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/name-search-scale.test.ts"
 *
 * ── The bug this locks down ──────────────────────────────────
 *
 * The applicant read behind the name search stopped at .limit(1000), with no
 * order, so it saw an arbitrary 1000 applicants; and the matching ids were cut
 * with .slice(0, 300) before they reached the log query. A search matching more
 * than 300 applicants silently lost the rest, and one in a company of more than
 * 1000 could miss its answer entirely, with the total reported as if complete.
 *
 * ── The evaluator ────────────────────────────────────────────
 *
 * The same PostgREST semantics list-scope.test.ts models and documents (each
 * measured there against production): unprefixed filters bind to the parent,
 * `job_applications.` filters to the `!inner` embed, or() is parsed by
 * postgrest-text.mjs, orders apply in sequence, range pages, and a count is
 * exact and head-only. This file adds what the scale needs: Map lookups and
 * Set-backed `in` lists, and range() honoured on job_applications as well, so
 * a read capped at 1000 really is capped.
 */
// @ts-nocheck - same reason as list-scope.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { evalLogic, ilikeMatches, parseLogic } = await import(
  "../../../../test-support/postgrest-text.mjs"
);
const { fetchMessages } = await import("./actions.ts");
const { MESSAGES_PAGE_SIZE: PAGE } = await import("./types.ts");

const CO = "c0000000-0000-4000-8000-000000000001";
const MEMBER = "m0000000-0000-4000-8000-000000000001";
const JOBS = [1, 2, 3, 4].map((n) => `j000000${n}-0000-4000-8000-00000000000${n}`);
const PER_JOB = 2_500;

/* ── the seed: 10,000 applicants, one log each, plus two search edge cases ── */

const pad = (n, w = 5) => String(n).padStart(w, "0");
const appId = (i) => `a${pad(i, 7)}-0000-4000-8000-000000000000`;

/**
 * Applicant i is "Scale Cand<i>" on job floor(i / 2,500). The needle used below,
 * "scale cand", spans first and last name: it only matches through the joined
 * "first last email role" text, which is what keeps the match in code.
 */
const APPS = Array.from({ length: PER_JOB * JOBS.length }, (_, i) => ({
  id: appId(i),
  job_id: JOBS[Math.floor(i / PER_JOB)],
  company_id_snapshot: CO,
  first_name: "Scale",
  last_name: `Cand${i}`,
  email: `c${i}@example.test`,
  job_title_snapshot: null,
  jobs: { title: "Role" },
}));
// Someone whose name does not match, on job 1, for the subject-only side.
APPS.push({
  id: appId(99_999),
  job_id: JOBS[0],
  company_id_snapshot: CO,
  first_name: "Other",
  last_name: "Person",
  email: "other@example.test",
  job_title_snapshot: null,
  jobs: { title: "Role" },
});
const APP_BY_ID = new Map(APPS.map((a) => [a.id, a]));

const at = (minutesAgo) =>
  new Date(Date.UTC(2026, 10, 1, 12, 0) - minutesAgo * 60_000).toISOString();

const log = (id, applicationId, minutesAgo, over = {}) => ({
  id,
  company_id: CO,
  application_id: applicationId,
  event: "manual",
  status: "sent",
  to_address: "stored@example.test",
  subject: "Your application",
  body: "<p>hello</p>",
  scheduled_for: null,
  sent_at: at(minutesAgo),
  sent_by_name: null,
  created_at: at(minutesAgo),
  ...over,
});

/** One log per applicant; applicant 0's is the newest. Log ids sort with time. */
const LOGS = APPS.slice(0, PER_JOB * JOBS.length).map((a, i) =>
  log(`b${pad(i, 7)}-0000-4000-8000-000000000000`, a.id, 10 + i),
);
// Subject-only match: a non-matching applicant, a subject that names the needle.
LOGS.push(
  log("e0000001-0000-4000-8000-000000000000", appId(99_999), 5, {
    subject: "Re: Scale Cand interview",
  }),
);
// Matched TWICE, by name and by subject: must be counted and shown once.
LOGS.push(
  log("e0000002-0000-4000-8000-000000000000", appId(4), 6, { subject: "Scale Cand follow-up" }),
);

/* ── the evaluator ────────────────────────────────────────────── */

const EMBED = "job_applications.";

/** A parsed or() tree whose `in` lists are Sets, so 300-id lists cost O(1). */
function fastTree(text) {
  const tree = parseLogic(`or(${text})`);
  const walk = (n) => {
    if (n.kind !== "term") return n.children.forEach(walk);
    if (n.col.startsWith(EMBED))
      throw new Error(`test: PGRST100, embedded column in or(): ${n.col}`);
    if (n.op === "in") {
      const set = new Set(n.val);
      n.val = { includes: (v) => set.has(v) };
    }
  };
  walk(tree);
  return tree;
}

function filterOf([method, col, a, b]) {
  if (method === "eq") return (v) => v === a;
  if (method === "neq") return (v) => v !== a;
  if (method === "in") {
    const set = new Set(a);
    return (v) => set.has(v);
  }
  if (method === "ilike") return (v) => v !== null && v !== undefined && ilikeMatches(a, v);
  if (method === "not" && a === "is" && b === null) return (v) => v !== null && v !== undefined;
  throw new Error(`test: evaluator does not model .${method}(${col})`);
}

/** Filters, orders, range and count options, read off a recorded query. */
function readCalls(calls) {
  const parent = [];
  const embedded = [];
  const ors = [];
  const orders = [];
  let range = null;
  let select = null;
  for (const c of calls) {
    const [method, ...args] = c;
    if (method === "select") select = { columns: String(args[0] ?? ""), options: args[1] ?? {} };
    else if (method === "order") orders.push({ col: args[0], asc: args[1]?.ascending !== false });
    else if (method === "range") range = { from: args[0], to: args[1] };
    else if (method === "limit") throw new Error("test: a limit on this path caps the read");
    else if (method === "or") ors.push(fastTree(String(args[0])));
    else if (method === "maybeSingle") continue;
    else {
      const f = filterOf(c);
      if (String(args[0]).startsWith(EMBED)) embedded.push({ col: args[0].slice(EMBED.length), f });
      else parent.push({ col: args[0], f });
    }
  }
  return { parent, embedded, ors, orders, range, select };
}

function sortRange(rows, orders, range) {
  const sorted = orders.length
    ? [...rows].sort((x, y) => {
        for (const o of orders) {
          const a = String(x[o.col] ?? "");
          const b = String(y[o.col] ?? "");
          if (a !== b) return (a < b ? -1 : 1) * (o.asc ? 1 : -1);
        }
        return 0;
      })
    : rows;
  return range ? sorted.slice(range.from, range.to + 1) : sorted;
}

function queryLogs(calls, logs = LOGS, appById = APP_BY_ID) {
  const q = readCalls(calls);
  assert.match(q.select.columns, /job_applications!inner\(/, "every log read keeps the embed");
  let rows = logs.filter((l) => q.parent.every(({ col, f }) => f(l[col])));
  rows = rows.filter((l) => {
    const app = appById.get(l.application_id);
    return app && q.embedded.every(({ col, f }) => f(app[col]));
  });
  for (const tree of q.ors) rows = rows.filter((l) => evalLogic(tree, l));
  if (q.select.options.count === "exact") {
    assert.equal(q.select.options.head, true, "counts stay head-only");
    return { data: null, count: rows.length, error: null };
  }
  const cols = q.select.columns
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith("job_applications"));
  const page = sortRange(rows, q.orders, q.range);
  return {
    data: page.map((l) => Object.fromEntries(cols.map((c) => [c, l[c] ?? null]))),
    count: null,
    error: null,
  };
}

function queryApps(calls, apps = APPS) {
  const q = readCalls(calls);
  const rows = apps.filter((a) => q.parent.every(({ col, f }) => f(a[col])));
  // PostgREST's own row cap: an unranged read still stops at 1000.
  const page = sortRange(rows, q.orders, q.range ?? { from: 0, to: 999 });
  return { data: page, error: null };
}

/* ── driving the real action ──────────────────────────────────── */

/**
 * `failOn(table, calls, n)` may answer a request with an error: n counts the
 * communication_logs requests so far.
 */
/**
 * Requests in flight, measured at the database: each answer waits one turn of
 * the event loop, so requests issued together overlap and are counted together.
 */
const flight = { now: 0, max: 0, total: 0 };

async function search(input, { role = "owner", jobs = [], failOn = null, apps, logs } = {}) {
  let logRequests = 0;
  flight.now = 0;
  flight.max = 0;
  flight.total = 0;
  const answer = (table, calls) => {
    if (table === "job_hiring_team")
      return { data: jobs.map((job_id) => ({ job_id })), error: null };
    if (table === "communication_logs") {
      logRequests += 1;
      if (failOn?.(calls, logRequests)) return { data: null, count: null, error: { message: "x" } };
      return logs ? queryLogs(calls, logs, new Map(apps.map((a) => [a.id, a]))) : queryLogs(calls);
    }
    if (table === "job_applications") return queryApps(calls, apps);
    throw new Error(`test: unexpected table ${table}`);
  };
  const service = fakeService(async (table, calls) => {
    flight.now += 1;
    flight.total += 1;
    flight.max = Math.max(flight.max, flight.now);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return answer(table, calls);
    } finally {
      flight.now -= 1;
    }
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = {
    companyId: CO,
    role,
    memberId: MEMBER,
    memberName: "Test Member",
    user: { id: "u-1", email: "member@example.test" },
    company: { name: "Acme" },
  };
  try {
    const read = await fetchMessages({ tab: "all", jobId: "", search: "", page: 0, ...input });
    return { read, service };
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

const NEEDLE = "scale cand";

/** The answer, computed independently: every visible log whose applicant or subject matches. */
function expected({ jobId = null } = {}) {
  const hit = (l) => {
    const a = APP_BY_ID.get(l.application_id);
    if (jobId && a.job_id !== jobId) return false;
    const name = [a.first_name, a.last_name, a.email, a.jobs.title].join(" ").toLowerCase();
    return name.includes(NEEDLE) || l.subject.toLowerCase().includes(NEEDLE);
  };
  return LOGS.filter(hit)
    .sort((x, y) =>
      x.created_at !== y.created_at ? (x.created_at < y.created_at ? 1 : -1) : x.id < y.id ? 1 : -1,
    )
    .map((l) => l.id);
}

const logOf = (i) => LOGS[i].id;
const keyReads = (service) =>
  service.queries.filter(
    (q) =>
      q.table === "communication_logs" &&
      /^id, created_at, job_applications/.test(String(q.calls.find((c) => c[0] === "select")[1])),
  );

/* ── 2,500 applicants on one job ──────────────────────────────── */

/*
 * Every page, start to end, for an owner filtering to job 1. The pages joined
 * must be exactly the independently computed answer: nothing twice, nothing
 * missing, in order. Negative controls: put back .limit(1000) on the applicant
 * read or .slice(0, 300) on the id list, and the total and the pages shrink.
 */
test("2,500 matching applicants on one job: every page, joined, is the whole answer once and in order", async () => {
  const want = expected({ jobId: JOBS[0] });
  assert.equal(
    want.length,
    PER_JOB + 2,
    "the seed: 2,500 names, one subject-only, one matched twice",
  );
  const seen = [];
  const pages = Math.ceil(want.length / PAGE);
  for (let page = 0; page < pages; page++) {
    const { read } = await search({ jobId: JOBS[0], search: NEEDLE, page });
    assert.ok(read.ok, `page ${page} unavailable`);
    assert.equal(read.value.matching, want.length, `page ${page}: the total moved`);
    seen.push(...read.value.rows.map((r) => r.id));
  }
  assert.deepEqual(seen, want);
  const past = await search({ jobId: JOBS[0], search: NEEDLE, page: pages });
  assert.deepEqual(past.read.value.rows, [], "a page past the end is empty");
});

test("the 301st and the 1,001st matching applicant's messages appear, on the right page", async () => {
  const want = expected({ jobId: JOBS[0] });
  for (const i of [300, 1000]) {
    const id = logOf(i);
    const page = Math.floor(want.indexOf(id) / PAGE);
    const { read } = await search({ jobId: JOBS[0], search: NEEDLE, page });
    const row = read.value.rows.find((r) => r.id === id);
    assert.ok(row, `applicant ${i + 1}'s message is missing`);
    assert.equal(row.candidateName, `Scale Cand${i}`, "and it is hydrated with its applicant");
  }
});

test("a message matched by name and by subject is counted and shown once", async () => {
  const { read } = await search({ jobId: JOBS[0], search: NEEDLE, page: 0 });
  const twice = "e0000002-0000-4000-8000-000000000000";
  assert.equal(read.value.rows.filter((r) => r.id === twice).length, 1);
  assert.ok(read.value.rows.some((r) => r.id === "e0000001-0000-4000-8000-000000000000"));
});

// Negative control: an unordered or unranged applicant read misses rows here.
test("the applicant read is paged in id order to the end, never capped", async () => {
  const { service } = await search({ jobId: JOBS[0], search: NEEDLE });
  const reads = service.queries.filter(
    (q) => q.table === "job_applications" && q.calls.some((c) => c[0] === "range"),
  );
  assert.deepEqual(
    reads.map((q) => q.calls.find((c) => c[0] === "range").slice(1)),
    [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ],
  );
  for (const q of reads) {
    assert.ok(
      q.calls.some((c) => c[0] === "order" && c[1] === "id"),
      "paged in a stable order",
    );
    assert.ok(q.calls.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot" && c[2] === CO));
  }
});

/* ── 10,000 applicants in one company ─────────────────────────── */

test("10,000 matching applicants in a company: the exact total, and the newest, middle and oldest pages", async () => {
  const want = expected();
  assert.equal(want.length, PER_JOB * JOBS.length + 2);
  const last = Math.ceil(want.length / PAGE) - 1;
  for (const page of [0, 1, 50, 249, last]) {
    const { read } = await search({ search: NEEDLE, page });
    assert.ok(read.ok);
    assert.equal(read.value.matching, want.length);
    assert.deepEqual(
      read.value.rows.map((r) => r.id),
      want.slice(page * PAGE, page * PAGE + PAGE),
      `page ${page}`,
    );
  }
});

test("a recruiter scoped to one job of four sees that job's matches and nothing else", async () => {
  const { read } = await search(
    { search: NEEDLE, page: 0 },
    { role: "recruiter", jobs: [JOBS[2]] },
  );
  const want = expected({ jobId: JOBS[2] });
  assert.equal(read.value.matching, want.length);
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    want.slice(0, PAGE),
  );
});

/* ── the boundary, and failure ────────────────────────────────── */

test("up to 300 name matches keeps the single request pair; 301 takes the merged path", async () => {
  // Cand2 matches Cand2, Cand20..29, Cand200..299, Cand2000..2499 on job 1: well over 300.
  // Cand10 on job 1 matches Cand10, Cand100..109, Cand1000..1099: 111.
  const small = await search({ jobId: JOBS[0], search: "scale cand10", page: 0 });
  assert.equal(keyReads(small.service).length, 0, "no key reads at or under the chunk size");
  assert.equal(
    small.service.queries.filter((q) => q.table === "communication_logs").length,
    2,
    "one count and one page, as before",
  );
  const big = await search({ jobId: JOBS[0], search: "scale cand2", page: 0 });
  assert.ok(keyReads(big.service).length > 1, "past 300 the ids go in chunks");
  for (const q of keyReads(big.service)) {
    const or = q.calls.find((c) => c[0] === "or");
    if (or) assert.ok(or[1].split(",").length <= 300, "no chunk carries more than 300 ids");
  }
});

test("any failed read on the merged path is unavailable, never a partial answer", async () => {
  for (const n of [1, 2, 5]) {
    const { read } = await search(
      { jobId: JOBS[0], search: NEEDLE, page: 0 },
      { failOn: (_calls, count) => count === n },
    );
    assert.equal(read.ok, false, `request ${n} failed and an answer was still given`);
  }
});

test("the merged path keeps the tab, the tenant filters and the job filter on every request", async () => {
  const { service } = await search({ jobId: JOBS[0], search: NEEDLE, tab: "written" });
  for (const q of service.queries.filter((x) => x.table === "communication_logs")) {
    const has = (m, col, v) =>
      q.calls.some((c) => c[0] === m && c[1] === col && (v === undefined || c[2] === v));
    assert.ok(has("eq", "company_id", CO));
    assert.ok(has("eq", "job_applications.company_id_snapshot", CO));
    assert.ok(has("eq", "job_applications.job_id", JOBS[0]));
    assert.ok(has("eq", "event", "manual"), "the Written tab");
  }
});

/* ── concurrency ──────────────────────────────────────────────── */

/*
 * 10,002 matches: 11 applicant pages, then the subject key read and 34 chunk
 * key reads, then the page's rows and hydrate. Unpooled, all 35 key reads went
 * out together (measured: 35 in flight, 48 requests). Negative control: raise
 * KEY_READS_IN_FLIGHT and the first assertion fails.
 */
test("at 10,000 matches no more than 6 requests are ever in flight, and the page is unchanged", async () => {
  const { read } = await search({ search: NEEDLE, page: 0 });
  assert.ok(flight.max <= 6, `${flight.max} requests in flight`);
  assert.equal(flight.max, 6, "the pool is used, not serialised to one");
  assert.equal(flight.total, 48, "11 applicant pages + 35 key reads + 1 page read + 1 hydrate");
  assert.equal(read.value.matching, expected().length);
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    expected().slice(0, PAGE),
  );
});

/* ── ordering across fractional precision ─────────────────────── */

/*
 * PostgREST writes timestamptz in one UTC form with trailing fractional zeros
 * dropped, so one page can hold "...:00+00:00", "...:00.5+00:00" and
 * "...:00.123456+00:00". mergedKeys orders by the TEXT. This proves that text
 * order is Postgres order for those forms, against a comparator that reads the
 * value as whole microseconds, and that a Date would get it wrong: .123456 and
 * .123457 are one microsecond apart, the same millisecond, so a Date ties them
 * and the id breaks the tie the other way. Negative control: compare created_at
 * as Date in mergedKeys and this fails.
 */
const TIE_JOB = JOBS[0];
const TIE_APPS = Array.from({ length: 350 }, (_, i) => ({
  id: `d${pad(i, 7)}-0000-4000-8000-000000000000`,
  job_id: TIE_JOB,
  company_id_snapshot: CO,
  first_name: "Tie",
  last_name: `Cand${i}`,
  email: `t${i}@example.test`,
  job_title_snapshot: null,
  jobs: { title: "Role" },
}));
const pgStamp = (minutesAgo) =>
  `${new Date(Date.UTC(2026, 9, 1, 12, 0) - minutesAgo * 60_000).toISOString().slice(0, 19)}+00:00`;
const tieLog = (id, i, created_at) =>
  log(id, TIE_APPS[i].id, 0, { created_at, sent_at: created_at });
const T = (n) => `f00000${n}-0000-4000-8000-000000000000`;
const SPECIAL = [
  tieLog(T("01"), 0, "2026-11-01T12:00:00+00:00"),
  tieLog(T("02"), 1, "2026-11-01T12:00:00.5+00:00"),
  tieLog(T("09"), 2, "2026-11-01T12:00:00.123456+00:00"),
  tieLog(T("03"), 3, "2026-11-01T12:00:00.123457+00:00"),
  tieLog(T("05"), 4, "2026-11-01T12:00:00.12+00:00"),
  tieLog(T("06"), 5, "2026-11-01T12:00:00.12+00:00"),
];
const TIE_LOGS = [
  ...TIE_APPS.map((_a, i) =>
    tieLog(`c${pad(i, 7)}-0000-4000-8000-000000000000`, i, pgStamp(i + 1)),
  ),
  ...SPECIAL,
];

/** created_at as whole microseconds since the epoch, read from the text. */
function micros(text) {
  const m = /^(.{19})(?:\.(\d{1,6}))?\+00:00$/.exec(text);
  assert.ok(m, `not PostgREST's UTC form: ${text}`);
  const seconds = BigInt(Date.parse(`${m[1]}Z`) / 1000);
  return seconds * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

test("text order of created_at is Postgres order across fractional precision; a Date is not", async () => {
  const postgres = [...SPECIAL]
    .sort((x, y) => {
      const a = micros(x.created_at);
      const b = micros(y.created_at);
      return a !== b ? (a < b ? 1 : -1) : x.id < y.id ? 1 : -1;
    })
    .map((l) => l.id);
  assert.deepEqual(postgres, [T("02"), T("03"), T("09"), T("06"), T("05"), T("01")]);

  const { read } = await search(
    { search: "tie cand", page: 0 },
    { apps: TIE_APPS, logs: TIE_LOGS },
  );
  assert.ok(read.ok);
  assert.equal(read.value.matching, 356, "350 applicants' logs plus the six specials");
  assert.deepEqual(
    read.value.rows.slice(0, 6).map((r) => r.id),
    postgres,
    "the merged page orders exactly as Postgres would",
  );

  // What a Date comparison would have produced: .123456 and .123457 tie.
  const asDate = [...SPECIAL]
    .sort((x, y) => {
      const a = new Date(x.created_at).getTime();
      const b = new Date(y.created_at).getTime();
      return a !== b ? b - a : x.id < y.id ? 1 : -1;
    })
    .map((l) => l.id);
  assert.notDeepEqual(asDate, postgres, "a Date comparison would misorder this page");
});
