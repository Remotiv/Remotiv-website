/**
 * #71: the fairness rules are in every AI prompt that scores or ranks a
 * person, from ONE source (fairness.ts), and no prompt penalises an employment
 * gap.
 *
 *   node --test src/lib/ai/fairness.test.ts
 *
 * The prompts are read from their source with the TypeScript parser (the
 * scorer modules pull in "server-only" and the provider SDKs, which bare Node
 * cannot load). Each prompt is rebuilt as the model receives it: string and
 * template text, with ${...} resolved for the two shared rules and for
 * same-file string constants (BAND_DEFINITIONS, SCORE_BANDS). The shared text
 * itself is imported from fairness.ts, so a test that compares against it
 * compares against the one source.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { EMPLOYMENT_GAP_NOT_LISTED, EMPLOYMENT_GAP_RULE, FAIRNESS_RULES } from "./fairness.ts";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const SHARED = { FAIRNESS_RULES, EMPLOYMENT_GAP_RULE, EMPLOYMENT_GAP_NOT_LISTED };

/** Every AI prompt that scores or ranks a person: file, and the const holding it. */
const SCORING_PROMPTS = [
  { file: "lib/ai/cv-scoring.ts", name: "SYSTEM_PROMPT", what: "CV score" },
  {
    file: "lib/ai/interview-scoring.ts",
    name: "SYSTEM_PROMPT",
    what: "async interview answer score",
  },
  {
    file: "lib/ai/interview-scoring.ts",
    name: "SESSION_SYSTEM_PROMPT",
    what: "interview summary for the hiring team",
  },
  { file: "lib/ai-matching.ts", name: "systemPrompt", what: "AI talent matching rank" },
  {
    file: "lib/ai/live-interview-scoring.ts",
    name: "LIVE_SYSTEM_PROMPT",
    what: "live interview question score",
  },
];

