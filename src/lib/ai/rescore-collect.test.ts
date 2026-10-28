/**
 * rescoreJob's collection, under the mutation that broke it, and the pins
 * that keep rescoreJob on it.
 *
 *   node --test src/lib/ai/rescore-collect.test.ts
 *
 * The drift tests call the REAL collection functions against a fake table
 * that inserts, deletes and relocates rows between pages, and compare ID
 * SETS, never counts. The pins read the shipped rescoreJob and cv-allowance
 * source and refuse unless they go through these functions: a control in
 * negative-controls.mjs reverts rescoreJob to an inline offset loop and
 * requires the pin to go red, and another reverts this module to pageAll and
 * requires the drift test to go red.
 */

// @ts-nocheck — `.ts` specifiers, as paging.test.ts explains.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The module under test imports the shared pager by its `@/` alias, which
// plain Node cannot resolve; the repo's resolver hook maps it, as every src
// test of an aliased module does (cv-allowance.test.ts, for one).
register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/server-only-stub.mjs", import.meta.url));

const { FakeTable, fakeClient, hexRows } = await import("../supabase/fake-table.ts");
const { collectJobApplicationIds, collectScoredApplicationIds } = await import(
  "./rescore-collect.ts"
);

const JOB = "job-a";
const OTHER_JOB = "job-b";
const CO = "company-1";

function applications() {
  const mine = hexRows(2500, { job_id: JOB, company_id_snapshot: CO });
  const others = hexRows(300, { job_id: OTHER_JOB, company_id_snapshot: CO }).map((r) => ({
    ...r,
    id: `z${r.id}`,
  }));
  const wrongSnapshot = [
    { id: "zz-wrong-snapshot", job_id: JOB, company_id_snapshot: "company-2" },
  ];
  return {
    table: new FakeTable([...mine, ...others, ...wrongSnapshot]),
    expected: new Set(mine.map((r) => r.id)),
  };
}
function report(ids: string[], expected: Set<string>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return { seen, repeated, missing: [...expected].filter((id) => !seen.has(id)) };
}

test("collectJobApplicationIds: the complete set, scoped by job AND snapshot, on a quiet table", async () => {
  const { table, expected } = applications();
  const ids = await collectJobApplicationIds(fakeClient({ job_applications: table }), JOB, CO);
  const r = report(ids, expected);
  assert.equal(r.repeated.size, 0);
  assert.deepEqual(r.missing, []);
  assert.equal(r.seen.size, 2500, "the other job and the mismatched snapshot are never swept in");
});

test("#56 → #57: collectJobApplicationIds stays complete when a row is inserted before the cursor and deleted again between pages", async () => {
  const { table, expected } = applications();
  const synthetic = "0000000-before-the-cursor";
  table.between = (n) => {
    if (n === 1) table.insert({ id: synthetic, job_id: JOB, company_id_snapshot: CO });
    if (n === 2) table.remove(synthetic);
  };
  const ids = await collectJobApplicationIds(fakeClient({ job_applications: table }), JOB, CO);
  const r = report(ids, expected);
  assert.equal(r.repeated.size, 0, "no applicant is queued twice");
  assert.deepEqual(r.missing, [], "no applicant is silently left un-rescored");
  assert.equal(ids.length, 2500);
});

test("#56 → #57: collectJobApplicationIds stays complete when a page-1 tuple is relocated by an update", async () => {
  const { table, expected } = applications();
  table.between = (n, returned) => {
    if (n === 1) table.touch(returned[10].id);
  };
  const ids = await collectJobApplicationIds(fakeClient({ job_applications: table }), JOB, CO);
  const r = report(ids, expected);
  assert.equal(r.repeated.size, 0);
  assert.deepEqual(r.missing, []);
});

test("collectJobApplicationIds: a failed page throws; the caller never sees a partial list", async () => {
  const { table } = applications();
  await assert.rejects(
    () =>
      collectJobApplicationIds(
        fakeClient({ job_applications: table }, { failOnQuery: 2 }),
        JOB,
        CO,
      ),
    /\[rescore\] applications on the job failed after id/,
  );
});

test("collectScoredApplicationIds: only status=scored cards on the job, as a set, complete under drift", async () => {
  const scored = hexRows(1200, { job_id: JOB, company_id: CO, status: "scored" }).map((r) => ({
    ...r,
    application_id: `app-${r.id}`,
  }));
  const pending = hexRows(50, { job_id: JOB, company_id: CO, status: "pending" }).map((r) => ({
    ...r,
    id: `p${r.id}`,
    application_id: `pend-${r.id}`,
  }));
  const table = new FakeTable([...scored, ...pending]);
  table.between = (n) => {
    if (n === 1)
      table.insert({
        id: "0000000-new",
        job_id: JOB,
        company_id: CO,
        status: "scored",
        application_id: "app-new",
      });
  };
  const set = await collectScoredApplicationIds(fakeClient({ application_scores: table }), JOB, CO);
  assert.equal(set.size, 1200, "every scored card once; the pending ones never");
  for (const r of scored) assert.ok(set.has(r.application_id));
});

/* ──────────── the integration pins: rescoreJob and the allowance read ──────────── */

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

test("pin: rescoreJob collects through collectJobApplicationIds and collectScoredApplicationIds, with no inline .range() loop", () => {
  const src = read("src/app/ai-dashboard/(gated)/applicants/actions.ts");
  const start = src.indexOf("export async function rescoreJob(");
  const end = src.indexOf("\nexport async function", start + 1);
  const fn = src.slice(start, end);
  assert.match(
    fn,
    /await collectJobApplicationIds\(service, jobId, ctx\.companyId\)/,
    "the applications read",
  );
  assert.match(
    fn,
    /await collectScoredApplicationIds\(service, jobId, ctx\.companyId\)/,
    "the scored read",
  );
  assert.doesNotMatch(fn, /\.range\(/, "an inline offset loop is #56 again");
  assert.doesNotMatch(
    fn,
    /pageAll\(/,
    "pageAll is offset paging; #56's reproduction loses a row under it",
  );
  assert.match(
    fn,
    /unscoredFirst\(ids, scored\)\.slice\(0, room\)/,
    "the scoring priority is unchanged",
  );
  assert.match(
    fn,
    /scoresToQueue\(await readCvCapacity\(service, ctx\.companyId\), ids\.length\)/,
    "the capacity limit is unchanged",
  );
});

test("pin: the allowance read pages usage_events by key", () => {
  const src = read("src/lib/cv-allowance.ts");
  assert.match(src, /pageAllByKey<\{ id: string; quantity: number \| null \}>\(/);
  assert.doesNotMatch(
    src,
    /\bpageAll\(/,
    "the allowance read was the one pageAll call rescoreJob still went through",
  );
});
