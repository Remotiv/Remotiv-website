/**
 * The one-time "stay on this screen" warning on the setup screen.
 *
 * Leaving the tab or app while recording ends the answer (kept on purpose).
 * The candidate is told once, before the practice round, on "Check your
 * setup" - not under every question, where it would become noise.
 *
 * _flow.tsx renders browser-only React and its screens are not exported, so
 * this reads the source with the TypeScript AST: the sentence is JSX text in
 * TechCheck's returned tree with no condition between it and the return, so
 * every pass through the setup screen shows it, and no other screen has it.
 *
 *   node --test "src/**\/setup-recording-warning.test.ts"   ([token] in a path is read as a glob)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const SENTENCE =
  "Stay on this screen while you record. Switching tabs or apps stops the recording.";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

type Hit = { fn: string | null; conditional: boolean };

function findSentence(src: string, name: string): Hit[] {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const visit = (n: ts.Node) => {
    const text =
      ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
        ? (ts.isJsxText(n) ? n.getText(sf) : n.text).replace(/\s+/g, " ").trim()
        : null;
    if (text?.includes(SENTENCE)) {
      let fn: string | null = null;
      let conditional = false;
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isConditionalExpression(p)) conditional = true;
        if (
          ts.isBinaryExpression(p) &&
          (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        )
          conditional = true;
        if (ts.isIfStatement(p)) conditional = true;
        if (ts.isFunctionDeclaration(p)) {
          fn = p.name?.text ?? null;
          break;
        }
      }
      hits.push({ fn, conditional });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

test("the setup screen shows the warning once, unconditionally", () => {
  const flow = read("./_flow.tsx");
  const hits = findSentence(flow, "_flow.tsx");
  assert.deepEqual(hits, [{ fn: "TechCheck", conditional: false }]);
  // TechCheck is the "Check your setup" screen.
  const start = flow.indexOf("function TechCheck(");
  const end = flow.indexOf("\nfunction ", start + 1);
  assert.ok(start !== -1 && end > start, "TechCheck not found, re-point this pin");
  assert.ok(flow.slice(start, end).includes("Check your setup"));
});

test("no question screen (or any other candidate screen) repeats it", () => {
  for (const rel of [
    "./_permissions.ts",
    "./_terminal.tsx",
    "./_consent-gate.ts",
    "./page.tsx",
    "./error.tsx",
  ]) {
    assert.deepEqual(findSentence(read(rel), rel), [], rel);
  }
  const flow = read("./_flow.tsx");
  assert.equal(flow.split(SENTENCE).length - 1, 1, "the sentence appears once in _flow.tsx");
});

test("the after-the-fact notice is unchanged", () => {
  assert.ok(read("./_flow.tsx").includes('"Recording stopped when you left this screen."'));
});

test("control: a conditional placement and another screen are both caught", () => {
  const src = `function TechCheck() { return <div>{ok && <p>${SENTENCE}</p>}</div>; }
function Recorder() { return <p>${SENTENCE}</p>; }`;
  assert.deepEqual(findSentence(src, "control.tsx"), [
    { fn: "TechCheck", conditional: true },
    { fn: "Recorder", conditional: false },
  ]);
});
