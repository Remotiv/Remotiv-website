/**
 * Removing the candidate's name from CV text (lib/interviews/candidate-name.ts).
 * Every name below is made up. Pure; nothing leaves the machine.
 *
 *   node --test src/lib/interviews/candidate-name.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// candidate-name.ts imports ordinary-words through the "@/" alias.
register(new URL("../../test-support/node-resolve.mjs", import.meta.url));

const { CANDIDATE_TAG, mentionsCandidateName, removeCandidateName, removeCandidateNameFromSpeech } =
  await import("./candidate-name.ts");

const ALEX = { firstName: "Alex", lastName: "Example" };
const strip = (text, name = ALEX) => removeCandidateName(text, name).text;
const speech = (text, name = ALEX) => removeCandidateNameFromSpeech(text, name).text;

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

/* ── spelling it the way it was typed (#25) ───────────────────── */

test("one Unicode form, accents kept with their letter, any apostrophe, and names written without spaces", () => {
  // Typed decomposed, read composed (and the other way round).
  const jose = { firstName: "Jose\u0301", lastName: "Garci\u0301a" };
  assert.equal(strip("José García led it", jose), `${CANDIDATE_TAG} led it`);
  assert.equal(
    strip("Jose\u0301 Garci\u0301a", { firstName: "José", lastName: "García" }),
    CANDIDATE_TAG,
  );
  // The last letter carries an accent with no code point of its own: none is left behind.
  const ade = { firstName: "Olusegun", lastName: "Adébáyọ\u0300" };
  assert.equal(strip("Olusegun Adébáyọ\u0300 built it", ade), `${CANDIDATE_TAG} built it`);
  assert.equal(strip("Adébáyọ\u0300.", ade), `${CANDIDATE_TAG}.`);
  const sean = { firstName: "Seán", lastName: "O'Brien" };
  for (const typed of ["O'Brien", "O\u2019Brien", "O\u2018Brien", "O`Brien"]) {
    assert.equal(strip(`Seán ${typed}`, sean), CANDIDATE_TAG, typed);
    assert.equal(strip(`ask ${typed}.`, sean), `ask ${CANDIDATE_TAG}.`, typed);
  }
  // Surname first, with or without a space, inside a sentence.
  const li = { firstName: "秀英", lastName: "李" };
  for (const said of ["李秀英", "李 秀英", "秀英 李", "秀英李"]) {
    assert.equal(strip(`我叫${said}。`, li), `我叫${CANDIDATE_TAG}。`, said);
  }
  assert.equal(
    strip("저는 김민수입니다", { firstName: "민수", lastName: "김" }),
    `저는 ${CANDIDATE_TAG}입니다`,
  );
  assert.equal(mentionsCandidateName("My name is 李秀英", li), true);
});

test("a full stop and a new sentence never join two parts of a name", () => {
  const name = { firstName: "Will", lastName: "Example" };
  assert.equal(strip("I will. Example given.", name), `I will. ${CANDIDATE_TAG} given.`);
  assert.equal(
    strip("Will.Example and Will-Example", name),
    `${CANDIDATE_TAG} and ${CANDIDATE_TAG}`,
  );
});

test("not covered: a name spelt differently from how it was typed stays", () => {
  assert.equal(strip("Aleks Exampel"), "Aleks Exampel");
  assert.equal(speech("My name is Aleks Exampel."), "My name is Aleks Exampel.");
});

/* ── speech (#25): the live scorer's exchange ─────────────────── */

test("speech: the first name goes too, in any case, and a first name of several words is ONE tag", () => {
  assert.equal(
    speech("Hi Alex, alex, ALEX. Alex's team. Ask Example or example."),
    `Hi ${CANDIDATE_TAG}, ${CANDIDATE_TAG}, ${CANDIDATE_TAG}. ${CANDIDATE_TAG}'s team. Ask ${CANDIDATE_TAG} or ${CANDIDATE_TAG}.`,
  );
  assert.equal(speech("alexander and counterexample"), "alexander and counterexample");
  const ali = { firstName: "Muhammad Ali", lastName: "Raza" };
  assert.equal(speech("Hi Muhammad Ali, welcome.", ali), `Hi ${CANDIDATE_TAG}, welcome.`);
  assert.equal(
    speech("Ali here. Muhammad too.", ali),
    `${CANDIDATE_TAG} here. ${CANDIDATE_TAG} too.`,
  );
  const mj = { firstName: "Mary-Jane", lastName: "Watson" };
  for (const said of ["Mary-Jane", "Mary Jane", "Mary", "Jane", "MARY-JANE WATSON"]) {
    assert.equal(speech(`Hi ${said}, welcome.`, mj), `Hi ${CANDIDATE_TAG}, welcome.`, said);
  }
  assert.deepEqual(removeCandidateNameFromSpeech("Hi Mary-Jane. Watson?", mj), {
    text: `Hi ${CANDIDATE_TAG}. ${CANDIDATE_TAG}?`,
    removed: 2,
  });
});

