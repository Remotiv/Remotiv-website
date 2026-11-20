/**
 * #41: the Applicants view's reads travel in one server action call, run in
 * parallel on the server, and keep every check they had.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/view-batch.test.ts"
 *
 * Measured before (staging, 10,003 applicants): a job switch made five server
 * actions in a row (counts, flagged, list, top scored, panel), each starting
 * only when the previous one answered. The batcher is driven directly; the
 * server side runs the real fetchApplicantsView against a fake database
 * (applicants-test-hook.mjs), compared query by query with the four actions
 * called one at a time. The staging timings are the behaviour.
 */
// @ts-nocheck - same reason as the other node:test files here: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { createViewBatcher, VIEW_COUNTS_MAX } = await import("./view-batch.ts");
const { fakeService, call } = await import("../../../../test-support/fake-postgrest.mjs");
const actions = await import("./actions.ts");

const ok = (value) => ({ ok: true, value });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A send that records each call and answers every part it was asked for. */
function recorder() {
  const sent = [];
  const send = async (request) => {
    sent.push(structuredClone(request));
    return {
      list: request.list ? { threw: false, read: ok({ page: request.list }) } : null,
      top: request.top ? { threw: false, read: ok(["top", request.top.jobId ?? null]) } : null,
      counts: (request.counts ?? []).map((q) => ({
        threw: false,
        read: ok({ for: q.jobId ?? "all" }),
      })),
      flagged: request.flagged ? { threw: false, read: ok(7) } : null,
    };
  };
  return { sent, send };
}

test("V1. what one commit asks for goes in ONE call, and each part gets its own answer", async () => {
  const r = recorder();
  const b = createViewBatcher(r.send);
  const [counts, flagged, list, top, company] = await Promise.all([
    b.counts({ jobId: "j1" }),
    b.flagged({ jobId: "j1" }),
    b.list({ jobId: "j1", page: 1 }),
    b.top({ jobId: "j1", page: 1 }),
    b.counts({}),
  ]);
  assert.equal(r.sent.length, 1, "one server action call");
  assert.deepEqual(r.sent[0], {
    counts: [{ jobId: "j1" }, {}],
    flagged: { jobId: "j1" },
    list: { jobId: "j1", page: 1 },
    top: { jobId: "j1", page: 1 },
  });
  assert.deepEqual(counts, ok({ for: "j1" }));
  assert.deepEqual(company, ok({ for: "all" }));
  assert.deepEqual(flagged, ok(7));
  assert.deepEqual(list, ok({ page: { jobId: "j1", page: 1 } }));
  assert.deepEqual(top, ok(["top", "j1"]));
});

test("V2. reads asked in different ticks are separate calls (a page turn later is its own)", async () => {
  const r = recorder();
  const b = createViewBatcher(r.send);
  await b.list({ page: 1 });
  await tick();
  await b.list({ page: 2 });
  assert.equal(r.sent.length, 2);
});

test("V3. a second read of the same kind in one tick never overwrites the first: it starts the next call", async () => {
  const r = recorder();
  const b = createViewBatcher(r.send);
  const all = await Promise.all([
    b.list({ page: 1 }),
    b.list({ page: 2 }),
    b.counts({}),
    b.counts({ jobId: "x" }),
    b.counts({ jobId: "y" }),
  ]);
  assert.deepEqual(all, [
    ok({ page: { page: 1 } }),
    ok({ page: { page: 2 } }),
    ok({ for: "all" }),
    ok({ for: "x" }),
    ok({ for: "y" }),
  ]);
  // list 1 | list 2 and two counts | the third count (two per call at most).
  assert.deepEqual(
    r.sent.map((req) => [req.list?.page ?? null, (req.counts ?? []).length]),
    [
      [1, 0],
      [2, 2],
      [null, 1],
    ],
  );
  assert.equal(VIEW_COUNTS_MAX, 2);
});