function constsOf(sf) {
  const out = new Map();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      out.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A prompt's text as sent, and the identifiers interpolated into it. */
function promptOf(file, name) {
  const text = readFileSync(join(SRC, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const consts = constsOf(sf);
  const used = [];
  const flatten = (n) => {
    if (!n) return "";
    if (ts.isParenthesizedExpression(n)) return flatten(n.expression);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return flatten(n.left) + flatten(n.right);
    }
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text;
      for (const span of n.templateSpans) {
        const e = span.expression;
        if (ts.isIdentifier(e)) {
          used.push(e.text);
          if (e.text in SHARED) out += SHARED[e.text];
          else if (consts.has(e.text)) out += flatten(consts.get(e.text));
        }
        out += span.literal.text;
      }
      return out;
    }
    return "";
  };
  const node = consts.get(name);
  assert.ok(node, `${file}: ${name} found`);
  return { text: flatten(node), used, source: text };
}

const importsShared = (source, names) =>
  names.every((n) =>
    new RegExp(`import \\{[^}]*\\b${n}\\b[^}]*\\} from "(\\./fairness|@/lib/ai/fairness)";`).test(
      source,
    ),
  );

// Negative control: drop ${FAIRNESS_RULES} from any one of these prompts and
// this test fails, naming it.
test("every prompt that scores or ranks a person carries the shared fairness rules, interpolated from fairness.ts", () => {
  for (const p of SCORING_PROMPTS) {
    const { text, used, source } = promptOf(p.file, p.name);
    assert.ok(
      used.includes("FAIRNESS_RULES"),
      `${p.what} (${p.file} ${p.name}) interpolates FAIRNESS_RULES`,
    );
    assert.ok(text.includes(FAIRNESS_RULES), `${p.what}: the rules reach the model whole`);
    assert.ok(importsShared(source, ["FAIRNESS_RULES"]), `${p.file} imports FAIRNESS_RULES`);
  }
});

test("all five scoring prompts are covered, the live interview scorer's included", () => {
  assert.deepEqual(
    SCORING_PROMPTS.map((p) => p.what),
    [
      "CV score",
      "async interview answer score",
      "interview summary for the hiring team",
      "AI talent matching rank",
      "live interview question score",
    ],
  );
});

test("the rules say what Waleed decided: job-related evidence only, and the full list never used or inferred", () => {
  assert.match(
    FAIRNESS_RULES,
    /Score only on job-related evidence: skills, experience, qualifications, achievements, and the content of what the candidate said or wrote\./,
  );
  for (const item of [
    "accent",
    "pronunciation",
    "grammar or fluency (unless the job's stated requirements, as given to you, name a language skill)",
    "appearance",
    "voice",
    "background or setting",
    "age",
    "gender",
    "race",
    "ethnicity",
    "nationality",
    "religion",
    "disability",
    "health",
    "family or marital status",
    "pregnancy",
    "name",
    "photo",
  ]) {
    assert.ok(FAIRNESS_RULES.includes(item), `the list names ${item}`);
  }
  assert.match(
    FAIRNESS_RULES,
    /Where another rule in these instructions is stricter than this one, the stricter rule applies\./,
  );
  // The en and em dash, by code point (a literal one would be the thing banned).
  const longDashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  assert.doesNotMatch(FAIRNESS_RULES + EMPLOYMENT_GAP_RULE, longDashes, "no long dashes");
});

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") sourceFiles(p, out);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

test("the rules are imported, never copied: no other source file holds their sentences", () => {
  const sentences = [
    "Score only on job-related evidence",
    "never treat any of them as evidence",
    "Employment gaps must never reduce a candidate's score",
    "must not speculate about its cause",
    "Never list an employment gap",
  ];
  const copies = [];
  for (const p of sourceFiles(SRC)) {
    const rel = relative(SRC, p);
    if (rel === "lib/ai/fairness.ts") continue;
    const text = readFileSync(p, "utf8");
    for (const s of sentences) if (text.includes(s)) copies.push(`${rel}: "${s}"`);
  }
  assert.deepEqual(copies, []);
});

/* ── employment gaps ─────────────────────────────────────────── */

/** Wording that treats a gap in someone's working life as a signal. */
const EMPLOYMENT_GAP = [
  /\b(employment|career|work|working|cv|resume|job) gaps?\b/i,
  /\bgaps? (in|between) (employment|work|jobs|roles|positions|their career)\b/i,
  /\bmulti-year gap\b/i,
  /\bunexplained\b[^.]*\bgap\b/i,
  /\bcareer break\b/i,
  /\btime (off|out) (from|of) work\b/i,
];

// Negative control: put "an unexplained multi-year gap" back into the CV
// prompt's concerns, or any sentence that marks a gap down, and this fails.
test("no scoring prompt penalises an employment gap; the CV prompt carries the approved rule verbatim", () => {
  const cv = promptOf("lib/ai/cv-scoring.ts", "SYSTEM_PROMPT");
  assert.ok(
    cv.used.includes("EMPLOYMENT_GAP_RULE"),
    "the CV prompt interpolates EMPLOYMENT_GAP_RULE",
  );
  assert.ok(importsShared(cv.source, ["EMPLOYMENT_GAP_RULE"]));
  assert.equal(
    EMPLOYMENT_GAP_RULE,
    "Employment gaps must never reduce a candidate's score. The AI may mention a gap as a neutral observation but must not speculate about its cause or treat it as evidence of lower competence.",
  );
  // The approved block: its heading, the rule and where a gap may never be
  // listed. Nothing else in any prompt may speak about employment gaps.
  const approved = `EMPLOYMENT GAPS. ${EMPLOYMENT_GAP_RULE} ${EMPLOYMENT_GAP_NOT_LISTED}`;
  assert.ok(cv.text.includes(approved));

  for (const p of SCORING_PROMPTS) {
    // Everything but the approved block, sentence by sentence.
    const text = promptOf(p.file, p.name).text.split(approved).join(" ");
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      for (const re of EMPLOYMENT_GAP) {
        assert.doesNotMatch(sentence, re, `${p.what}: "${sentence.trim().slice(0, 140)}"`);
      }
      // A gap and a penalty in one sentence, unless the sentence denies the
      // penalty ("not a second penalty for the same gap").
      const penalises =
        /\bgaps?\b/i.test(sentence) &&
        /\b(penal\w*|deduct\w*|mark(ed)? down|lower(s|ed)? the score|reduce[sd]? the score)\b/i.test(
          sentence,
        ) &&
        !/\b(not|never|no|does not|do not|must not)\b/i.test(sentence);
      if (penalises) {
        assert.fail(
          `${p.what}: a gap and a penalty in one sentence: "${sentence.trim().slice(0, 140)}"`,
        );
      }
    }
  }
});