test("speech: a name that is an ordinary word stays the candidate's own word", () => {
  for (const [name, said] of [
    [["Will", "Baker"], "Will you believe I will say I trained as a baker on Baker Street?"],
    [["He", "Wei"], "He helped me, and he was right."],
    [["Wei", "He"], "He helped me, and he was right."],
    [["An", "Nguyen"], "An example of an API I am an owner of."],
    [["May", "Long"], "In May I may take a long break. Long story. This is long overdue."],
    [["Mark", "Young"], "Mark the ticket done; young teams mark it too."],
    [["Grace", "Hope"], "I hope to handle it with grace. call me grace under pressure."],
    [["Will", "Young"], "I will. Young people ask. I'm willing."],
  ]) {
    assert.equal(speech(said, { firstName: name[0], lastName: name[1] }), said, name.join(" "));
  }
});

test("speech: the same name goes where it is plainly a name, written with a capital", () => {
  const will = { firstName: "Will", lastName: "Baker" };
  const T = CANDIDATE_TAG;
  for (const [said, expected] of [
    ["Hi Will, welcome.", `Hi ${T}, welcome.`],
    ["Thanks Will. Good morning Will.", `Thanks ${T}. Good morning ${T}.`],
    ["My name is Will Baker.", `My name is ${T}.`],
    ["my name is will baker", `my name is ${T}`],
    [
      "People call me Will. I'm Will. This is Baker.",
      `People call me ${T}. I'm ${T}. This is ${T}.`,
    ],
    [
      "Will, tell me more. Well, Will, go on. So, Will?",
      `${T}, tell me more. Well, ${T}, go on. So, ${T}?`,
    ],
    ["Thank you, Mr Baker. Baker, Will.", `Thank you, ${T}. ${T}.`],
  ]) {
    assert.equal(speech(said, will), expected, said);
  }
  // A full name made only of ordinary words is two words unless written as a name.
  const wy = { firstName: "Will", lastName: "Young" };
  assert.equal(speech("they will young people into it", wy), "they will young people into it");
  assert.equal(speech("I am Will Young.", wy), `I am ${T}.`);
});

test("speech: a one-letter name goes after a greeting or 'call me' only; one unspaced character wherever it stands alone", () => {
  const a = { firstName: "A", lastName: "Example" };
  assert.equal(
    speech("Hi A, a good day. Call me A. I got an A, B and C. A, B and C are options.", a),
    `Hi ${CANDIDATE_TAG}, a good day. Call me ${CANDIDATE_TAG}. I got an A, B and C. A, B and C are options.`,
  );
  assert.equal(speech("My name is A Example.", a), `My name is ${CANDIDATE_TAG}.`);
  const wei = { firstName: "伟", lastName: "王" };
  assert.equal(
    speech("Hi 伟, people call me 伟.", wei),
    `Hi ${CANDIDATE_TAG}, people call me ${CANDIDATE_TAG}.`,
  );
  assert.equal(speech("伟大的", wei), "伟大的", "inside another word it is not the name");
});

test("speech: particles and a missing name", () => {
  const anna = { firstName: "Anna", lastName: "van der Berg" };
  assert.equal(
    speech("The van was late, Anna. Berg built it.", anna),
    `The van was late, ${CANDIDATE_TAG}. ${CANDIDATE_TAG} built it.`,
  );
  assert.deepEqual(
    removeCandidateNameFromSpeech("Hi there.", { firstName: null, lastName: null }),
    {
      text: "Hi there.",
      removed: 0,
    },
  );
  assert.equal(speech("Hi Cher.", { firstName: null, lastName: "Cher" }), `Hi ${CANDIDATE_TAG}.`);
  assert.equal(
    speech("Hi Madonna.", { firstName: "Madonna", lastName: null }),
    `Hi ${CANDIDATE_TAG}.`,
  );
});
