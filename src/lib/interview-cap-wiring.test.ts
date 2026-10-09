/**
 * The async interview cap, from the source: every path that creates an async
 * interview goes through the gate, nothing else spends the credit, reminders
 * never do, and the copy says what is enforced.
 *
 *   node --test src/lib/interview-cap-wiring.test.ts
 *
 * The behaviour itself is run in interview-invite-cap.test.ts. These pins
 * catch the shapes a behavioural test cannot see: a second writer added
 * elsewhere, a new caller, or copy drifting back.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });

/** Code only: comments may name a function to say it is not called. */
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FILES = walk(SRC)
  .filter((p) => !p.includes(`${join("src", "test-support")}`))
  .map((p) => {
    const raw = readFileSync(p, "utf8");
    return { rel: relative(ROOT, p), raw, text: strip(raw) };
  });
const file = (rel) => FILES.find((f) => f.rel === rel);

/** A sentence as JSX wraps it: literal text, any run of whitespace between words. */
const prose = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));

const ACTIONS = "src/app/ai-dashboard/(gated)/applicants/interview-actions.ts";
const PANEL = "src/app/ai-dashboard/(gated)/applicants/_interview-panel.tsx";

function body(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `cannot find ${start}`);
  return text.slice(from, to);
}
const asyncSend = () =>
  body(
    file(ACTIONS).text,
    "export async function sendInterviewInvite(",
    "export async function sendLiveInterviewInvite(",
  );
const liveSend = () =>
  body(
    file(ACTIONS).text,
    "export async function sendLiveInterviewInvite(",
    "async function loadInviteTarget(",
  );

/* ── every path reaches the gate ────────────────────────────────── */

