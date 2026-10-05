/**
 * Source pins for the CV-scoring cap: the parts that cannot run under bare
 * node:test (server actions, client components) and the repository-wide
 * claims (no other path writes cv_scored). The handler's behaviour itself is
 * driven for real in cv-scoring-allowance.test.ts.
 *
 *   node --test src/lib/ai/cv-scoring-cap-wiring.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = join(SRC, "..");

/** Source with comments removed, so a comment cannot satisfy or trip a pin. */
const strip = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const code = (rel) => strip(readFileSync(join(SRC, rel), "utf8"));

/** The body of one top-level function, from its signature to the next top-level `}`. */
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

const scorer = code("lib/ai/cv-scoring.ts");
const handler = fnBody(scorer, "export async function handleAiCvScore(");
const actions = code("app/ai-dashboard/(gated)/applicants/actions.ts");

/** Every application source file: no tests, no test support, no migrations. */
function appFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "node_modules" || name === "test-support" || name === "migrations") continue;
        walk(path);
      } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
        out.push(path);
      }
    }
  };
  walk(SRC);
  walk(join(ROOT, "scripts"));
  return out.map((path) => ({
    rel: relative(ROOT, path),
    text: strip(readFileSync(path, "utf8")),
  }));
}
const FILES = appFiles();

/* ── the worker gate ────────────────────────────────────────────── */

