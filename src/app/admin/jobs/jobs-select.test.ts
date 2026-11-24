/**
 * The super admin jobs page, and the createJob and updateJob rows it gets
 * back, select an explicit column list, never `*` or a bare .select(), and
 * never live_hiring_challenges (migration 074: private to the company's live
 * interview). One list: actions.ts keeps its own copy (a "use server" file
 * exports only async functions), pinned identical here.
 *
 *   node --test src/app/admin/jobs/jobs-select.test.ts
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

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

const listOf = (text, where) => {
  const m = /const ADMIN_JOB_COLUMNS =\s*"([^"]+)";/.exec(text);
  assert.ok(m, `${where} has ADMIN_JOB_COLUMNS as a plain string`);
  return m[1].split(",").map((c) => c.trim());
};

/** Every .select(...) whose chain starts at .from("jobs"), with its argument's text ("" when bare). */
function jobsSelects(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      if (n.expression.name.text === "select") {
        let e = n.expression.expression;
        while (
          ts.isCallExpression(e) &&
          ts.isPropertyAccessExpression(e.expression) &&
          e.expression.name.text !== "from"
        ) {
          e = e.expression.expression;
        }
        const table = ts.isCallExpression(e) ? e.arguments[0] : null;
        if (table && ts.isStringLiteral(table) && table.text === "jobs") {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          out.push({ line, arg: n.arguments[0] ? n.arguments[0].getText(sf) : "" });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// Negative control: put a bare .select() back on updateJob and this fails.
test("no bare .select() or select(*) on jobs anywhere in admin/jobs; createJob and updateJob return the page's list", () => {
  const dir = new URL("./", import.meta.url);
  const sources = readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n) && !n.includes(".test."));
  assert.ok(sources.includes("page.tsx") && sources.includes("actions.ts"));
  const bad = [];
  for (const name of sources) {
    for (const s of jobsSelects(name, readFileSync(new URL(name, dir), "utf8"))) {
      if (
        s.arg === "" ||
        /^["'`]\s*\*/.test(s.arg) ||
        /(^|,)\s*\*\s*(,|$)/.test(s.arg.slice(1, -1))
      ) {
        bad.push(`${name}:${s.line} select(${s.arg})`);
      }
    }
  }
  assert.deepEqual(bad, []);

  const returned = jobsSelects("actions.ts", actions).filter((s) => s.arg === "ADMIN_JOB_COLUMNS");
  assert.equal(returned.length, 2, "createJob's insert and updateJob's update");
});

// Negative control: change one column in either copy and this fails.
test("the page's list and actions.ts' list are identical, and neither names a live_* column", () => {
  const pageList = listOf(page, "page.tsx");
  const actionsList = listOf(actions, "actions.ts");
  assert.deepEqual(actionsList, pageList);
  for (const c of pageList) assert.doesNotMatch(c, /^live_|\*/, c);
});
