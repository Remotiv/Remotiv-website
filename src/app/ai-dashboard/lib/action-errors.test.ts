/**
 * The recruiter never reads a database message (Phase 6, A6-26).
 *
 *   node --test src/app/ai-dashboard/lib/action-errors.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionFailed, actionIncomplete, queueFailed } from "./action-errors.ts";

const PG = 'duplicate key value violates unique constraint "job_applications_pkey"';

test("the returned sentence names the action and promises nothing changed; the raw text is not in it", () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const out = actionFailed("save that stage change", { message: PG });
    assert.equal(
      out,
      "Couldn't save that stage change. Nothing was changed - try again in a moment.",
    );
    assert.equal(out.includes(PG), false);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /save that stage change failed/);
    assert.ok(logged[0].includes(PG), "the raw message goes to the log");
    assert.equal(
      actionFailed("delete that job", null),
      "Couldn't delete that job. Nothing was changed - try again in a moment.",
    );
    assert.equal(
      actionFailed("attach that CV", "plain string"),
      "Couldn't attach that CV. Nothing was changed - try again in a moment.",
    );
  } finally {
    console.error = original;
  }
});

test("a part-way failure never claims nothing changed; it sends the recruiter to look", () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const out = actionIncomplete("delete that applicant", { message: PG });
    assert.equal(
      out,
      "We couldn't finish that action. Refresh to check the current state, then try again.",
    );
    assert.doesNotMatch(out, /Nothing was changed/);
    assert.equal(out.includes(PG), false);
    assert.match(logged[0], /delete that applicant failed part-way/);
    assert.ok(logged[0].includes(PG));
  } finally {
    console.error = original;
  }
});

test("queue failures read as a queue problem, never as SQLSTATE", () => {
  const original = console.error;
  console.error = () => {};
  try {
    const out = queueFailed(
      "a re-score",
      'new row violates check constraint "background_jobs_type_check" (23514)',
    );
    assert.equal(out, "Couldn't queue a re-score - try again in a moment.");
    assert.doesNotMatch(out, /23514|constraint/);
  } finally {
    console.error = original;
  }
});