test("the prompt versions moved with the text, in the same scoring generation; nothing re-scores on a version", async () => {
  const cv = readFileSync(join(SRC, "lib/ai/cv-scoring.ts"), "utf8");
  const interview = readFileSync(join(SRC, "lib/ai/interview-scoring.ts"), "utf8");
  assert.match(cv, /export const PROMPT_VERSION = "cv-scoring-v14";/);
  assert.match(interview, /export const PROMPT_VERSION = "interview-scoring-v10";/);
  const live = readFileSync(join(SRC, "lib/ai/live-interview-scoring.ts"), "utf8");
  assert.match(live, /export const LIVE_SCORING_PROMPT_VERSION = "live-interview-scoring-v3";/);
  const { CV_SCORING_GENERATIONS, INTERVIEW_SCORING_GENERATIONS, scoringGeneration } = await import(
    "./scoring-generations.ts"
  );
  assert.equal(
    scoringGeneration(CV_SCORING_GENERATIONS, "cv-scoring-v14"),
    scoringGeneration(CV_SCORING_GENERATIONS, "cv-scoring-v13"),
  );
  assert.equal(
    scoringGeneration(INTERVIEW_SCORING_GENERATIONS, "interview-scoring-v10"),
    scoringGeneration(INTERVIEW_SCORING_GENERATIONS, "interview-scoring-v9"),
  );
  // No code compares a stored prompt_version to the current one: a version
  // is a label on new rows, never a trigger to re-score old ones.
  const compares = [];
  for (const p of sourceFiles(SRC)) {
    const text = readFileSync(p, "utf8");
    // (A check that a version is present, `!= null`, decides nothing.)
    if (
      /prompt_?[vV]ersion\s*(!==|===|!=|==)(?!\s*(null|undefined)\b)|(!==|===)\s*\w*PROMPT_VERSION|\.neq\("prompt_version"|\.eq\("prompt_version"/.test(
        text,
      )
    ) {
      compares.push(relative(SRC, p));
    }
  }
  assert.deepEqual(compares, []);
});

// Negative control: drop ${EMPLOYMENT_GAP_NOT_LISTED} from the CV prompt's
// EMPLOYMENT GAPS block and this test fails.
test("a gap is never listed under concerns ('Risks / points to verify') or missing requirements", () => {
  const cv = promptOf("lib/ai/cv-scoring.ts", "SYSTEM_PROMPT");
  assert.ok(cv.used.includes("EMPLOYMENT_GAP_NOT_LISTED"), "interpolated from fairness.ts");
  assert.ok(importsShared(cv.source, ["EMPLOYMENT_GAP_NOT_LISTED"]));
  assert.match(
    EMPLOYMENT_GAP_NOT_LISTED,
    /^Never list an employment gap in concerns or in missing_requirements/,
  );
  // Named by the schema's own field names, the ones the model fills in.
  for (const field of ["concerns", "missing_requirements"]) {
    assert.ok(EMPLOYMENT_GAP_NOT_LISTED.includes(field));
    assert.ok(cv.text.includes(`"${field}"`), `the prompt's schema has ${field}`);
  }
  assert.ok(cv.text.includes(`${EMPLOYMENT_GAP_RULE} ${EMPLOYMENT_GAP_NOT_LISTED}`));
});
