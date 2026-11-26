/**
 * #25, fairness 2a: the candidate's name never reaches the live scorer, so the
 * same answers score the same whatever the candidate is called.
 *
 *   node --test src/lib/interviews/live-scoring-name-fairness.test.ts
 *
 * The same interview is saved, transcribed and scored once per name
 * (scoreLiveSession on fake-live-db.mjs, imported, never edited). Sarah greets
 * the candidate by first name and the candidate says their full name in every
 * answer. The model is a fake whose score is a hash of the whole request, so
 * any difference in what the scorer is sent moves the score. Tolerance: 0.
 *
 * ── Names that once leaked ───────────────────────────────────
 *
 * ONCE_LEAKED lists the ways a name, or its shape, got past the scrub before
 * #25 part 2 (candidate-name.ts removeCandidateNameFromSpeech). Each is held
 * to the same assertion as any other name. One leak is left on purpose and
 * has its own test: a name the transcription spelt differently from how it
 * was typed. The scrub does not guess at spellings.
 *
 * No real AI call, no network. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__liveScoringService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { exchangeFor, scoreLiveSession } = await import("./live-scoring.ts");
const { buildLiveScoringMessage } = await import("../ai/live-interview-scoring.ts");
const { resolveNeedsCheck, resolveWordingCheck } = await import("./live-recovery.ts");
const { handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { saveLiveExport } = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

/* ── the names ────────────────────────────────────────────────── */

/** [first name, last name] as an applicant may have typed them. The first is the reference. */
const NAMES = [
  ["Aisha", "Khan"],
  ["Chinedu", "Okafor"],
  ["Priya", "Venkataraman"],
  ["Emily", "Carter"],
  ["Mohammed", "Rahman"],
  ["Thandiwe", "Nkosi"],
  ["Hiroshi", "Tanaka"],
  ["Mateus", "Oliveira"],
  // Hyphens and apostrophes.
  ["José", "García-López"],
  ["Sophie", "Watson-Parker"],
  ["Fatima", "Al-Sayed"],
  ["Seán", "O'Brien"],
  ["D'Angelo", "Russell"],
  // Particles.
  ["Abdullah", "bin Rashid"],
  ["Anna", "van der Berg"],
  // One token only, and a whole name typed into the first-name field.
  ["Madonna", null],
  [null, "Cher"],
  ["Ali Khan", ""],
  // Diacritics and non-Latin script.
  ["Søren", "Kierkegård"],
  ["Zoë", "Müller"],
  ["Дмитрий", "Иванов"],
  ["محمد", "الحسن"],
  ["秀英", "李"],
];

const fullName = ([first, last]) => [first, last].filter(Boolean).join(" ");
const greetName = ([first, last]) => first || last;
const label = (name) => JSON.stringify(fullName(name));

