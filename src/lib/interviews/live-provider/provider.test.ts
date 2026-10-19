/**
 * What crosses to the AI Video Interview provider (live-provider/create-session.ts)
 * and the in-memory fake behind the interface (live-provider/fake-provider.ts).
 * Every name, CV line and contact detail is made up. No timers, no network.
 *
 *   node --test src/lib/interviews/live-provider/provider.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { buildCreateSessionInput, CreateSessionInputError } = await import("./create-session.ts");
const { createFakeLiveProvider } = await import("./fake-provider.ts");

const SAMPLE = JSON.parse(
  readFileSync(new URL("./__fixtures__/sample-export.json", import.meta.url), "utf8"),
);

const RUBRIC_TEXT = "A strong answer names the queue, the retry policy and the alert threshold.";
const COMPETENCY = "Production ownership";

/** Frozen questions as a session holds them: with every marking field filled in. */
const FROZEN = [
  {
    position: 2,
    text: "Tell me about an API you designed for high traffic.",
    rubric: RUBRIC_TEXT,
    competency: COMPETENCY,
    weight: 3,
  },
  {
    position: 1,
    text: "Tell me a little about yourself.",
    rubric: { strong: RUBRIC_TEXT },
    competency: "Introduction",
    weight: 1,
  },
  {
    position: 3,
    text: "Your CV mentions a report you sped up. How did you find the bottleneck?",
    rubric: [RUBRIC_TEXT],
    competency: COMPETENCY,
    weight: 2,
  },
];

const CV = [
  "Alex Example",
  "Backend Engineer | alex.example@example.com | +92 300 0000000 | linkedin.com/in/alex-example",
  "House 1, Street 1, Lahore",
  "Northwind Logistics - Backend Engineer (2021 - Present)",
].join("\n");

function input(overrides = {}) {
  return buildCreateSessionInput({
    remotivSessionId: "5b0f2c1e-0000-4000-8000-000000000001",
    interviewerName: "Sarah",
    interviewMinutes: 30,
    questions: FROZEN,
    candidateFirstName: "Alex",
    cvText: CV,
    ...overrides,
  });
}

function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

/* ── the create-session input ─────────────────────────────────── */

test("the input never carries a rubric, competency or weight, at any depth", () => {
  const built = input();
  const keys = allKeys(built);
  for (const k of ["rubric", "competency", "weight"]) assert.ok(!keys.has(k), `${k} is absent`);
  const json = JSON.stringify(built);
  assert.ok(!json.includes(RUBRIC_TEXT), "no rubric text anywhere");
  assert.ok(!json.includes(COMPETENCY), "no competency label anywhere");
  for (const q of built.questions) assert.deepEqual(Object.keys(q), ["position", "text"]);
});

test("the input has exactly its six fields; questions sorted by position, text only", () => {
  const built = input();
  assert.deepEqual(Object.keys(built).sort(), [
    "candidate_first_name",
    "cv_text",
    "interview_minutes",
    "interviewer_name",
    "questions",
    "remotiv_session_id",
  ]);
  assert.deepEqual(built.questions, [
    { position: 1, text: "Tell me a little about yourself." },
    { position: 2, text: "Tell me about an API you designed for high traffic." },
    {
      position: 3,
      text: "Your CV mentions a report you sped up. How did you find the bottleneck?",
    },
  ]);
  assert.equal(built.interviewer_name, "Sarah");
  assert.equal(built.interview_minutes, 30);
  assert.equal(built.candidate_first_name, "Alex");
});

test("the CV is always sanitised: no email, phone, link or address reaches the provider", () => {
  const built = input();
  assert.doesNotMatch(
    built.cv_text,
    /alex\.example@example\.com|\+92 300 0000000|linkedin\.com|House 1/,
  );
  assert.match(built.cv_text, /\[email\]/);
  assert.match(built.cv_text, /\[phone\]/);
  assert.match(built.cv_text, /\[link\]/);
  assert.match(built.cv_text, /\[address\]/);
  assert.match(built.cv_text, /Northwind Logistics - Backend Engineer \(2021 - Present\)/);
  assert.equal(input({ cvText: null }).cv_text, "");
});

test("bad input is refused before anything is sent", () => {
  for (const [label, overrides] of [
    ["no session id", { remotivSessionId: " " }],
    ["no interviewer", { interviewerName: "" }],
    ["zero minutes", { interviewMinutes: 0 }],
    ["fractional minutes", { interviewMinutes: 12.5 }],
    ["no questions", { questions: [] }],
    ["duplicate positions", { questions: [FROZEN[0], { ...FROZEN[1], position: 2 }] }],
    ["an empty question", { questions: [{ position: 1, text: "  " }] }],
  ]) {
    assert.throws(() => input(overrides), CreateSessionInputError, label);
  }
  assert.equal(input({ candidateFirstName: "  " }).candidate_first_name, null);
});

/* ── the fake provider ────────────────────────────────────────── */

test("fake: refuses an input carrying a rubric, at the top or on a question", async () => {
  const fake = createFakeLiveProvider(SAMPLE);
  const ok = input();
  await assert.rejects(
    fake.createSession({ ...ok, rubric: RUBRIC_TEXT }),
    /must never receive: rubric/,
  );
  await assert.rejects(
    fake.createSession({ ...ok, questions: [{ ...ok.questions[0], rubric: RUBRIC_TEXT }] }),
    /must never receive: rubric/,
  );
  await assert.rejects(
    fake.createSession({
      ...ok,
      questions: [{ ...ok.questions[0], competency: COMPETENCY, weight: 2 }],
    }),
    /must never receive: competency, weight/,
  );
  assert.equal(fake.created.length, 0, "nothing refused was recorded");
});

test("fake: create, export, parse, delete; the export is the sample under the new session's id", async () => {
  const fake = createFakeLiveProvider(SAMPLE);
  const { providerSessionId } = await fake.createSession(input());
  assert.equal(providerSessionId, "fake-session-1");
  assert.equal(fake.created.length, 1);
  assert.ok(!JSON.stringify(fake.created).includes(RUBRIC_TEXT));

  const parsed = fake.parseExport(fake.exportOf(providerSessionId));
  assert.equal(parsed.provider_session_id, providerSessionId);
  assert.equal(parsed.turns.length, SAMPLE.turns.length);
  assert.equal(parsed.status.code, "candidate_ended");

  await fake.deleteSession(providerSessionId);
  assert.deepEqual(fake.deleted, [providerSessionId]);
  assert.throws(() => fake.exportOf(providerSessionId), /no session/, "nothing kept after delete");
});

test("fake: each session gets its own id; the sample itself is never changed", async () => {
  const before = JSON.stringify(SAMPLE);
  const fake = createFakeLiveProvider(SAMPLE);
  const a = await fake.createSession(input());
  const b = await fake.createSession(input());
  assert.notEqual(a.providerSessionId, b.providerSessionId);
  const exportA = fake.exportOf(a.providerSessionId);
  exportA.turns.length = 0;
  assert.equal(fake.exportOf(b.providerSessionId).turns.length, SAMPLE.turns.length);
  assert.equal(JSON.stringify(SAMPLE), before);
  assert.throws(() => fake.exportOf("fake-session-99"), /no session/);
});