test("interview sessions are created in exactly two places, both send actions", () => {
  const writers = [];
  for (const { rel, text } of FILES) {
    for (const m of text.matchAll(
      /\.from\(\s*["']interview_sessions["']\s*\)\s*\.(insert|upsert)\(/g,
    )) {
      writers.push(`${rel}:${m[1]}`);
    }
  }
  assert.deepEqual(writers, [`${ACTIONS}:insert`, `${ACTIONS}:insert`]);
  assert.match(asyncSend(), /\.from\("interview_sessions"\)\s*\.insert\(\{\s*id: sessionId,/);
  assert.match(asyncSend(), /kind: "async",/);
  assert.match(liveSend(), /kind: "live",/);
});

test("the async send reserves first, releases only before acceptance, and never after", () => {
  const s = asyncSend();
  const order = [
    "const sessionId = randomUUID();",
    "await consumeInterviewAllowance(service, ctx.companyId, sessionId);",
    "if (!reservation.allowed) {",
    "await supersedeOpenSession(",
    '.from("interview_sessions")',
    "await deliverInvite(",
    "if (!delivered.ok) return",
    "accepted = true;",
    "if (!accepted) await releaseInterviewAllowance(service, reservation.usageId);",
    "await scheduleInterviewJobs(",
  ];
  let last = -1;
  for (const step of order) {
    const i = s.indexOf(step, last + 1);
    assert.ok(i > last, `out of order or missing: ${step}`);
    last = i;
  }
  // The refusal returns the fixed message and nothing else happens first.
  assert.match(
    s,
    /if \(!reservation\.allowed\) \{\s*return \{ success: false, error: interviewLimitMessage\(new Date\(\)\) \};\s*\}/,
  );
  // Exactly one release, inside the finally, guarded by the acceptance flag.
  assert.equal(file(ACTIONS).text.match(/releaseInterviewAllowance\(/g).length, 1);
  assert.match(
    s,
    /\} finally \{\s*if \(!accepted\) await releaseInterviewAllowance\(service, reservation\.usageId\);\s*\}/,
  );
  // Acceptance is marked straight after the delivery check, before anything else can fail.
  assert.match(
    s,
    /if \(!delivered\.ok\) return \{ success: false, error: delivered\.error \};\s*accepted = true;/,
  );
});

test("the live AI invite is not capped", () => {
  assert.doesNotMatch(
    liveSend(),
    /consumeInterviewAllowance|releaseInterviewAllowance|reservation/,
  );
});

test("the gated action is reached from the applicant drawer only, and has no other way in", () => {
  const callers = FILES.filter((f) => /\bsendInterviewInvite\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(callers.sort(), [PANEL, ACTIONS].sort());
  // "/interview-actions" exactly: ./final-interview-actions is a different module.
  const importers = FILES.filter((f) =>
    /from\s+["'][^"']*\/interview-actions["']/.test(f.text),
  ).map((f) => f.rel);
  assert.deepEqual(importers, [PANEL]);
});

test("only the send action spends interview_sent, and only through the allowance module", () => {
  const users = FILES.filter((f) =>
    /consumeInterviewAllowance|releaseInterviewAllowance/.test(f.text),
  );
  assert.deepEqual(users.map((f) => f.rel).sort(), [ACTIONS, "src/lib/interview-allowance.ts"]);
  const metric = FILES.filter((f) => /["']interview_sent["']/.test(f.text)).map((f) => f.rel);
  // The allowance module consumes it; the admin Usage reader and the company's
  // own view (Step 6, read-only, pinned in company-usage-wiring) count and
  // label it. Nothing else names it.
  assert.deepEqual(metric.sort(), [
    "src/lib/company-usage-types.ts",
    "src/lib/company-usage.ts",
    "src/lib/interview-allowance.ts",
    "src/lib/plans-usage.ts",
  ]);
});

/* ── reminders never consume ────────────────────────────────────── */

test("the reminder and the queue never touch the allowance", () => {
  for (const rel of ["src/lib/interviews/reminder.ts", "src/lib/jobs-queue.ts"]) {
    const { text } = file(rel);
    assert.doesNotMatch(
      text,
      /interview-allowance|consume_allowance|release_allowance|interview_sent|consumeInterviewAllowance/,
      rel,
    );
  }
  // The reminder is scheduled by the send, after the credit is spent, and scheduling spends nothing.
  const schedule = body(
    file(ACTIONS).text,
    "async function scheduleInterviewJobs(",
    "async function readJobInterviewSettings(",
  );
  assert.doesNotMatch(schedule, /Allowance|rpc\(/);
});

/* ── copy ───────────────────────────────────────────────────────── */

test("re-scoring is described as one AI scoring credit, never as cents", () => {
  for (const { rel, raw } of FILES) {
    assert.doesNotMatch(raw, /two cents|couple of cents per CV/i, rel);
  }
  const applicants = file("src/app/ai-dashboard/(gated)/applicants/_applicants-client.tsx").text;
  assert.match(applicants, />\s*Uses one AI scoring credit\s*</);
  assert.match(applicants, /Re-run the AI on this CV - uses one AI scoring credit\./);
  const jobs = file("src/app/ai-dashboard/(gated)/jobs/_jobs-client.tsx").text;
  assert.match(jobs, /Uses one AI scoring credit per CV\./);
});

test("the plan editor and Plans & Rates say what is enforced and what is not", () => {
  const editor = file("src/app/admin/companies/_plan-editor.tsx").text;
  assert.match(editor, /The CV scoring limit is enforced:/);
  assert.match(
    editor,
    prose(
      "The async interview invitation limit is enforced: past it, no invitation is sent until the month resets or the limit is raised. Live AI is not enforced yet.",
    ),
  );
  const rates = file("src/app/admin/companies/_rates-panel.tsx").text;
  assert.match(
    rates,
    prose(
      "CV scoring limits are enforced. Async interview invitation limits are enforced. Live AI is not enforced yet.",
    ),
  );
  for (const [rel, text] of [
    ["editor", editor],
    ["rates", rates],
  ]) {
    assert.doesNotMatch(text, /recorded, not enforced/, rel);
    assert.doesNotMatch(text, /—/, `${rel}: hyphens, never em dashes, in this copy`);
  }
});
