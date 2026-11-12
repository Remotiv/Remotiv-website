/**
 * The Flagged badge re-reads after a stage change (commit 6b).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/flagged-count-refresh.test.ts"
 *
 * The badge counts flagged applicants in Applied and Screening only, so a move
 * out of those stages changes it. It was read only when the job filter moved,
 * so after a stage change it went stale. handleStageChange is the one path for
 * the drawer and the Split panel, and it now re-reads the badge after a save.
 * Source pins: the repo has no DOM runner; the behaviour is proven on staging.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

function handler(): string {
  const start = SRC.indexOf("async function handleStageChange(");
  assert.ok(start > -1, "handleStageChange not found");
  const end = SRC.indexOf("\n  }\n", start);
  return SRC.slice(start, end);
}

test("a successful stage change re-reads the Flagged badge, after the failure return", () => {
  const body = handler();
  const fail = body.indexOf("if (!result.success)");
  const refresh = body.indexOf("refreshFlaggedCount(jobFilter);");
  assert.ok(fail > -1, "the failure branch moved - re-point this pin");
  assert.ok(refresh > fail, "the badge must be re-read only once the save succeeded");
  assert.equal((body.match(/refreshFlaggedCount\(/g) ?? []).length, 1);
});

test("the drawer and the panel both go through that handler", () => {
  assert.match(SRC, /handleStageChange\(openRow\.id, next, openRow\)/);
  assert.match(SRC, /handleStageChange\(splitRow\.id, next, splitRow\)/);
});

test("the job-filter effect uses the same read, and only the newest answer lands", () => {
  assert.match(
    SRC,
    /useEffect\(\(\) => \{\s*refreshFlaggedCount\(jobFilter\);\s*\}, \[jobFilter, refreshFlaggedCount\]\);/,
  );
  const cb = SRC.slice(SRC.indexOf("const refreshFlaggedCount = useCallback("));
  assert.match(cb.slice(0, 900), /const seq = \+\+flaggedSeq\.current;/);
  assert.equal((cb.slice(0, 900).match(/seq === flaggedSeq\.current/g) ?? []).length, 2);
  assert.equal((SRC.match(/countFlaggedApplicants\(/g) ?? []).length, 1, "one read site");
});