/** Every token of every name: none may appear, as a whole word, in anything the scorer is sent. */
const nameTokens = (names) => [
  ...new Set(
    names.flatMap((n) => fullName(n).split(/[\s.\-'\u2019]+/u)).filter((t) => [...t].length >= 2),
  ),
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokenIn = (token, text) =>
  new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escapeRe(token)}(?![\\p{L}\\p{N}\\p{M}])`, "u").test(text);
/** The first name token found in `text`, or null. */
const leakedToken = (text, names) => nameTokens(names).find((t) => tokenIn(t, text)) ?? null;

/* ── one interview, scored (live-scoring.test.ts's set-up, with the name a parameter) ── */

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000f2";
const CO = "7aad434d-0000-4000-8000-0000000000f2";
const JOB = "2d4a8cde-0000-4000-8000-0000000000f2";
const APP = "03e4863f-0000-4000-8000-0000000000f2";
const QUESTIONS = FIXTURE.questions
  .filter((x) => x.position <= 8)
  .map((x) => ({
    question_id: `q-${x.position}`,
    position: x.position,
    text: x.text,
    source: x.position <= 4 ? "job" : "cv",
    competency: "Ownership",
    scoring_guide: `Strong answer: a specific example for question ${x.position}. Weak answer: general.`,
    guide_source: x.position <= 4 ? "recruiter" : "ai",
    weight: null,
  }));

async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

/** What the candidate says on a turn: their full name, the name they go by, then the same answer. */
const answer = (name, position, sequence) =>
  `My name is ${fullName(name)} and people call me ${greetName(name)}. On question ${position} I personally rebuilt the import service in turn ${sequence} and cut the runtime in half.`;

/** The fixture's interview for a candidate called `name`: saved and fully transcribed. */
async function decided(name) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: CO,
        job_id: JOB,
        application_id: APP,
        kind: "live",
        attempt: 1,
        provider_session_id: FIXTURE.session_id,
        live_outcome: null,
        live_settings: {
          v: 2,
          questions_frozen: {
            at: "2026-10-16T05:40:00.000Z",
            prompt_version: "live-questions-v1",
            policy_version: "question-mix-v1",
            model: "claude-haiku-5-5",
            calls: 1,
            input_tokens: 1,
            output_tokens: 1,
            rewritten: 0,
            replaced: 0,
          },
        },
        ...snapshotsFor(QUESTIONS),
      },
    ],
    jobs: [{ id: JOB, company_id: CO, title: "Backend Engineer" }],
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: name[0],
        last_name: name[1],
      },
    ],
  });
  // Sarah greets this candidate by their first name, as the provider is given it.
  const raw = structuredClone(FIXTURE);
  raw.candidate_first_name = greetName(name);
  let greeted = 0;
  for (const t of raw.turns) {
    if (typeof t.text === "string" && t.text.includes("Alex")) {
      t.text = t.text.replaceAll("Alex", greetName(name));
      greeted += 1;
    }
  }
  assert.ok(greeted > 0, "the fixture greets the candidate by name");
  const provider = createFakeLiveProvider(raw);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: greetName(name),
    cv_text: "",
  });
  await quiet(() =>
    saveLiveExport(
      SESSION,
      {
        ...parseExport(provider.exportOf(providerSessionId)),
        provider_session_id: FIXTURE.session_id,
      },
      {
        service: db.service,
        fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
        now: () => Date.now(),
      },
    ),
  );
  globalThis.__liveScoringService = db.service;
  const positionOf = (t) =>
    t.question_position ??
    db.tables.interview_turns.find((x) => x.id === t.responds_to_turn_id)?.question_position;
  const turns = [...db.tables.interview_turns]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((t) => t.speaker === "candidate");
  for (const t of turns) {
    await quiet(() =>
      handleLiveTurnTranscribe(
        {
          id: `job-${t.sequence}`,
          payload: { turnId: t.id, sessionId: SESSION },
          attempts: 0,
          max_attempts: 3,
        },
        undefined,
        {
          service: db.service,
          transcribe: async (audio) => {
            const media = [...db.objects.entries()].find(
              ([, o]) =>
                o.bytes.length === audio.bytes.length &&
                o.bytes.every((b, i) => b === audio.bytes[i]),
            );
            const row = db.tables.interview_turns.find((x) => x.media_path === media?.[0]);
            return { text: answer(name, positionOf(row), row.sequence), segments: [] };
          },
          onDecided: async () => {},
        },
      ),
    );
  }
  return db;
}

/**
 * A fake model whose score depends on every byte it is sent: the same request
 * always gets the same score, and a request that differs anywhere gets another.
 */
function hashingModel() {
  const requests = [];
  const call = async (request) => {
    requests.push(structuredClone(request));
    const digest = createHash("sha256").update(JSON.stringify(request)).digest();
    const first = request.messages[0].content
      .split("\n")
      .find((l) => l.startsWith("Candidate: "))
      ?.slice("Candidate: ".length)
      .split(" ")
      .slice(0, 6)
      .join(" ");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            score: digest.readUInt16BE(0) % 101,
            confidence: "high",
            rationale: "The candidate described their own work.",
            quotes: [first],
          }),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 120 },
    };
  };
  return { requests, call };
}

/** The interview scored for a candidate called `name`: what the scorer was sent, and what was stored. */
async function scoredAs(name) {
  const db = await decided(name);
  const model = hashingModel();
  const score = () =>
    quiet(() =>
      scoreLiveSession(SESSION, { service: db.service, call: model.call, enabled: true }),
    );
  const deps = {
    service: db.service,
    caller: { kind: "company", userId: "u-admin", name: "Ada Admin", role: "admin", companyId: CO },
    transcriptSource: async () => 1,
    score,
  };
  const outcome = () => db.tables.interview_sessions[0].live_outcome;
  for (const x of outcome().questions.filter((y) => y.needs_check)) {
    await quiet(() =>
      resolveNeedsCheck(
        { sessionId: SESSION, position: x.position, decision: "score", note: "Checked." },
        deps,
      ),
    );
  }
  for (const x of outcome().questions.filter((y) => y.wording_check)) {
    await quiet(() =>
      resolveWordingCheck(
        { sessionId: SESSION, position: x.position, decision: "score", note: "Checked." },
        deps,
      ),
    );
  }
  const row = db.tables.live_interview_scores.find((r) => r.session_id === SESSION);
  return {
    requests: model.requests,
    // Everything stored about the score but the clock.
    stored: {
      status: row.status,
      overall_score: row.overall_score,
      scored_count: row.scored_count,
      questions: row.questions.map(({ scored_at, ...q }) => q),
    },
    transcripts: db.tables.interview_turns.map((t) => `${t.text ?? ""} ${t.transcript ?? ""}`),
  };
}

const reference = await scoredAs(NAMES[0]);

test("the reference run is a real one: every question scored, and the name was there to leak", () => {
  assert.equal(reference.stored.status, "scored");
  const ai = reference.stored.questions.filter((q) => q.model !== null);
  assert.ok(ai.length >= 5, `AI-scored questions: ${ai.length}`);
  assert.equal(reference.requests.length, ai.length);
  // The name is in the stored interview (the greeting and every answer)...
  const all = reference.transcripts.join("\n");
  assert.ok(all.includes(`Hi ${NAMES[0][0]},`), "Sarah's greeting names the candidate");
  assert.ok(all.includes(`My name is ${fullName(NAMES[0])}`), "the answers name the candidate");
  // ...and its place reaches the scorer as the tag, so the scrub is what is being tested.
  const sent = JSON.stringify(reference.requests);
  assert.ok(sent.includes("Hi [candidate],"));
  assert.ok(sent.includes("My name is [candidate] and people call me [candidate]."));
  // The scores differ by question, so "identical across names" is not a constant.
  assert.ok(new Set(ai.map((q) => q.score)).size > 1);
});

test("the names cover regions, genders, hyphens, apostrophes, particles, single tokens and non-Latin script", () => {
  assert.ok(NAMES.length >= 20, `${NAMES.length} names`);
  const all = NAMES.map(fullName);
  assert.equal(new Set(all).size, NAMES.length, "no name twice");
  for (const [what, re] of [
    ["a hyphen", /-/],
    ["an apostrophe", /'/],
    ["bin", /\bbin\b/],
    ["van der", /\bvan der\b/],
    ["Cyrillic", /\p{Script=Cyrillic}/u],
    ["Arabic", /\p{Script=Arabic}/u],
    ["Han", /\p{Script=Han}/u],
  ]) {
    assert.ok(
      all.some((n) => re.test(n)),
      what,
    );
  }
  assert.ok(
    NAMES.some(([first, last]) => !first || !last),
    "a single-token name",
  );
});

for (const name of NAMES.slice(1)) {
  test(`${label(name)}: the scorer is sent the same bytes and stores the same scores as for ${label(NAMES[0])}`, async () => {
    const run = await scoredAs(name);
    assert.equal(run.requests.length, reference.requests.length, `${label(name)}: request count`);
    for (const [i, request] of run.requests.entries()) {
      const sent = JSON.stringify(request);
      const leaked = leakedToken(sent, NAMES);
      assert.equal(
        leaked,
        null,
        `${label(name)}: "${leaked}" reached the scorer (request ${i + 1})`,
      );
      assert.equal(
        sent,
        JSON.stringify(reference.requests[i]),
        `${label(name)}: request ${i + 1} differs from the reference`,
      );
    }
    assert.deepEqual(run.stored, reference.stored, `${label(name)}: the stored scores differ`);
    const kept = JSON.stringify(run.stored);
    assert.equal(leakedToken(kept, NAMES), null, `${label(name)}: a name is in the stored score`);
  });
}

test("no name token is in anything the reference scorer was sent or stored", () => {
  assert.equal(leakedToken(JSON.stringify(reference.requests), NAMES), null);
  assert.equal(leakedToken(JSON.stringify(reference.stored), NAMES), null);
  // The check can see a name: it finds one in the stored transcripts.
  assert.equal(leakedToken(reference.transcripts.join("\n"), NAMES), NAMES[0][0]);
});

/* ── names that leak ──────────────────────────────────────────── */

const turn = (over) => ({
  kind: null,
  question_position: null,
  responds_to_turn_id: null,
  text: null,
  transcript: null,
  transcript_status: null,
  transcript_segments: null,
  content_purged_at: null,
  ...over,
});
/** One question: Sarah greets `greet` and asks; the candidate says `said`. */
const exchange = (name, greet, said) =>
  exchangeFor(
    1,
    [
      turn({
        id: "t1",
        sequence: 1,
        speaker: "interviewer",
        kind: "base_question",
        question_position: 1,
        text: `Hi ${greet}, tell me about a queue you fixed.`,
      }),
      turn({
        id: "t2",
        sequence: 2,
        speaker: "candidate",
        responds_to_turn_id: "t1",
        transcript: said,
        transcript_status: "done",
      }),
    ],
    { firstName: name[0], lastName: name[1] },
  );
const message = (lines) =>
  buildLiveScoringMessage({
    question: "Tell me about a queue you fixed.",
    competency: "Ownership",
    guide: "Strong answer: a specific example.",
    exchange: lines,
  });

const WORK = "I rebuilt the import service and cut the runtime in half.";
const SAID = (full, goesBy) => `My name is ${full} and people call me ${goesBy}. ${WORK}`;
/** What every name must come out as: the lines the reference candidate's exchange gives. */
const CLEAN = [
  "Hi [candidate], tell me about a queue you fixed.",
  `My name is [candidate] and people call me [candidate]. ${WORK}`,
];

/**
 * Every way past the scrub that #25 found (26 Nov 2026) and part 2 closed.
 * `reference`, where given, is the same answer from a candidate with another
 * name: the answer uses the name's own words ("will", "baker") as words.
 */
const ONCE_LEAKED = [
  {
    what: "the first name in lower case (the first-name scrub is case-sensitive)",
    name: ["Alex", "Example"],
    greet: "Alex",
    said: SAID("alex example", "alex"),
  },
  {
    what: "a one-letter first name is skipped",
    name: ["A", "Example"],
    greet: "A",
    said: SAID("A Example", "A"),
  },
  {
    what: "a one-character given name is skipped (the same rule; common in Chinese names)",
    name: ["伟", "王"],
    greet: "伟",
    said: SAID("伟 王", "伟"),
  },
  {
    what: "a surname that is also a word (Baker) is removed from the answer itself, and Will at a sentence start",
    name: ["Will", "Baker"],
    greet: "Will",
    said: `${SAID("Will Baker", "Will")} Will you believe I trained as a baker first?`,
    // The candidate's own words must not change because of what they are called.
    reference: `${SAID("Aisha Khan", "Aisha")} Will you believe I trained as a baker first?`,
  },
  {
    what: "a hyphenated first name leaves its shape ([candidate]-[candidate])",
    name: ["Mary-Jane", "Watson"],
    greet: "Mary-Jane",
    said: SAID("Mary-Jane Watson", "Mary-Jane"),
  },
  {
    what: "a two-word first name leaves its shape ([candidate] [candidate])",
    name: ["Muhammad Ali", "Raza"],
    greet: "Muhammad Ali",
    said: SAID("Muhammad Ali Raza", "Muhammad Ali"),
  },
  {
    what: "a surname ending in a combining accent leaves the accent behind",
    // As typed (composed): the last letter has no single code point for both its marks.
    name: ["Olusegun", "Adébáyọ\u0300"],
    greet: "Olusegun",
    said: SAID("Olusegun Adébáyọ\u0300", "Olusegun"),
  },
  {
    what: "a typographic apostrophe in the transcript (O\u2019Brien for O'Brien)",
    name: ["Seán", "O'Brien"],
    greet: "Seán",
    said: SAID("Seán O\u2019Brien", "Seán"),
  },
  {
    what: "the same accented name in another Unicode form (typed decomposed, transcribed composed)",
    name: ["Jose\u0301", "Garci\u0301a"],
    greet: "José",
    said: SAID("José García", "José"),
  },
  {
    what: "a Chinese name said surname first with no space (李秀英)",
    name: ["秀英", "李"],
    greet: "秀英",
    said: SAID("李秀英", "秀英"),
  },
];

test("the clean form: a plain name comes out as the tag, in the greeting and in the answer", () => {
  const lines = exchange(["Aisha", "Khan"], "Aisha", SAID("Aisha Khan", "Aisha"));
  assert.deepEqual(
    lines.map((l) => l.text),
    CLEAN,
  );
});

for (const leak of ONCE_LEAKED) {
  test(`${label(leak.name)}: ${leak.what}`, () => {
    const lines = exchange(leak.name, leak.greet, leak.said);
    const expected = leak.reference
      ? exchange(["Aisha", "Khan"], "Aisha", leak.reference)
      : CLEAN.map((text, i) => ({ speaker: i === 0 ? "interviewer" : "candidate", text }));
    const sent = message(lines);
    const reached = lines.map((l) => l.text).join(" / ");
    // (Where the answer itself uses the name's words, the comparison below is the check.)
    const leaked = leak.reference ? null : leakedToken(sent, [leak.name, [leak.greet, null]]);
    assert.equal(leaked, null, `${label(leak.name)}: "${leaked}" reached the scorer: ${reached}`);
    assert.equal(
      sent,
      message(expected),
      `${label(leak.name)}: the scorer's request differs from any other candidate's: ${reached}`,
    );
  });
}

/*
 * The one leak left, on purpose. The transcription wrote the name differently
 * from how the applicant typed it, so there is nothing to match: the scrub
 * never guesses at spellings (it would start removing ordinary words). This
 * is what reaches the scorer today. Closing it means giving the transcription
 * the name's spelling, not changing the scrub; if that lands, this test
 * changes with it.
 */
test("EXPECTED LEAK: a name the transcription spelt differently (Aleks Exampel for Alex Example) reaches the scorer", () => {
  const lines = exchange(["Alex", "Example"], "Alex", SAID("Aleks Exampel", "Aleks"));
  assert.deepEqual(
    lines.map((l) => l.text),
    [CLEAN[0], `My name is Aleks Exampel and people call me Aleks. ${WORK}`],
  );
});
