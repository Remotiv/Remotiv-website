/**
 * #35 (QA R2 F8): Messages, Settings, Team, the dashboard sign-in and the
 * Jobs and Messages counters show hyphens, never a long or an en dash.
 *
 *   node --test src/app/ai-dashboard/dashboard-dashes.test.ts
 *
 * rendered-em-dashes.test.ts ratchets em dashes app-wide; it does not see en
 * dashes, which is where the pager ranges ("1–20 of N") and the "40–60 people"
 * example were left. This reads the same kind of nodes (string literals,
 * template text, JSX text and attributes) in the files those pages render, in
 * either spelling (the character, its escape, or the HTML entity), and allows
 * none outside console calls. Text from the database (a candidate's own words,
 * a job title) is not in these files and keeps whatever it has.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const ROOT = new URL("./", import.meta.url);
const DIRS = ["(gated)/messages/", "(gated)/settings/", "(gated)/team/", "(gated)/jobs/", "login/"];
const DASH = /[–—]|\\u201[34]|&mdash;|&ndash;|&#821[12];/;

/**
 * Out of #35's scope, named so it is not lost: the job wizard's salary preview
 * ("$ 50,000 - 80,000" today drawn with an en dash). A separate decision; this
 * test does not judge it.
 */
const OUT_OF_SCOPE = new Set(["(gated)/jobs/new/salary-range.ts"]);

function filesIn(dir) {
  const out = [];
  for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    const rel = `${dir}${e.name}${e.isDirectory() ? "/" : ""}`;
    if (e.isDirectory()) out.push(...filesIn(rel));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

const insideConsole = (node, sf) => {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) return true;
  }
  return false;
};

/** Every dash in user-visible literal text of one file: "file:line text". */
export function dashesIn(rel, text) {
  if (!DASH.test(text)) return [];
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];
  const kinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const visit = (n) => {
    if (kinds.has(n.kind) && DASH.test(n.getText(sf)) && !insideConsole(n, sf)) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      found.push(`${rel}:${line} ${n.getText(sf).trim().slice(0, 80)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const FILES = DIRS.flatMap(filesIn).filter((f) => !OUT_OF_SCOPE.has(f));

test("the walk reads the pages' files (vacuity floor)", () => {
  for (const must of [
    "(gated)/messages/_messages-client.tsx",
    "(gated)/settings/_settings-client.tsx",
    "(gated)/team/_team-client.tsx",
    "(gated)/jobs/_jobs-client.tsx",
    "login/login-client.tsx",
  ]) {
    assert.ok(FILES.includes(must), `${must} is not read`);
  }
});

test("no long or en dash in the visible text of Messages, Settings, Team, Jobs or the sign-in", () => {
  const found = FILES.flatMap((rel) => dashesIn(rel, readFileSync(new URL(rel, ROOT), "utf8")));
  assert.deepEqual(found, []);
});

test("the pagers read 1-20 of N with a hyphen", () => {
  const jobs = readFileSync(new URL("(gated)/jobs/_jobs-client.tsx", ROOT), "utf8");
  const messages = readFileSync(new URL("(gated)/messages/_messages-client.tsx", ROOT), "utf8");
  assert.match(
    jobs,
    /\{filtered\.length === 0 \? 0 : pageStart \+ 1\}-\{pageStart \+ paged\.length\}/,
  );
  assert.match(messages, /\{rangeStart\}-\{rangeEnd\}/);
});

test("the scanner sees every spelling, and ignores console calls and comments", () => {
  for (const [label, src, n] of [
    ["en dash in JSX", "const a = <b>{x}–{y}</b>;", 1],
    ["em dash in a string", 'const a = "one — two";', 1],
    ["escape", 'const a = "one \\u2014 two";', 1],
    ["entity", "const a = <p>one &ndash; two</p>;", 1],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal, on purpose
    ["template", "const a = `${x}–${y}`;", 1],
    ["console", 'console.warn("one — two");', 0],
    ["comment", "// one — two\nconst a = 1;", 0],
  ]) {
    assert.equal(dashesIn("x.tsx", src).length, n, label);
  }
});
