/**
 * The marking scheme never reaches a candidate: no candidate-facing route,
 * page or read path selects or returns interview_sessions.scoring_snapshot,
 * where AI Video Interview keeps each question's private scoring guide and
 * source (lib/interviews/frozen-questions.ts).
 *
 *   1. A scan of every file under the candidate's routes (/interview/[token]
 *      and /api/interview/*) and of the read path, lib/interviews/session.ts.
 *   2. The real resolveSessionByToken against a fake database that returns
 *      EVERY column, the private snapshot included, whatever was asked for:
 *      what it selects, and what it hands the candidate page.
 *
 * Nothing leaves the machine; every value is made up.
 *
 *   node --test src/lib/interviews/candidate-read-scope.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__candidateReadService(); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { resolveSessionByToken } = await import("./session.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** Every .ts/.tsx file under `dir`, recursively. */
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const CANDIDATE_FILES = [
  ...files(join(SRC, "app/interview")),
  ...files(join(SRC, "app/api/interview")),
  join(SRC, "lib/interviews/session.ts"),
];

test("scan: no candidate route, page or read path names scoring_snapshot or selects every column", () => {
  assert.ok(CANDIDATE_FILES.length >= 8, `found ${CANDIDATE_FILES.length} files`);
  for (const f of CANDIDATE_FILES) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /scoring_snapshot/, f);
    assert.doesNotMatch(text, /from\("interview_sessions"\)\s*\.select\(\s*["'`]\*/, f);
    assert.doesNotMatch(text, /readFrozenQuestionSet|live-question-freeze|frozen-questions/, f);
  }
});

/* ── the read path at runtime ─────────────────────────────────── */

const TOKEN = "t".repeat(43);
const GUIDE = "Strong answer: names the private standard. Weak answer: misses it.";
const FROZEN = snapshotsFor([
  {
    question_id: "q-1",
    position: 1,
    text: "Job question one, as authored.",
    source: "job",
    competency: "Ownership",
    scoring_guide: GUIDE,
    weight: 2,
  },
  {
    question_id: "q-2",
    position: 2,
    text: "Tell me about the migration you led.",
    source: "cv",
    competency: "Technical depth",
    scoring_guide: GUIDE,
    weight: null,
  },
]);

/** A fake that answers interview_sessions with every column, whatever the select asked for. */
function everyColumnService(kind) {
  const service = fakeService((table) => {
    if (table === "interview_sessions") {
      return {
        data: {
          id: "s-1",
          company_id: "c-1",
          application_id: "a-1",
          job_id: "j-1",
          token_hash: hashSessionToken(TOKEN),
          status: "invited",
          kind,
          allow_rerecord: false,
          consent_at: null,
          submitted_at: null,
          expires_at: "2999-01-01T00:00:00.000Z",
          questions_snapshot: FROZEN.questions_snapshot,
          scoring_snapshot: FROZEN.scoring_snapshot,
          live_settings: { v: 2, questions_frozen: { at: "2026-10-19T09:00:00.000Z" } },
        },
        error: null,
      };
    }
    if (table === "companies") return { data: { name: "Acme" }, error: null };
    if (table === "jobs")
      return { data: { title: "Backend Engineer", allow_rerecord: false }, error: null };
    return { data: [], error: null };
  });
  return service;
}

for (const kind of ["async", "live"]) {
  test(`runtime (${kind}): the session read never selects scoring_snapshot, and the candidate payload carries no marking`, async () => {
    const service = everyColumnService(kind);
    globalThis.__candidateReadService = () => service;
    const resolved = await resolveSessionByToken(TOKEN);
    assert.ok(resolved, "the token resolves");

    const sessionReads = service.queries.filter((q) => q.table === "interview_sessions");
    assert.ok(sessionReads.length > 0);
    for (const q of sessionReads) {
      const select = q.calls.find((c) => c[0] === "select")?.[1] ?? "";
      assert.doesNotMatch(select, /scoring_snapshot|live_settings|\*/, "never asked for");
    }

    const payload = JSON.stringify(resolved.session);
    if (kind === "async") {
      // The payload was really built from the snapshot: the question text is there.
      assert.ok(
        payload.includes("Tell me about the migration you led."),
        "questions reached the payload",
      );
    }
    for (const leak of [
      "Strong answer",
      "scoring_snapshot",
      "rubric",
      "competency",
      "source",
      "Technical depth",
      "questions_frozen",
    ]) {
      assert.ok(!payload.includes(leak), `${kind}: ${leak} is not in the candidate payload`);
    }
  });
}
