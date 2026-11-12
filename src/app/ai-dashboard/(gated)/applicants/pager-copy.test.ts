/**
 * Hyphens only in the Applicants pager.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/pager-copy.test.ts"
 *
 * The pager showed "1 en-dash 2 of 2", with an en dash typed into the JSX. The
 * async-copy-dashes test reads only a marked block of _applicants-client.tsx,
 * and the pager sits outside it, so nothing caught it. This reads every string
 * literal, template part and JSX text inside the Pagination component through
 * the TypeScript AST, the same method as that test (comments are not in the
 * AST), and fails on any em or en dash.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

/** Built from code points so this file holds no dash glyph for a formatter to rewrite. */
const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const DASH = new RegExp(`[${EN}${EM}]`);
const SRC = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

/** The Pagination declaration, found by name so a rename fails loudly. */
function pagination(): { sf: ts.SourceFile; fn: ts.FunctionDeclaration } {
  const sf = ts.createSourceFile(
    "client.tsx",
    SRC,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === "Pagination",
  );
  assert.ok(fn, "Pagination not found in _applicants-client.tsx - re-point this pin");
  return { sf, fn };
}

function copyIn(sf: ts.SourceFile, root: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      out.push(n.text);
    else if (ts.isJsxText(n)) out.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

test("no em or en dash in any string or JSX text the pager renders", () => {
  const { sf, fn } = pagination();
  const copy = copyIn(sf, fn);
  assert.ok(
    copy.some((s) => /\bof\b/.test(s)),
    "the scan did not reach the pager's text",
  );
  const dashed = copy.filter((s) => DASH.test(s)).map((s) => JSON.stringify(s.trim()));
  assert.deepEqual(dashed, []);
});

test("the range reads start-hyphen-end, as in 1-2 of 2", () => {
  const { sf, fn } = pagination();
  assert.match(fn.getText(sf), /\{rangeStart\}-\{rangeEnd\}/);
});

test("control: the scan catches a dash in JSX text and ignores comments", () => {
  const sf = ts.createSourceFile(
    "c.tsx",
    `function Pagination() { /* a ${EM} comment */ return <b>{a}${EN}{b} of {c}</b>; }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const dashed = copyIn(sf, fn).filter((s) => DASH.test(s));
  assert.equal(dashed.length, 1, dashed.join(" | "));
});
