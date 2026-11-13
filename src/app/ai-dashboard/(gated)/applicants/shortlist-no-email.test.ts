/**
 * The Split panel's Shortlist button (commit 6c): what one click may do.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/shortlist-no-email.test.ts"
 *
 * One click moves an applicant to Shortlisted through the same write as the
 * Stage control. Today that sends the candidate nothing, because `shortlisted`
 * is not a key of STAGE_EVENTS (src/lib/email/candidate/types.ts). That fact is
 * the reason the button needs no confirmation step, so it is pinned here: if
 * someone maps `shortlisted` to an email, this fails and says what else has to
 * change.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { STAGE_EVENTS } = await import("../../../../lib/email/candidate/types.ts");
const SRC = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

test("moving to Shortlisted sends the candidate nothing (STAGE_EVENTS.shortlisted is unset)", () => {
  assert.equal(
    STAGE_EVENTS.shortlisted,
    undefined,
    "STAGE_EVENTS.shortlisted is now set, so moving someone to Shortlisted emails the " +
      "candidate. The Split panel's one-click Shortlist button (_split-panel.tsx, " +
      "handleShortlist in _applicants-client.tsx) was built on that NOT happening: " +
      "re-enabling it requires adding a confirmation step to that button first.",
  );
  assert.ok(STAGE_EVENTS.rejected, "the map itself still loads (rejected is mapped)");
});

function shortlistHandler(): string {
  const start = SRC.indexOf("async function handleShortlist(");
  assert.ok(start > -1, "handleShortlist not found");
  return SRC.slice(start, SRC.indexOf("\n  }\n", start));
}

test("it is the same stage write as the Stage control, no new server action", () => {
  const body = shortlistHandler();
  assert.match(body, /await updateApplicationStage\(id, "shortlisted"\)/);
  assert.equal((body.match(/await [a-zA-Z]+\(/g) ?? []).length, 1, "one server call");
});

test("not optimistic; on success the row, counts and Flagged badge update, the list is not re-read", () => {
  const body = shortlistHandler();
  const fail = body.indexOf("if (!saved)");
  const override = body.indexOf('setStageOverrides((prev) => ({ ...prev, [id]: "shortlisted" }));');
  assert.ok(fail > -1 && override > fail, "the stage must change only after the save succeeded");
  assert.match(body.slice(fail), /refreshCounts\(jobFilter === "all" \? null : jobFilter\);/);
  assert.match(body.slice(fail), /refreshFlaggedCount\(jobFilter\);/);
  assert.doesNotMatch(body, /refreshList\(/, "the row stays in view; no list re-read");
});

test("the copy: success toast and the failure sentence, hyphens only", () => {
  const body = shortlistHandler();
  assert.match(body, /setToast\(`\$\{name\} moved to Shortlisted`\);/);
  assert.match(body, /`Couldn't shortlist \$\{name\} - nothing changed\.`/);
  const en = String.fromCharCode(0x2013);
  const em = String.fromCharCode(0x2014);
  assert.ok(!body.includes(en) && !body.includes(em), "no em or en dash in the handler");
});

test("the button is offered only where the server rule allows it", () => {
  const body = shortlistHandler();
  assert.match(body, /!canShortlist\(viewerRole, row\.pipeline_stage\)/);
  // One set of props feeds both the panel and the sheet (commit 7).
  assert.match(SRC, /shortlisting: shortlistingId === splitRow\.id,/);
  assert.match(
    SRC,
    /shortlistError: shortlistError\?\.id === splitRow\.id \? shortlistError\.message : null,/,
  );
});
