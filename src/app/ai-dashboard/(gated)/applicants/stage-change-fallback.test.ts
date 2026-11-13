/**
 * A stage change is never a silent no-op (commit 6a).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/stage-change-fallback.test.ts"
 *
 * handleStageChange looked the applicant up in the current page's rows only,
 * and returned without saving or saying anything when they were not there: a
 * deep-linked applicant from another page, a Review-top-10 row, or the Split
 * panel's applicant. It now falls back to the row the caller is showing, says
 * so when there is no row at all, and the off-page sources carry the same
 * stage override as the page rows so the saved stage shows. Source pins: the
 * repo has no DOM runner; the behaviour is proven on staging in the report.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

/** The handler's body, from its signature to the line that records `previous`. */
function handlerHead(): string {
  const start = SRC.indexOf("async function handleStageChange(");
  assert.ok(start > -1, "handleStageChange not found");
  const end = SRC.indexOf("const previous = current.pipeline_stage;", start);
  assert.ok(end > start, "the `previous` line moved - re-point this pin");
  return SRC.slice(start, end);
}

test("the handler takes the caller's row and falls back to it", () => {
  const head = handlerHead();
  assert.match(head, /shown: CompanyApplicantRow \| null/);
  assert.match(
    head,
    /const current = rows\.find\(\(r\) => r\.id === id\) \?\? \(shown\?\.id === id \? shown : null\);/,
  );
});

test("no row at all is an error toast, never a silent return", () => {
  const head = handlerHead();
  assert.doesNotMatch(head, /if \(!current \|\|/, "the old combined silent return is back");
  const missing = head.match(/if \(!current\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(missing, "no branch for a missing row");
  assert.match(missing[1], /setToast\(\{[\s\S]*tone: "error"/);
  assert.match(missing[1], /Couldn't change the stage - this applicant isn't loaded\./);
  assert.match(missing[1], /return;/);
});

test("both callers pass the row they are showing", () => {
  assert.match(SRC, /handleStageChange\(openRow\.id, next, openRow\)/, "the drawer");
  assert.match(SRC, /handleStageChange\(splitRow\.id, next, splitRow\)/, "the Split panel");
  assert.equal((SRC.match(/handleStageChange\(/g) ?? []).length, 3, "one definition, two callers");
});

test("off-page rows show the saved stage: top-10 rows and both fallbacks carry the override", () => {
  const top = SRC.slice(
    SRC.indexOf("const topRows = useMemo("),
    SRC.indexOf("const withStageOverride"),
  );
  assert.match(top, /const stage = stageOverrides\[r\.id\] \?\? r\.pipeline_stage;/);
  assert.match(top, /\[topScored, scoreOverrides, stageOverrides\]/);
  assert.match(SRC, /withStageOverride\(offPageRow\?\.id === openId \? offPageRow : null\)/);
  assert.match(
    SRC,
    // panelId: the panel's applicant at 1100+, the sheet's below (commit 7).
    /withStageOverride\(splitRead\?\.id === panelId \? splitRead\.applicant : null\)/,
  );
});
