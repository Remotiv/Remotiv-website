/**
 * One job at a time under Applicants Split (commit 8): the URL rules.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-job.test.ts"
 *
 * splitJobFor is shared by page.tsx and the client, so the job the server
 * serves and the client's first request are the same (no second read). These
 * pin its four cases, the explicit ?job=all writer, and that the live page's
 * URLs (flag off) are unchanged. Plus source pins on the wiring.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { ALL_JOBS, decodeListUrl, encodeListUrl, splitJobFor, splitJobIsExplicit } = await import(
  "./list-state.ts"
);

const J1 = "3f1c2a4e-1111-4222-8333-944445555666";
const LANDING = "aaaaaaaa-1111-4222-8333-944445555666";
const P = (qs) => new URLSearchParams(qs);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("splitJobFor", () => {
  test("?job=all is all jobs, whatever the landing job", () => {
    assert.equal(ALL_JOBS, "all");
    assert.equal(splitJobFor(P("job=all"), LANDING), null);
  });
  test("?job=<uuid> is that job", () => {
    assert.equal(splitJobFor(P(`job=${J1}`), LANDING), J1);
    assert.equal(
      splitJobFor(P(`job=${J1}&q=ana`), LANDING),
      J1,
      "an explicit job wins over the search rule",
    );
  });
  test("?q= with no ?job= is all jobs, so a search link never hides anyone", () => {
    assert.equal(splitJobFor(P("q=ana"), LANDING), null);
    assert.equal(splitJobFor(P("q=%20%20"), LANDING), LANDING, "a blank search is no search");
  });
  test("no ?job= is the server's landing job; a junk ?job= counts as none", () => {
    assert.equal(splitJobFor(P(""), LANDING), LANDING);
    assert.equal(splitJobFor(P("applicant=x&stage=applied"), LANDING), LANDING);
    assert.equal(splitJobFor(P("job=not-a-uuid"), LANDING), LANDING);
    assert.equal(splitJobFor(P(""), null), null, "no landing job (no jobs at all): all jobs");
  });
  test("splitJobIsExplicit: the server skips the landing read exactly when the URL decides", () => {
    assert.equal(splitJobIsExplicit(P("job=all")), true);
    assert.equal(splitJobIsExplicit(P(`job=${J1}`)), true);
    assert.equal(splitJobIsExplicit(P("q=ana")), true);
    assert.equal(splitJobIsExplicit(P("")), false);
    assert.equal(splitJobIsExplicit(P("job=junk&applicant=x")), false);
  });
});

describe("encodeListUrl", () => {
  const all = { request: { ...decodeListUrl(P("")).request, jobId: null }, topOnly: false };
  test("Split writes All jobs out as ?job=all, and it decodes back to all jobs", () => {
    const qs = encodeListUrl(all, "", { explicitAllJobs: true });
    assert.equal(qs, "job=all");
    assert.equal(splitJobFor(P(qs), LANDING), null);
  });
  test("the live page (flag off) is unchanged: All jobs is still no ?job=", () => {
    assert.equal(encodeListUrl(all, ""), "");
    assert.equal(encodeListUrl(all, "", {}), "");
  });
  test("a job id is written the same either way", () => {
    const one = { request: { ...all.request, jobId: J1 }, topOnly: false };
    assert.equal(encodeListUrl(one, "", { explicitAllJobs: true }), `job=${J1}`);
    assert.equal(encodeListUrl(one, ""), `job=${J1}`);
  });
  test("?job=all on the live page decodes to all jobs, as any non-uuid always did", () => {
    assert.equal(decodeListUrl(P("job=all")).request.jobId, null);
  });
});

describe("wiring", () => {
  const client = read("./_applicants-client.tsx");
  const page = read("./page.tsx");
  test("page.tsx: the landing read runs only under Split with no job in the URL, and flag off serves the URL as decoded", () => {
    assert.match(
      page,
      /splitOn && !splitJobIsExplicit\(params\)\s*\?\s*await resolveSplitLandingJob\(params\.get\("applicant"\)\)\s*:\s*null/,
    );
    assert.match(
      page,
      /const served = splitOn\s*\?\s*\{ \.\.\.decoded, request: \{ \.\.\.decoded\.request, jobId: splitJobFor\(params, landingJobId\) \} \}\s*:\s*decoded;/,
    );
    assert.match(page, /landingJobId=\{landingJobId\}/);
  });
  test("client: the request's job comes from splitJobFor under Split only", () => {
    assert.match(
      client,
      /return split\s*\?\s*\{ \.\.\.decoded, request: \{ \.\.\.decoded\.request, jobId: splitJobFor\(params, landingJobId\) \} \}\s*:\s*decoded;/,
    );
    assert.match(
      client,
      /encodeListUrl\(next, window\.location\.search, \{ explicitAllJobs: split \}\)/,
    );
  });
  test("client: every Split filter write spells the shown job out", () => {
    const at = client.indexOf("const setFilters = useCallback(");
    const body = client.slice(at, client.indexOf("[writeUrl, split, landingJobId]", at));
    assert.match(body, /jobId: splitJobFor\(liveParams, landingJobId\)/);
  });
  test("client: an in-app deep link to another job switches with a REPLACE, never in All jobs", () => {
    assert.match(
      client,
      /if \(shown !== null && shown !== linkedJob && live\.get\("applicant"\) === id\) \{\s*setFilters\(\{ jobId: linkedJob \}, "replace"\);/,
    );
  });
  test("client: the select is grouped Open / Closed under Split, flat otherwise; no 'filtered from' under Split", () => {
    assert.match(client, /const jobSelectOptions = split \?/);
    assert.match(client, /<optgroup label="Open">/);
    assert.match(client, /<optgroup label="Closed">/);
    assert.match(client, /grandTotal=\{split \? null : view\.grandTotal\}/);
  });
  test("the hero stays company-wide under Split while one job is shown; flag off it is the job's view as before", () => {
    assert.match(page, /splitOn && served\.request\.jobId \? fetchApplicantCounts\(\{\}\) : null,/);
    assert.match(page, /initialCompanyCounts=\{heroCounts\?\.ok \? heroCounts\.value : null\}/);
    assert.match(
      client,
      /const heroView = split && jobFilter !== "all" \? countsView\(companyCounts\) : view;/,
    );
    const hero = client.slice(client.indexOf("{ledeCount("), client.indexOf("</DashboardHero>"));
    assert.match(hero, /ledeCount\(heroView\.total\)/);
    assert.doesNotMatch(hero, /(?<![A-Za-z])view\./, "a hero figure still reads the job's counts");
  });
  test("the live top of the page (title, lede, hero) renders under Split too: nothing hides it", () => {
    const top = client.slice(
      client.indexOf("font-heading text-[32px] font-extrabold"),
      client.indexOf("</DashboardHero>"),
    );
    assert.match(top, />\s*Applicants\s*</);
    assert.match(top, /scored against the job/);
    assert.match(top, /<DashboardHero/);
    assert.doesNotMatch(top, /\bsplit\b/, "the title, lede or hero is gated on the Split flag");
  });
  test("company-wide counts: re-read after a mutation, and on a job switch only when missing or stale", () => {
    assert.match(
      client,
      /if \(split && jobFilter !== "all" && !companyFresh\.current\) readCompanyCounts\(\);/,
    );
    const refresh = client.slice(
      client.indexOf("const refreshCounts = useCallback("),
      client.indexOf("[split, readCounts, readCompanyCounts]"),
    );
    assert.match(refresh, /readCounts\(jobId\);\s*if \(!split\) return;/);
    assert.match(
      refresh,
      /if \(jobId === null\) companyFresh\.current = false;\s*else readCompanyCounts\(\);/,
    );
  });
  test("client: Split with no jobs shows only the title and the live empty message", () => {
    assert.match(client, /\{assignableJobs\.length === 0 \? noJobsPage : renderedPage\}/);
    const page0 = client.slice(
      client.indexOf("const noJobsPage = ("),
      client.indexOf("const noJobsPage = (") + 900,
    );
    assert.match(page0, /Applicants/);
    assert.match(page0, /\{emptyState\}/);
    assert.doesNotMatch(page0, /StageTabs|SplitLayout|SplitPanel|<select/);
  });
});