test("requestCvScore stays free of cap logic", () => {
  const request = code("lib/ai/cv-score-request.ts");
  assert.match(request, /export async function requestCvScore\(/);
  assert.doesNotMatch(request, /allowance|capacity|consume|release|cv_scored|limit/i);
});

test("the reservation sits after the last free skip and before scoreCv", () => {
  const lastFreeSkip = handler.indexOf("cvText.length < MIN_CV_TEXT_CHARS");
  const scoringOff = handler.indexOf("await skip(SCORING_OFF_REASON);");
  const reserve = handler.indexOf("await consumeCvAllowance(service, companyId, app.id);");
  const paid = handler.indexOf("card = await scoreCv(");
  assert.ok(scoringOff > 0 && lastFreeSkip > scoringOff, "free skips found");
  assert.ok(reserve > lastFreeSkip, "reserve after the free skips");
  assert.ok(paid > reserve, "reserve before the paid call");
  assert.equal(handler.match(/consumeCvAllowance\(/g).length, 1);
});

test("the slot is released in a finally unless the score was persisted, and persisted only after the write", () => {
  assert.match(
    handler,
    /if \(writeErr\) throw new Error\(`ai_cv_score: score write failed: \$\{writeErr\}`\);\s*persisted = true;\s*\} finally \{\s*if \(!persisted\) await releaseCvAllowance\(service, reservation\.usageId\);\s*\}/,
  );
  assert.equal(handler.match(/persisted = true;/g).length, 1);
  assert.equal(handler.match(/releaseCvAllowance\(/g).length, 1);
});

test("the old post-success cv_scored write is gone from the scorer", () => {
  assert.doesNotMatch(scorer, /recordUsage|@\/lib\/usage|cv_scored|usage_events/);
});

/* ── no other path writes cv_scored ─────────────────────────────── */

test("recordUsage is only ever called with a literal type, and never cv_scored", () => {
  const types = [];
  for (const { rel, text } of FILES) {
    if (rel.endsWith("src/lib/usage.ts")) continue;
    for (const m of text.matchAll(/recordUsage\(\{([\s\S]*?)\}\)/g)) {
      const t = m[1].match(/type:\s*"([a-z_]+)"/);
      assert.ok(t, `${rel}: recordUsage with a non-literal type`);
      types.push(t[1]);
    }
  }
  assert.ok(types.length > 0, "the scan found the callers");
  assert.ok(!types.includes("cv_scored"), `types: ${types}`);
  assert.deepEqual([...new Set(types)].sort(), ["interview_scored", "whatsapp_sent"]);
});

test("usage_events is written only by recordUsage; everything else reads it", () => {
  const writers = [];
  for (const { rel, text } of FILES) {
    for (const m of text.matchAll(/\.from\("usage_events"\)([\s\S]*?);/g)) {
      if (/\.(insert|upsert|update|delete)\(/.test(m[1])) writers.push(rel);
    }
    assert.doesNotMatch(text, /insert\s+into\s+(public\.)?usage_events/i, rel);
  }
  assert.deepEqual(writers, ["src/lib/usage.ts"]);
});

test("consume_allowance is called from one module, and that module from the scorer only", () => {
  const rpcCallers = FILES.filter((f) => /\.rpc\("consume_allowance"/.test(f.text)).map(
    (f) => f.rel,
  );
  assert.deepEqual(rpcCallers, ["src/lib/cv-allowance.ts"]);
  const consumers = FILES.filter((f) => /consumeCvAllowance\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(consumers.sort(), ["src/lib/ai/cv-scoring.ts", "src/lib/cv-allowance.ts"]);
});

test("nothing queues scoring on its own: only the apply route and the dashboard actions request it", () => {
  const requesters = FILES.filter((f) => /requestCvScore\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(requesters.sort(), [
    "src/app/ai-dashboard/(gated)/applicants/actions.ts",
    "src/app/api/apply/route.ts",
    "src/lib/ai/cv-score-request.ts",
  ]);
  // A plan change does not score held applicants.
  for (const rel of ["lib/plans-admin.ts", "app/admin/companies/actions.ts"]) {
    assert.doesNotMatch(code(rel), /requestCvScore|ai_cv_score|enqueue\(/, rel);
  }
});

/* ── re-score pre-checks ────────────────────────────────────────── */

test("rescoreApplication checks the advisory allowance after ownership and before enqueueing", () => {
  const fn = fnBody(actions, "export async function rescoreApplication(");
  const owner = fn.indexOf("target.company_id_snapshot !== ctx.companyId");
  const check = fn.indexOf(
    "if (scoresToQueue(await readCvCapacity(service, ctx.companyId), 1) === 0) {",
  );
  const refuse = fn.indexOf("return { success: false, error: RESCORE_NO_ALLOWANCE_MESSAGE };");
  const enqueue = fn.indexOf("await requestCvScore(applicationId, ctx.companyId);");
  assert.ok(owner > 0 && check > owner, "after the ownership check");
  assert.ok(refuse > check && enqueue > refuse, "refuses before enqueueing");
});

test("rescoreJob queues at most the advisory capacity, unscored first, and reports the held", () => {
  const fn = fnBody(actions, "export async function rescoreJob(");
  assert.match(
    fn,
    /const room = scoresToQueue\(await readCvCapacity\(service, ctx\.companyId\), ids\.length\);/,
  );
  assert.match(fn, /toQueue = unscoredFirst\(ids, scored\)\.slice\(0, room\);/);
  assert.match(fn, /const held = ids\.length - toQueue\.length;/);
  assert.match(fn, /for \(let i = 0; i < toQueue\.length; i \+= WAVE\)/);
  assert.match(
    fn,
    /toQueue\s*\.slice\(i, i \+ WAVE\)\s*\.map\(\(applicationId\) => requestCvScore\(/,
  );
  assert.doesNotMatch(fn, /ids\.slice\(i/, "never the full list");
  assert.match(fn, /data: \{ queued, alreadyQueued, held \}/);
  assert.equal(fn.match(/requestCvScore\(/g).length, 1);
});

test("the job page's toast says how many were held", () => {
  const jobs = code("app/ai-dashboard/(gated)/jobs/_jobs-client.tsx");
  assert.match(
    jobs,
    /if \(counts\.held > 0\) parts\.push\(`\$\{counts\.held\} held by this month's AI scoring limit`\);/,
  );
  assert.match(jobs, /\? rescoreToast\(job\.title, rescored\)/);
  assert.doesNotMatch(fnBody(jobs, "function rescoreToast("), /—/);
});

/* ── the drawer and the list ────────────────────────────────────── */

test("the held state is matched on the shared constant, and its text exists in one place", () => {
  const client = code("app/ai-dashboard/(gated)/applicants/_applicants-client.tsx");
  const card = code("app/ai-dashboard/lib/unscored-card.ts");
  assert.match(client, /score\?\.status === "skipped" && score\.error === CV_LIMIT_REACHED_REASON/);
  assert.match(card, /input\.scoreError === CV_LIMIT_REACHED_REASON/);
  assert.match(scorer, /await skip\(CV_LIMIT_REACHED_REASON\);/);
  const holders = FILES.filter((f) => f.text.includes("monthly AI scoring limit was reached")).map(
    (f) => f.rel,
  );
  assert.deepEqual(holders, ["src/app/ai-dashboard/lib/applicant-types.ts"]);
});

test("the admin copy no longer says the CV scoring limit is unenforced", () => {
  for (const rel of [
    "app/admin/companies/_plan-editor.tsx",
    "app/admin/companies/_rates-panel.tsx",
  ]) {
    const src = code(rel);
    assert.match(src, /CV scoring limits? (is|are)\s+enforced/, rel);
    assert.doesNotMatch(src, /Limits are recorded/, rel);
  }
});
