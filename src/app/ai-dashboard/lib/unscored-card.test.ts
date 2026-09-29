/**
 * Every branch of the drawer's unscored score card: heading, body, control,
 * and what a non-editor sees.
 *
 *   node --test src/app/ai-dashboard/lib/unscored-card.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unscoredCardState } from "./unscored-card.ts";

/** A readable CV on a scoring-on job with nothing in the queue and no card. */
const base = {
  scoreStatus: null,
  scoreError: null,
  hasCv: true,
  cvExpired: false,
  facts: { jobScoringEnabled: true, cvReadable: true, queue: null },
  canEdit: true,
  jobId: "job-1",
};
const state = (over = {}, facts = {}) =>
  unscoredCardState({ ...base, ...over, facts: { ...base.facts, ...facts } });

test("job gone: nothing to do, for anyone", () => {
  const card = state({}, { jobScoringEnabled: null });
  assert.equal(card.kind, "job_gone");
  assert.equal(card.control, null);
  assert.equal(state({ canEdit: false }, { jobScoringEnabled: null }).control, null);
});

test("F5 scoring off: editors get the job-settings link with the More options hint; others get copy only", () => {
  const editor = state({}, { jobScoringEnabled: false });
  assert.equal(editor.kind, "scoring_off");
  assert.equal(editor.heading, "Scoring off for this job");
  assert.equal(editor.control, "job_settings");
  assert.equal(editor.href, "/ai-dashboard/jobs/job-1/edit");
  assert.equal(editor.hint, "Under More options → AI CV scoring.");
  assert.match(editor.body, /Turn it on in the job's settings and re-score/);
  assert.match(editor.body, /aren't scored automatically/);

  const viewer = state({ canEdit: false }, { jobScoringEnabled: false });
  assert.equal(viewer.control, null);
  assert.equal(viewer.href, undefined);
  assert.match(viewer.body, /An owner, admin or recruiter can turn it on/);
});

test("F5 scoring off beats every other state, including a live job and an unreadable CV", () => {
  assert.equal(state({}, { jobScoringEnabled: false, queue: "queued" }).kind, "scoring_off");
  assert.equal(state({}, { jobScoringEnabled: false, cvReadable: false }).kind, "scoring_off");
  assert.equal(state({ scoreStatus: "skipped" }, { jobScoringEnabled: false }).kind, "scoring_off");
  // Job deleted: no link even for an editor.
  assert.equal(state({ jobId: null }, { jobScoringEnabled: false }).control, null);
});

test("F6-A queued or running: in progress, no control - a second request would be a second paid run", () => {
  for (const queue of ["queued", "running"]) {
    const card = state({}, { queue });
    assert.equal(card.kind, "in_progress", queue);
    assert.equal(card.heading, "Scoring in progress");
    assert.equal(card.control, null);
  }
  // Over a stale skipped card too: the request is what is true right now.
  assert.equal(state({ scoreStatus: "skipped" }, { queue: "queued" }).kind, "in_progress");
});

test("F6-A retrying: named as a retry after a temporary problem, no control", () => {
  const card = state({}, { queue: "retrying" });
  assert.equal(card.kind, "retrying");
  assert.match(card.body, /temporary problem and is being retried/);
  assert.equal(card.control, null);
});

test("F6-B no row and no job: never queued, offers Re-score", () => {
  const card = state();
  assert.equal(card.kind, "not_queued");
  assert.equal(card.heading, "Not queued for scoring");
  assert.match(card.body, /didn't reach the queue/);
  assert.equal(card.control, "rescore");
  assert.equal(state({ canEdit: false }).control, null);
});

test("F6-C no row and a dead job: didn't complete, offers Re-score", () => {
  const card = state({}, { queue: "dead" });
  assert.equal(card.kind, "gave_up");
  assert.equal(card.heading, "Scoring didn't complete");
  assert.match(card.body, /stopped after several tries/);
  assert.equal(card.control, "rescore");
});

test("F6 copy never leaks queue vocabulary", () => {
  for (const queue of ["queued", "running", "retrying", "dead", null]) {
    const card = state({}, { queue });
    assert.doesNotMatch(
      `${card.heading} ${card.body}`,
      /\b(job|worker|dead|background|payload)\b/i,
      queue,
    );
  }
});

test("F4 unreadable CV: upload control, and Re-score is not offered", () => {
  const card = state({ scoreStatus: "skipped" }, { cvReadable: false });
  assert.equal(card.kind, "unreadable_cv");
  assert.equal(card.heading, "Couldn't read this CV");
  assert.match(card.body, /no readable text/);
  assert.match(card.body, /Re-scoring won't help/);
  assert.equal(card.control, "upload");
  assert.equal(
    state({ scoreStatus: "skipped", canEdit: false }, { cvReadable: false }).control,
    null,
  );
});

test("F4 is decided by the CV facts, not by the skip reason's wording", () => {
  // Same unreadable CV, three different reason strings, one branch.
  for (const scoreError of [
    "No usable CV text (10 chars, minimum 200).",
    "reworded reason",
    null,
  ]) {
    assert.equal(
      state({ scoreStatus: "skipped", scoreError }, { cvReadable: false }).kind,
      "unreadable_cv",
    );
  }
  // A readable CV with a skipped card is a different state however the reason reads.
  assert.equal(
    state({ scoreStatus: "skipped", scoreError: "No usable CV text (10 chars, minimum 200)." })
      .kind,
    "ready_to_rescore",
  );
});

test("F4 after upload: readable text, stale skipped card, job queued → in progress; enqueue lost → ready to re-score", () => {
  assert.equal(state({ scoreStatus: "skipped" }, { queue: "queued" }).kind, "in_progress");
  const ready = state({ scoreStatus: "skipped" });
  assert.equal(ready.kind, "ready_to_rescore");
  assert.equal(ready.heading, "Ready to score");
  assert.equal(ready.control, "rescore");
});

test("no CV at all: upload, worded as missing rather than unreadable", () => {
  const card = state({ hasCv: false }, { cvReadable: false });
  assert.equal(card.kind, "no_cv");
  assert.equal(card.heading, "No CV attached");
  assert.equal(card.control, "upload");
});

test("expired CV: no control - the server would refuse the upload anyway", () => {
  const card = state({ cvExpired: true, hasCv: false }, { cvReadable: false });
  assert.equal(card.kind, "cv_expired");
  assert.equal(card.control, null);
});

test("failed card: the recorded error and Re-score", () => {
  const card = state({ scoreStatus: "failed", scoreError: "429 rate limited" });
  assert.equal(card.kind, "failed");
  assert.equal(card.body, "429 rate limited");
  assert.equal(card.control, "rescore");
  assert.match(state({ scoreStatus: "failed" }).body, /didn't complete/);
});

test("a non-editor never gets a control, in any state", () => {
  const cases = [
    [{}, {}],
    [{}, { queue: "dead" }],
    [{ scoreStatus: "skipped" }, {}],
    [{ scoreStatus: "failed" }, {}],
    [{ hasCv: false }, { cvReadable: false }],
    [{}, { cvReadable: false }],
    [{}, { jobScoringEnabled: false }],
  ];
  for (const [over, facts] of cases) {
    assert.equal(
      state({ ...over, canEdit: false }, facts).control,
      null,
      JSON.stringify([over, facts]),
    );
  }
});
