/**
 * The super admin jobs page selects an explicit column list, never `*`, and
 * never live_hiring_challenges (migration 074: private to the company's live
 * interview).
 *
 *   node --test src/app/admin/jobs/jobs-select.test.ts
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

// Negative control: put `.select("*")` back on the jobs query and this fails.
test("the admin jobs page selects an explicit list of jobs columns, without live_hiring_challenges", () => {
  const query = /\.from\("jobs"\)\s*\.select\(([^)]*)\)/.exec(page);
  assert.ok(query, "the page reads jobs");
  assert.equal(query[1].trim(), "ADMIN_JOB_COLUMNS", "through the named list");
  assert.doesNotMatch(page, /\.select\(\s*["'`]\s*\*/, "no select(*) anywhere on the page");

  const list = /const ADMIN_JOB_COLUMNS =\s*"([^"]+)";/.exec(page);
  assert.ok(list, "a plain string, readable at a glance");
  const columns = list[1].split(",").map((c) => c.trim());
  assert.ok(!columns.includes("*"));
  assert.ok(!columns.includes("live_hiring_challenges"));
  assert.doesNotMatch(list[1], /live_/, "none of 074's live interview columns");

  // Every column is one the Job type declares: nothing selected the page cannot name.
  const type = actions.slice(actions.indexOf("export type Job = {"));
  const declared = new Set(
    [...type.slice(0, type.indexOf("};")).matchAll(/^\s+(\w+):/gm)].map((m) => m[1]),
  );
  for (const c of columns) assert.ok(declared.has(c), `${c} is on the Job type`);
  assert.equal(new Set(columns).size, columns.length, "no duplicates");
});
