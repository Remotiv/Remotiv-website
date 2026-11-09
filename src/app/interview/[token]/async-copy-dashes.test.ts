/**
 * Hyphens only in the async interview's user-facing copy.
 *
 * Reads every string literal, template part and JSX text in the async
 * interview surfaces (candidate screens, invite and reminder emails, the
 * recruiter's interview panel, interviews list and review page, the
 * add-candidate form and the job wizard's interview step) and fails on any
 * em or en dash. Comments are not in the AST, and console.* / Error messages
 * are skipped because nobody reads them on screen.
 *
 * Three files are only partly async. For those the scan is limited to the
 * async block, found by source markers that are asserted to exist, so a
 * renamed marker fails loudly instead of silently scanning nothing. Live and
 * booking copy (the rest of the interview panel, _live/**) is not this
 * test's business.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const DASH = /[–—]/;

type Found = { text: string; line: number };

function copyIn(src: string, name: string, from = 0, to = src.length): Found[] {
  const sf = ts.createSourceFile(
    name,
    src,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const notShown = (n: ts.Node): boolean => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) return true;
      if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText(sf))) return true;
      if (ts.isImportDeclaration(p)) return true;
    }
    return false;
  };
  const out: Found[] = [];
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) text = n.text;
    else if (ts.isJsxText(n)) text = n.getText(sf);
    const start = n.getStart(sf);
    if (text !== null && start >= from && start < to && !notShown(n)) {
      out.push({ text, line: sf.getLineAndCharacterOfPosition(start).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const WHOLE_FILES = [
  "./_flow.tsx",
  "./_permissions.ts",
  "./_terminal.tsx",
  "./_consent-gate.ts",
  "./_tab-lock.ts",
  "./error.tsx",
  "./page.tsx",
  "../../ai-dashboard/(gated)/applicants/interview-actions.ts",
  "../../ai-dashboard/(gated)/interviews/_interviews-client.tsx",
  "../../ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx",
  "../../../lib/email/candidate/interview-reminder.ts",
];

/** [file, start marker, end marker]: only the copy between them is async. */
const SECTIONS: Array<[string, string, string]> = [
  [
    "../../ai-dashboard/(gated)/applicants/_interview-panel.tsx",
    "const STATE: Record<",
    "export function liveRestartText(",
  ],
  [
    "../../ai-dashboard/(gated)/jobs/new/_wizard-client.tsx",
    "{step === 5 && (",
    "<TeamCallFields state={state} set={set} />",
  ],
  [
    "../../ai-dashboard/(gated)/applicants/_applicants-client.tsx",
    "{addOpen && (",
    "{deleteTarget && (",
  ],
];

function dashed(found: Found[], rel: string): string[] {
  return found
    .filter((f) => DASH.test(f.text))
    .map((f) => `${rel}:${f.line} ${f.text.replace(/\s+/g, " ").trim().slice(0, 90)}`);
}

test("hyphens only: no em or en dash in any async interview string a person can see", () => {
  const bad: string[] = [];
  let checked = 0;
  for (const rel of WHOLE_FILES) {
    const found = copyIn(read(rel), rel);
    checked += found.length;
    bad.push(...dashed(found, rel));
  }
  for (const [rel, startMarker, endMarker] of SECTIONS) {
    const src = read(rel);
    const from = src.indexOf(startMarker);
    const to = src.indexOf(endMarker, from);
    assert.ok(from !== -1 && to > from, `${rel}: markers not found, re-point this section`);
    const found = copyIn(src, rel, from, to);
    assert.ok(found.length > 10, `${rel}: only ${found.length} strings in the section`);
    checked += found.length;
    bad.push(...dashed(found, rel));
  }
  assert.deepEqual(bad, []);
  assert.ok(checked > 1000, `read ${checked} strings`);
});

test("the scan reads the strings it claims to: known async copy is found, with hyphens", () => {
  const all = [
    ...WHOLE_FILES.flatMap((rel) => copyIn(read(rel), rel)),
    ...SECTIONS.flatMap(([rel, a, b]) => {
      const src = read(rel);
      const from = src.indexOf(a);
      return copyIn(src, rel, from, src.indexOf(b, from));
    }),
  ].map((f) => f.text.replace(/\s+/g, " "));
  for (const phrase of [
    "Please read these - they matter.",
    "That&apos;s everything - thank you",
    "Sent - not started",
    "Couldn't send - please try again.",
    "There's no call to schedule - you record the answers",
    "Add interview questions to this job first - there's nothing to ask yet.",
    "Note saved - your team can see it",
    "If you've already started, nothing is lost - every answer",
    "Required - the candidate can&apos;t submit without it",
    "phone, location, history - is read from it.",
  ]) {
    assert.ok(
      all.some((s) => s.includes(phrase)),
      `not found in the scanned copy: ${phrase}`,
    );
  }
});

test("control: the check catches a dash in copy and ignores comments and log lines", () => {
  const src = [
    "// a comment — ignored",
    'console.log("log — ignored");',
    'throw new Error("error — ignored");',
    'const a = "shown — caught";',
    "const b = <p>jsx – caught</p>;",
  ].join("\n");
  const hits = dashed(copyIn(src, "control.tsx"), "control.tsx");
  assert.equal(hits.length, 2, hits.join("\n"));
});