test("V4. a part the server could not produce fails alone; a call that fails outright fails every part in it", async () => {
  const b = createViewBatcher(async (request) => ({
    list: { threw: true },
    top: null,
    counts: [],
    flagged: request.flagged ? { threw: false, read: ok(3) } : null,
  }));
  const [list, flagged] = await Promise.allSettled([b.list({}), b.flagged({})]);
  assert.equal(list.status, "rejected");
  assert.deepEqual(flagged, { status: "fulfilled", value: ok(3) });

  const down = createViewBatcher(async () => {
    throw new TypeError("fetch failed");
  });
  const all = await Promise.allSettled([
    down.list({}),
    down.top({}),
    down.counts({}),
    down.flagged({}),
  ]);
  assert.deepEqual(
    all.map((x) => x.status),
    ["rejected", "rejected", "rejected", "rejected"],
  );
});

/* ── the server side: same queries, same checks, in parallel ── */

const CO = "c0000000-0000-0000-0000-000000000001";
const ctx = {
  companyId: CO,
  role: "owner",
  memberId: "m-1",
  memberName: "Rae",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { id: CO, name: "Acme" },
};

/** An empty company that answers slowly, recording how many reads were in flight at once. */
function slowWorld() {
  let inFlight = 0;
  let peak = 0;
  /** Which part each read belongs to, and when it ran. */
  const spans = [];
  const partOf = (calls) => {
    const text = JSON.stringify(calls);
    if (text.includes('"range"')) return "list";
    if (text.includes('"limit",10')) return "top";
    if (text.includes("shortlist_flagged_at")) return "flagged";
    if (text.includes('"head":true')) return "counts";
    return "other";
  };
  const service = fakeService(async (_table, calls) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const span = { part: partOf(calls), start: performance.now(), end: 0 };
    spans.push(span);
    await new Promise((r) => setTimeout(r, 15));
    span.end = performance.now();
    inFlight -= 1;
    if (call(calls, "maybeSingle")) return { data: null, error: null };
    return { data: [], count: 0, error: null };
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctx;
  /** True when every one of these parts had a read in flight at one same moment. */
  const together = (parts) => {
    const first = parts.map((p) => spans.find((x) => x.part === p));
    if (first.some((x) => !x)) return false;
    return Math.max(...first.map((x) => x.start)) < Math.min(...first.map((x) => x.end));
  };
  return { service, peak: () => peak, together };
}
/** Every query as text, with the clock's "this week" boundary blanked (each call reads the clock). */
const shape = (queries) =>
  queries
    .map((q) =>
      `${q.table} ${JSON.stringify(q.calls)}`.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<clock>"),
    )
    .sort();

const Q = { jobId: "a0000000-0000-0000-0000-00000000000a", page: 1, sort: "best" };

test("V5. fetchApplicantsView sends exactly the queries the four actions send one by one: same company and scope filters", async () => {
  const one = slowWorld();
  await actions.fetchCompanyApplicants(Q);
  await actions.fetchTopScoredApplicants(Q);
  await actions.fetchApplicantCounts({ jobId: Q.jobId });
  await actions.fetchApplicantCounts({});
  await actions.countFlaggedApplicants({ jobId: Q.jobId });
  const separately = shape(one.service.queries);

  const view = slowWorld();
  const out = await actions.fetchApplicantsView({
    list: Q,
    top: Q,
    counts: [{ jobId: Q.jobId }, {}],
    flagged: { jobId: Q.jobId },
  });
  assert.deepEqual(shape(view.service.queries), separately);
  assert.ok(separately.length > 5, "the comparison saw the real reads");
  assert.ok(
    view.service.queries.every((q) => JSON.stringify(q.calls).includes(CO)),
    "every read is company-scoped",
  );
  assert.equal(out.list.threw, false);
  assert.equal(out.counts.length, 2);
  // And they ran together, not in a queue: the first read of every part was
  // in flight at the same moment.
  assert.ok(view.together(["list", "top", "counts", "flagged"]), "the four parts ran at once");
  assert.ok(!one.together(["list", "top"]), "one by one, they did not (the test can tell)");
});

test("V6. a part that throws fails alone; counts are capped; an empty request reads nothing", async () => {
  slowWorld();
  globalThis.__applicantsCtxForTests = null; // getCompanyContext throws for every part
  const quiet = console.error;
  console.error = () => {};
  try {
    const out = await actions.fetchApplicantsView({ list: Q, flagged: {} });
    assert.deepEqual(out.list, { threw: true });
    assert.deepEqual(out.flagged, { threw: true });
    assert.equal(out.top, null);
  } finally {
    console.error = quiet;
  }
  const w = slowWorld();
  const capped = await actions.fetchApplicantsView({ counts: [{}, {}, {}, {}] });
  assert.equal(capped.counts.length, VIEW_COUNTS_MAX);
  const none = slowWorld();
  await actions.fetchApplicantsView({});
  assert.equal(none.service.queries.length, 0);
  assert.ok(w);
});

/* ── the client and the server render (source pins; staging is the behaviour) ── */

const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("V7. every list, top, counts and flagged read on the client goes through the batch; none calls its action directly", () => {
  assert.match(client, /const viewBatch = createViewBatcher\(fetchApplicantsView\);/);
  for (const [kind, n] of [
    ["list", 1],
    ["top", 1],
    ["counts", 2],
    ["flagged", 1],
  ]) {
    // The formatter may break `viewBatch.counts(` across lines.
    assert.equal(
      (client.match(new RegExp(`viewBatch\\s*\\.${kind}\\(`, "g")) ?? []).length,
      n,
      kind,
    );
  }
  for (const direct of [
    "fetchCompanyApplicants(",
    "fetchTopScoredApplicants(",
    "fetchApplicantCounts(",
    "countFlaggedApplicants(",
  ]) {
    assert.equal(client.split(direct).length - 1, 0, direct);
  }
});

test("V8. first load: the flagged count, the scope, the tip and the reply-to are read in the server's one wave", () => {
  const wave = page.slice(
    page.indexOf("const ctxRead = getCompanyContext();"),
    page.indexOf("const unassigned ="),
  );
  assert.ok(wave.length > 0);
  assert.match(
    wave,
    /countFlaggedApplicants\(served\.request\.jobId \? \{ jobId: served\.request\.jobId \} : \{\}\),/,
  );
  assert.match(wave, /ctxRead\.then\(\(c\) => readJobScope\(c\)\),/);
  assert.match(wave, /ctxRead\.then\(\(c\) => isTipDismissed\(c\.memberId, "cv_scoring"\)\),/);
  assert.match(wave, /\.select\("candidate_reply_email"\)/);
  assert.doesNotMatch(
    page,
    /await readJobScope\(ctx\)|await isTipDismissed\(/,
    "nothing waits behind the wave",
  );
  assert.match(
    page,
    /initialFlagged=\{\s*flagged\.ok \? \{ job: served\.request\.jobId \?\? "all", count: flagged\.value \} : null\s*\}/,
  );
  assert.match(client, /useState<number \| null>\(initialFlagged\?\.count \?\? null\)/);
});

test("V9. the bell's first read is rendered by the layout; the bell reads on mount only without it", () => {
  const layout = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /fetchNotifications\(\)\.catch\(\(\) => null\),/);
  assert.match(layout, /initialNotifications=\{bellRead\}/);
  const bell = readFileSync(
    new URL("../../_components/notification-bell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    bell,
    /const renderedFirst = initial !== null;\s*useEffect\(\(\) => \{\s*if \(renderedFirst\) return;\s*void load\(\);/,
  );
  // Opening the panel still reads it fresh.
  assert.match(bell, /if \(!open\) return;\s*void load\(\);/);
});

test("V10. the panel's follow-up reads run in one wave, after the row and its role check", () => {
  const src = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const fn = src.slice(
    src.indexOf("export async function fetchCompanyApplicant("),
    src.indexOf("async function readScoringFacts("),
  );
  const role = fn.indexOf(
    'if (!(await roleAllowsJobAction(ctx, row.job_id ?? ""))) return answered(null);',
  );
  const wave = fn.indexOf("] = await Promise.all([");
  assert.ok(role > 0 && wave > role, "the role check still comes first");
  const inWave = fn.slice(wave, fn.indexOf("]);", wave));
  for (const read of [
    "application_stage_history",
    "application_scores",
    '.from("jobs")',
    "readComments(",
  ]) {
    assert.ok(inWave.includes(read), read);
  }
  assert.equal((fn.match(/await service/g) ?? []).length, 1, "only the row read waits on its own");
});
