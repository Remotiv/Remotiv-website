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
 * The save path writes through replace_interview_questions (082), never this
 * table directly (#58 commit 5): there is no exception left.
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
  // The invite's ONE read (#44): count, questions_snapshot and scoring_snapshot from this array.
  [IA, "loadInviteQuestionRows", "kind"],
  [IA, "fetchInterviewPanel", "kind"],
  // The edit page's fetch and the duplicate both read through loadQuestionList.
  [JOBS, "loadQuestionList", "kind"],
  // The one go-live gate's stored count, per kind (#59 live, #61 async): every path that makes a job live.
  ["lib/interviews/live-go-live.ts", "storedQuestionCount", "kind"],
  ["lib/ai/interview-scoring.ts", "handleAiScorecard", '"async"'],
  ["lib/interviews/review.ts", "loadInterviewSession", "kind"],
  ["lib/interviews/session.ts", "loadCandidateQuestions", '"async"'],
];
test("every query on interview_questions is listed and filtered by kind; none is outside the list", () => {
  const all = sites().map((s) => [s.file, s.fn]);
  const listed = FILTERED.map(([f, fn]) => [f, fn]);
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

test("the save path writes both lists through replace_interview_questions only", () => {
  const jobs = readFileSync(join(SRC, JOBS), "utf8");
  // The one call, shared by saves and the duplicate (replaceQuestionLists).
  const sync = jobs.slice(jobs.indexOf("async function replaceQuestionLists("));
  const body = sync.slice(0, sync.indexOf("\n}\n"));
  assert.match(body, /supabase\.rpc\("replace_interview_questions", \{/);
  assert.match(body, /p_async: asyncList,\s+p_live: liveList,/);
  assert.doesNotMatch(jobs, /from\("interview_questions"\)\s*\.(insert|delete|update|upsert)/);
  // The edit page loads both lists, each by its kind.
  const edit = readFileSync(join(SRC, "app/ai-dashboard/(gated)/jobs/[id]/edit/page.tsx"), "utf8");
  assert.match(edit, /fetchInterviewQuestions\(job\.id, "async"\)/);
  assert.match(edit, /fetchInterviewQuestions\(job\.id, "live"\)/);
});

test("where the filter is a variable, it is the right kind", () => {
  const ia = readFileSync(join(SRC, IA), "utf8");
  // The one read takes the kind as a parameter; the async invite passes async, the live invite live (#44).
  assert.match(ia, /loadInviteQuestionRows\(service, jobId, ctx\.companyId, "async"\)/);
  assert.match(ia, /loadInviteQuestionRows\(service, jobId, ctx\.companyId, "live"\)/);
  assert.equal((ia.match(/loadInviteQuestionRows\(service/g) ?? []).length, 2);
  // Both snapshots are projected from that read's rows, by kind; the gate takes its count from them.
  assert.match(ia, /scoringSnapshotOf\(rows\.rows, "async"\)/);
  assert.match(ia, /scoringSnapshotOf\(rows\.rows, "live"\)/);
  assert.match(ia, /jobQuestionCount: rows\.rows\.length,/);
  // The gate itself reads no questions (#44): the count is its input.
  const gate = readFileSync(join(SRC, "lib/interviews/live-settings.ts"), "utf8");
  assert.ok(!gate.includes(FROM), "the gate no longer reads interview_questions");
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
