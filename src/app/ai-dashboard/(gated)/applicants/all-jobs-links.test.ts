/**
 * Links from other pages open Applicants on exactly the figure they state,
 * because Split lands on one job by default: a company-wide figure opens All
 * jobs (?job=all), an Applied count opens All jobs on the Applied tab
 * (?job=all&stage=applied), a role card opens its own job (?job=<id>), and a
 * latest-applicant row opens that applicant (?applicant=<id>; the server
 * resolves the job). The sidebar link stays bare: it lands on the newest job
 * under Split.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/all-jobs-links.test.ts"
 *
 * Source pins, keyed by the link text, not by line. With the flag off,
 * ?job=all is All jobs too: decodeListUrl reads any non-uuid job as none, and
 * the server serves the decoded URL as it is (split-job.test.ts pins both);
 * ?stage=, ?job=<id> and ?applicant= are read the same way flag on and off.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { decodeListUrl, splitJobFor } = await import("./list-state.ts");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ALL = '"/ai-dashboard/applicants?job=all"';
const APPLIED = '"/ai-dashboard/applicants?job=all&stage=applied"';
const BARE = '"/ai-dashboard/applicants"';
const count = (src, s) => src.split(s).length - 1;

/** [?job=all links, ?job=all&stage=applied links] per file. */
const FILES = {
  "../_overview-client.tsx": [2, 1],
  "../weekly-report/_weekly-client.tsx": [3, 0],
  "../weekly-report/actions.ts": [0, 1],
  "../analytics/_analytics-client.tsx": [1, 0],
  "../analytics/actions.ts": [1, 0],
  "../interviews/_interviews-client.tsx": [1, 0],
};

test("Overview, Weekly report, Analytics and Interviews never link bare", () => {
  for (const [file, [all, applied]] of Object.entries(FILES)) {
    const src = read(file);
    assert.equal(count(src, ALL), all, `${file}: ?job=all links`);
    assert.equal(count(src, APPLIED), applied, `${file}: ?job=all&stage=applied links`);
    assert.equal(count(src, BARE), 0, `${file}: a bare Applicants link is back`);
  }
});

test("each link is the one beside its figure", () => {
  const overview = read("../_overview-client.tsx");
  const near = (src, anchor, width = 900) => {
    const at = src.indexOf(anchor);
    assert.ok(at > -1, `${anchor} not found`);
    return src.slice(Math.max(0, at - width), at + width);
  };
  assert.match(near(overview, "All {totalApplicants}"), /applicants\?job=all/);
  assert.match(
    near(overview, 'cta: "Review applicants"', 300),
    /applicants\?job=all&stage=applied/,
    "the awaiting-review count is the Applied tab",
  );
  const fn = (name) =>
    overview.slice(
      overview.indexOf(`function ${name}(`),
      overview.indexOf(`function ${name}(`) + 400,
    );
  assert.match(
    fn("RoleCard"),
    /href=\{`\/ai-dashboard\/applicants\?job=\$\{role\.id\}`\}/,
    "a role card opens its own job",
  );
  assert.match(
    fn("ApplicantRow"),
    /href=\{`\/ai-dashboard\/applicants\?applicant=\$\{row\.id\}`\}/,
    "a latest-applicant row opens that applicant, with no job param",
  );
  const weekly = read("../weekly-report/_weekly-client.tsx");
  assert.match(near(weekly, "All applicants →"), /applicants\?job=all/);
  assert.match(near(weekly, "more scored"), /applicants\?job=all/);
  assert.match(
    near(read("../weekly-report/actions.ts"), 'cta: "Review",', 200),
    /applicants\?job=all&stage=applied/,
  );
  assert.match(
    near(read("../analytics/_analytics-client.tsx"), "See who is waiting", 400),
    /applicants\?job=all/,
  );
  assert.match(
    near(read("../analytics/actions.ts"), 'cta: "See the stage"', 200),
    /applicants\?job=all/,
  );
});

test("the sidebar link stays bare: it lands on the newest job under Split", () => {
  const sidebar = read("../../_components/ai-sidebar.tsx");
  assert.ok(sidebar.includes('"/ai-dashboard/applicants"'));
  assert.ok(!sidebar.includes("applicants?job=all"));
});

test("?job=all is All jobs with the flag off and on", () => {
  const params = new URLSearchParams("job=all");
  assert.equal(decodeListUrl(params).request.jobId, null, "flag off");
  assert.equal(splitJobFor(params, "aaaaaaaa-1111-4222-8333-944445555666"), null, "flag on");
});

test("?job=all&stage=applied is All jobs on the Applied tab, flag off and on", () => {
  const params = new URLSearchParams("job=all&stage=applied");
  const decoded = decodeListUrl(params);
  assert.equal(decoded.request.jobId, null);
  assert.equal(decoded.request.stage, "applied");
  assert.equal(splitJobFor(params, "aaaaaaaa-1111-4222-8333-944445555666"), null);
});
