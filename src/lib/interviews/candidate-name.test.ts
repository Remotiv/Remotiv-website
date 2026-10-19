/**
 * Removing the candidate's name from CV text (lib/interviews/candidate-name.ts).
 * Every name below is made up. Pure; nothing leaves the machine.
 *
 *   node --test src/lib/interviews/candidate-name.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";

const { CANDIDATE_TAG, mentionsCandidateName, removeCandidateName } = await import(
  "./candidate-name.ts"
);

const ALEX = { firstName: "Alex", lastName: "Example" };
const strip = (text, name = ALEX) => removeCandidateName(text, name).text;

test("the full name, the surname, any case, any spacing, after a title", () => {
  for (const [input, expected] of [
    ["Alex Example", CANDIDATE_TAG],
    ["ALEX EXAMPLE - Backend Engineer", `${CANDIDATE_TAG} - Backend Engineer`],
    ["alex   example", CANDIDATE_TAG],
    ["Mr. Alex Example", CANDIDATE_TAG],
    ["Dr Example led the team", `${CANDIDATE_TAG} led the team`],
    ["Engr. Alex Example", CANDIDATE_TAG],
    ["Example, Alex", CANDIDATE_TAG],
    ["EXAMPLE Alex", CANDIDATE_TAG],
    ["A. Example", CANDIDATE_TAG],
    ["A Example", CANDIDATE_TAG],
    ["Signed: Example", `Signed: ${CANDIDATE_TAG}`],
    ["References: ask Example.", `References: ask ${CANDIDATE_TAG}.`],
  ]) {
    assert.equal(strip(input), expected, input);
  }
});

test("middle names, initials, and a whole name held in the first-name field", () => {
  const name = { firstName: "Muhammad Ali", lastName: "Example" };
  assert.equal(strip("Muhammad Ali Example", name), CANDIDATE_TAG);
  assert.equal(strip("Muhammad Example", name), CANDIDATE_TAG);
  assert.equal(strip("M. A. Example", name), CANDIDATE_TAG);
  const whole = { firstName: "Sara Example", lastName: null };
  assert.equal(strip("Sara Example, Lahore", whole), `${CANDIDATE_TAG}, Lahore`);
  assert.equal(
    strip("Contact Example for references", whole),
    `Contact ${CANDIDATE_TAG} for references`,
  );
});

test("a multi-part surname goes whole, and its last part alone; a particle alone stays", () => {
  const name = { firstName: "Anna", lastName: "van der Berg" };
  assert.equal(strip("Anna van der Berg", name), CANDIDATE_TAG);
  assert.equal(strip("Ms van der Berg", name), CANDIDATE_TAG);
  assert.equal(strip("Berg built it", name), `${CANDIDATE_TAG} built it`);
  assert.equal(strip("the van was late", name), "the van was late");
});

test("letters outside A-Z, and no partial-word matches", () => {
  const name = { firstName: "Zoë", lastName: "Ægir" };
  assert.equal(strip("Zoë Ægir", name), CANDIDATE_TAG);
  assert.equal(strip("ZOË ÆGIR", name), CANDIDATE_TAG);
  // "Examples" and "Counterexample" are not the surname.
  assert.equal(strip("Examples of work; a counterexample."), "Examples of work; a counterexample.");
});

test("the first name on its own stays: it is sent separately, and is often a word", () => {
  assert.equal(strip("Alex led the migration."), "Alex led the migration.");
  const will = { firstName: "Will", lastName: "Example" };
  assert.equal(strip("I will deliver on time.", will), "I will deliver on time.");
});

test("counts what it removed; no name, no change", () => {
  assert.deepEqual(removeCandidateName("Alex Example, Example & co", ALEX), {
    text: `${CANDIDATE_TAG}, ${CANDIDATE_TAG} & co`,
    removed: 2,
  });
  for (const name of [
    { firstName: null, lastName: null },
    { firstName: "Alex", lastName: "" },
  ]) {
    assert.deepEqual(removeCandidateName("Alex Example", name), {
      text: "Alex Example",
      removed: 0,
    });
  }
  assert.deepEqual(removeCandidateName(null, ALEX), { text: "", removed: 0 });
});

test("mentionsCandidateName: the full name or the surname, never the first name alone", () => {
  assert.equal(mentionsCandidateName("Tell me about Example's project", ALEX), true);
  assert.equal(mentionsCandidateName("alex example, tell me", ALEX), true);
  assert.equal(mentionsCandidateName("Alex, tell me about a project", ALEX), false);
  assert.equal(mentionsCandidateName("Tell me about a project", ALEX), false);
  // Stateless across calls despite the global flag.
  for (let i = 0; i < 3; i++) assert.equal(mentionsCandidateName("Example", ALEX), true);
});
