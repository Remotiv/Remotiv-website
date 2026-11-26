/**
 * #58: every read of interview_questions in the app filters by
 * interview_kind (migration 082), each by the kind it must, and a new read
 * that does not fails here.
 *
 * Three reads are proven on data elsewhere (question-kind-invites.test.ts,
 * question-kind-session.test.ts, live-settings.test.ts). The review page's and
 * the async scorer's reads are pinned here by their query only: their tests'
 * fakes record queries without applying filters.
 *
 * The save path (jobs/actions.ts: the delete and insert in
 * syncInterviewQuestions, and fetchInterviewQuestions for the edit page) moves
 * to replace_interview_questions and kind-aware reads in #58 commit 5. Until
 * then those three are listed by name below, and no other unfiltered site may
 * exist. No live row can exist before commit 6, the wizard.
 *
 *   node --test src/lib/interviews/question-kind-census.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const FROM = '.from("interview_questions")';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "test-support") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every query on the table: file, the function it is in, and the chain up to its `;`. */
function sites() {
  const found: { file: string; fn: string; chain: string }[] = [];
  for (const path of walk(SRC)) {
    const src = readFileSync(path, "utf8");
    let at = src.indexOf(FROM);
    while (at !== -1) {
      const before = src.slice(0, at);
      const fn = [...before.matchAll(/(?:async )?function (\w+)\(/g)].at(-1)?.[1] ?? "?";
      found.push({
        file: relative(SRC, path),
        fn,
        chain: src.slice(at, src.indexOf(";", at)).replace(/\s+/g, " "),
      });
      at = src.indexOf(FROM, at + 1);
    }
  }
  return found;
}

const IA = "app/ai-dashboard/(gated)/applicants/interview-actions.ts";
const JOBS = "app/ai-dashboard/(gated)/jobs/actions.ts";

/** [file, function, the value interview_kind is filtered by]. */
const FILTERED = [
  [IA, "loadQuestionsSnapshot", "kind"],
  [IA, "loadScoringSnapshot", "kind"],
  [IA, "fetchInterviewPanel", "kind"],
  ["lib/ai/interview-scoring.ts", "handleAiScorecard", '"async"'],
  ["lib/interviews/live-settings.ts", "gateLiveInterviewInvite", '"live"'],
  ["lib/interviews/review.ts", "loadInterviewSession", "kind"],
  ["lib/interviews/session.ts", "loadCandidateQuestions", '"async"'],
];
/** The save path, rebuilt in commit 5. Listed, not filtered, until then. */
const COMMIT_5 = [
  [JOBS, "syncInterviewQuestions"],
  [JOBS, "syncInterviewQuestions"],
  [JOBS, "fetchInterviewQuestions"],
];

test("every query on interview_questions is listed: filtered by kind, or the commit 5 save path", () => {
  const all = sites().map((s) => [s.file, s.fn]);
  const listed = [...FILTERED.map(([f, fn]) => [f, fn]), ...COMMIT_5];
  const key = (x: string[]) => x.join(" :: ");
  assert.deepEqual(all.map(key).sort(), listed.map(key).sort());
});

test("each listed read filters interview_kind by the right value", () => {
  const byKey = new Map(sites().map((s) => [`${s.file} :: ${s.fn}`, s.chain]));
  for (const [file, fn, value] of FILTERED) {
    const chain = byKey.get(`${file} :: ${fn}`) ?? "";
    assert.ok(chain.includes(`.eq("interview_kind", ${value})`), `${file} ${fn}: ${chain}`);
  }
});

test("where the filter is a variable, it is the right kind", () => {
  const ia = readFileSync(join(SRC, IA), "utf8");
  // The snapshots take the kind as a parameter; the async invite passes async, the live invite live.
  assert.match(ia, /loadQuestionsSnapshot\(service, jobId, ctx\.companyId, "async"\)/);
  assert.match(ia, /loadScoringSnapshot\(service, jobId, ctx\.companyId, "async"\)/);
  assert.match(ia, /loadQuestionsSnapshot\(service, jobId, ctx\.companyId, "live"\)/);
  assert.match(ia, /loadScoringSnapshot\(service, jobId, ctx\.companyId, "live"\)/);
  assert.equal((ia.match(/loadQuestionsSnapshot\(service/g) ?? []).length, 2);
  assert.equal((ia.match(/loadScoringSnapshot\(service/g) ?? []).length, 2);
  // The panel counts by the kind it read the session with.
  const panel = ia.slice(ia.indexOf("export async function fetchInterviewPanel("));
  assert.match(panel.slice(0, panel.indexOf(FROM)), /\.eq\("kind", kind\)/);
  // The review page filters by the session's own kind, read once.
  const review = readFileSync(join(SRC, "lib/interviews/review.ts"), "utf8");
  const load = review.slice(review.indexOf("export async function loadInterviewSession("));
  assert.match(
    load.slice(0, load.indexOf(FROM)),
    /const kind = readInterviewKind\(row\.kind, row\.id\);/,
  );
  // The async scorer hands a live session to its own scorer before it reads any question.
  const scorer = readFileSync(join(SRC, "lib/ai/interview-scoring.ts"), "utf8");
  const handler = scorer.slice(scorer.indexOf("export async function handleAiScorecard("));
  assert.match(handler.slice(0, handler.indexOf(FROM)), /if \(session\.kind === "live"\)/);
});
