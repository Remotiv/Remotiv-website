/**
 * Does a job save change what the CV scorer reads?
 *
 *   node --test src/app/ai-dashboard/lib/job-patch.test.ts
 *
 * The fixtures are shaped the way PostgREST returns jsonb - object keys in
 * Postgres's canonical order (shorter first, then bytewise) - because that is
 * the exact shape that used to read as a change. The "patch" side is built the
 * way the edit page and buildPatch build it for a save that touches nothing.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// job-patch.ts imports its neighbours the bundler's way (`@/…`, extensionless).
// See src/test-support/node-resolve.mjs.
register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
const { namedList, normaliseScoringInputs, sanitizeQuestions, scoringInputsChanged } = await import(
  "./job-patch.ts"
);

/** A question as jsonb hands it back: keys in canonical order, not source order. */
const jsonbQuestion = (over = {}) => ({
  id: "q-1",
  type: "numeric",
  ideal: "3",
  options: [],
  question: "How many years have you led a team?",
  essential: true,
  numeric_mode: "min",
  ...over,
});

/** A stored job row for a role with screening questions, jsonb-shaped. */
const storedWithQuestions = {
  title: "Senior Backend Engineer",
  description: "Build the platform.",
  responsibilities: "Own the API.",
  requirements: "Five years of TypeScript.",
  experience_level: "Expert",
  category: "Engineering",
  screening_questions: [
    jsonbQuestion(),
    jsonbQuestion({
      id: "q-2",
      type: "yesno",
      ideal: "Yes",
      question: "Can you start in a month?",
      numeric_mode: undefined,
    }),
    {
      id: "q-3",
      type: "multiple",
      ideal: "1",
      options: ["Junior", "Senior"],
      question: "Which band?",
      essential: false,
    },
  ],
  scoring_must_haves: ["TypeScript", "Postgres"],
  interview_criteria: ["Clarity"],
};

/**
 * What the edit page + buildPatch produce for a save that changes nothing:
 * strings trimmed and empties nulled, questions through sanitizeQuestions,
 * lists through namedList. This is the right-hand side updateCompanyJob sees.
 */
function noOpPatch(stored) {
  return {
    title: (stored.title ?? "").trim(),
    description: (stored.description ?? "").trim() || null,
    responsibilities: (stored.responsibilities ?? "").trim() || null,
    requirements: (stored.requirements ?? "").trim() || null,
    experience_level: stored.experience_level,
    category: stored.category,
    screening_questions: sanitizeQuestions(stored.screening_questions),
    scoring_must_haves: namedList(stored.scoring_must_haves, 3),
    interview_criteria: namedList(stored.interview_criteria, 3),
  };
}

test("1. jsonb key order: a save that changes nothing is not a criteria change", () => {
  const patch = noOpPatch(storedWithQuestions);
  // The old comparison saw a change here - same values, different key order.
  assert.notEqual(
    JSON.stringify(storedWithQuestions.screening_questions[0]),
    JSON.stringify(patch.screening_questions[0]),
    "precondition: the two shapes still differ byte-for-byte",
  );
  assert.equal(scoringInputsChanged(storedWithQuestions, patch), false);
});

test('2. legacy numeric shape (ideal "0", no numeric_mode) rewritten as "" / none is not a change', () => {
  const legacy = {
    ...storedWithQuestions,
    screening_questions: [
      {
        id: "q-1",
        type: "numeric",
        ideal: "0",
        options: [],
        question: "Years leading?",
        essential: true,
      },
    ],
  };
  const patch = noOpPatch(legacy);
  assert.deepEqual(
    { ideal: patch.screening_questions[0].ideal, mode: patch.screening_questions[0].numeric_mode },
    { ideal: "", mode: "none" },
    "precondition: sanitizeQuestions really does rewrite the legacy shape",
  );
  assert.equal(scoringInputsChanged(legacy, patch), false);
});

test("3. real criteria changes still bump", () => {
  const base = noOpPatch(storedWithQuestions);
  const cases = {
    "question text": {
      ...base,
      screening_questions: base.screening_questions.map((q, i) =>
        i === 0 ? { ...q, question: "How many years have you managed people?" } : q,
      ),
    },
    "numeric threshold": {
      ...base,
      screening_questions: base.screening_questions.map((q, i) =>
        i === 0 ? { ...q, ideal: "5" } : q,
      ),
    },
    "min → max direction": {
      ...base,
      screening_questions: base.screening_questions.map((q, i) =>
        i === 0 ? { ...q, numeric_mode: "max" } : q,
      ),
    },
    "question removed": { ...base, screening_questions: base.screening_questions.slice(1) },
    "must-have added": { ...base, scoring_must_haves: [...base.scoring_must_haves, "Kafka"] },
    "criterion reworded": { ...base, interview_criteria: ["Concision"] },
    title: { ...base, title: "Head of Engineering" },
    requirements: { ...base, requirements: "Eight years of TypeScript." },
    "experience level": { ...base, experience_level: "Intermediate" },
    category: { ...base, category: "Data" },
  };
  for (const [name, patch] of Object.entries(cases)) {
    assert.equal(scoringInputsChanged(storedWithQuestions, patch), true, name);
  }
});

test("4. control: a job with no screening questions - no bump on a no-op, bump on a real edit", () => {
  const stored = {
    ...storedWithQuestions,
    screening_questions: [],
    scoring_must_haves: ["Closing"],
    interview_criteria: [],
  };
  assert.equal(scoringInputsChanged(stored, noOpPatch(stored)), false);
  assert.equal(
    scoringInputsChanged(stored, { ...noOpPatch(stored), description: "Sell the platform." }),
    true,
  );
  // And with the list columns still null on a row that predates them.
  const older = { ...stored, scoring_must_haves: null, interview_criteria: null };
  assert.equal(scoringInputsChanged(older, noOpPatch(older)), false);
});

test("what is deliberately NOT a change: id, whitespace, empty-vs-null, list noise, enum repair", () => {
  const stored = storedWithQuestions;
  const patch = noOpPatch(stored);
  assert.equal(
    scoringInputsChanged(stored, {
      ...patch,
      screening_questions: patch.screening_questions.map((q) => ({ ...q, id: `new-${q.id}` })),
    }),
    false,
    "a regenerated id is a handle, not a criterion",
  );
  assert.equal(
    scoringInputsChanged(
      { ...stored, description: "  Build the platform.\n", responsibilities: "" },
      { ...patch, responsibilities: null },
    ),
    false,
    "trim and empty-vs-null",
  );
  assert.equal(
    scoringInputsChanged(
      { ...stored, scoring_must_haves: ["TypeScript ", " Postgres", "typescript"] },
      patch,
    ),
    false,
    "whitespace and case-insensitive duplicates in a must-have list",
  );
  assert.equal(
    scoringInputsChanged({ ...stored, category: "Software Engineering" }, patch),
    false,
    "an enum outside the list compares equal to the fallback it is coerced to",
  );
  assert.equal(
    normaliseScoringInputs({ ...stored, category: "Software Engineering" }).category,
    "Engineering",
  );
});
