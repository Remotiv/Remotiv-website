/**
 * Applicants Split, commit 3: the page-only text tokens are behind the flag.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-tokens.test.ts"
 *
 * Source pins, like stage-tabs.test.ts's: the client is a 6,500-line module
 * that pulls in server actions, so rendering it here would mean stubbing most
 * of the app. What is pinned: the page passes the flag; the client adds the
 * token wrapper only when it is on and returns the page untouched otherwise;
 * the CSS redefines exactly the two tokens, only under that class.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const page = read("./page.tsx");
const client = read("./_applicants-client.tsx");
const css = read("../../ai-dashboard.css");

test("the page hands the client the company's Split flag", () => {
  assert.match(
    page,
    /import \{ isApplicantsSplitOn \} from "@\/app\/ai-dashboard\/lib\/applicants-split-flag";/,
  );
  // Computed once, before the reads, because commit 8 needs it to pick the
  // landing job (getCompanyContext is cache()d per request).
  assert.match(
    page,
    /const splitOn = isApplicantsSplitOn\(\(await getCompanyContext\(\)\)\.companyId\);/,
  );
  assert.match(page, /split=\{splitOn\}/);
});

test("the client wraps the page in the token class only when split is on", () => {
  assert.match(client, /split = false,/, "split defaults to off");
  // The 0-jobs page (commit 8) goes through the same wrapper.
  assert.match(
    client,
    /return split \? \(\s*<div className="ai-split-tokens">\s*\{assignableJobs\.length === 0 \? noJobsPage : renderedPage\}\s*<\/div>\s*\) : \(\s*renderedPage\s*\);/,
  );
  assert.equal((client.match(/ai-split-tokens/g) ?? []).length, 1, "the class is used once");
});

test("the CSS redefines exactly --ai-t3 and --ai-t4, scoped under .ai-split-tokens", () => {
  const block = css.match(/\.ai-shell \.ai-split-tokens \{([^}]*)\}/);
  assert.ok(block, "no .ai-shell .ai-split-tokens rule");
  const decls = block[1]
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  assert.deepEqual(decls, ["--ai-t3: #625c6a", "--ai-t4: #6e6876"]);
  // The shell values stay as they were for every other page.
  assert.match(css, /--ai-t3: #847e8c;/);
  assert.match(css, /--ai-t4: #b0aab8;/);
});
