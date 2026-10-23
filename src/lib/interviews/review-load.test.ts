/**
 * What the Interviews list reports when a page of its read fails.
 *
 *   node --test src/lib/interviews/review-load.test.ts
 *
 * ── The bug ──────────────────────────────────────────────────
 *
 * Every figure on the Interviews page is `array.length` over a range-paged
 * fetch of every session in the company. The loop ended each page with a
 * conditional break on the error, so a failure after the first thousand rows
 * returned a SHORT array and the page rendered a smaller, entirely plausible,
 * internally consistent set of numbers. Nothing about it invited a second look.
 * `listInterviewSessions` returns a `Read` now: a failure has no value at all,
 * so there is nothing to render as though it had worked.
 *
 * ── TEST 4 IS LOAD-BEARING. DO NOT DELETE IT ─────────────────
 *
 * Tests 1, 2 and 3 all assert things about a FAILURE, and every one of them
 * passes against a `listInterviewSessions` that does nothing but
 * `return unavailable()`. They cannot tell the fix from a function that has
 * stopped working entirely — which is the exact shape of the vacuous guard this
 * project has caught five times now.
 *
 * Test 4 is what makes the other three mean anything: 1,500 rows arrive across
 * two pages and every one of them is counted, so the happy path provably still
 * reaches the second page. Any change that satisfies 1-3 by giving up early
 * fails 4. If you are deleting a test here because it looks redundant, it is
 * not this one.
 *
 * ── What is real, and what is not ────────────────────────────
 *
 * `listInterviewSessions`, `pageAll` and `getJobScope` all run as shipped. Only
 * the database is a fake, and it answers each page from the `range` the code
 * actually asked for — so a read that stopped paging gets fewer rows rather
 * than being quietly handed everything. Every session here is synthetic.
 */
// @ts-nocheck — same reason as overview-counts.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
// Nothing ships from this file.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { listInterviewSessions } = await import("./review.ts");

const CO = "c0000000-0000-0000-0000-0000000000c1";
const JOB = "a0000000-0000-0000-0000-00000000000a";
const ctx = {
  companyId: CO,
  role: "owner",
  memberId: "11111111-1111-1111-1111-111111111111",
  user: { id: "22222222-2222-2222-2222-222222222222" },
};

const future = new Date(Date.now() + 7 * 86_400_000).toISOString();

/** n sessions, alternating submitted and invited so the buckets are non-trivial. */
function seed(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `5e550000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    application_id: null,
    job_id: JOB,
    kind: "async",
    status: i % 2 === 0 ? "submitted" : "invited",
    started_at: null,
    submitted_at: i % 2 === 0 ? new Date(Date.now() - 86_400_000).toISOString() : null,
    expires_at: future,
    delete_after: null,
    invited_by_name: null,
    questions_snapshot: [{ id: "q1" }, { id: "q2" }, { id: "q3" }],
    archived_at: null,
    created_at: new Date(Date.now() - i * 1000).toISOString(),
  }));
}

/**
 * A database that answers sessions from the requested range, and can refuse one
 * page of either read.
 *
 * `failSessionFrom` is matched against the range START, so a test names the
 * page it wants to fail rather than counting calls. `failAnswerChunk` counts,
 * because the answer read chunks by id list and has no range to name.
 */
function install({ sessions, failSessionFrom = null, failAnswerChunk = null }) {
  let answerChunk = 0;
  globalThis.__messagesServiceForTests = () =>
    fakeService((table, calls) => {
      if (table === "interview_sessions") {
        const [, from, to] = call(calls, "range");
        if (from === failSessionFrom) {
          return { data: null, error: { message: "test: refused", code: "57014" } };
        }
        return { data: sessions.slice(from, to + 1), error: null };
      }
      if (table === "interview_answers") {
        answerChunk += 1;
        if (answerChunk === failAnswerChunk) {
          return { data: null, error: { message: "test: refused", code: "57014" } };
        }
        const ids = call(calls, "in")[2];
        return {
          data: ids.map((id) => ({ session_id: id, video_path: `${id}/1.webm` })),
          error: null,
        };
      }
      return { data: [], error: null };
    });
}

const quiet = async (fn) => {
  const orig = { error: console.error, warn: console.warn };
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};

/** Every number anywhere in a value, however deeply nested. */
function figures(value) {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(figures);
  if (value && typeof value === "object") return Object.values(value).flatMap(figures);
  return [];
}

// ── 1 ──
test("a failed second page is reported as a failure", async () => {
  install({ sessions: seed(1000), failSessionFrom: 1000 });
  const result = await quiet(() => listInterviewSessions(ctx, { status: "all" }));

  assert.equal(result.ok, false, "the read failed and must say so");
  assert.ok(
    !("counts" in result),
    "a failure must not arrive carrying counts: the page renders whatever counts it is " +
      "given, and 1,000 of 1,500 rows is a complete-looking set of wrong numbers",
  );
});

// ── 2 ──
test("a failed read carries no figures at all", async () => {
  install({ sessions: seed(1000), failSessionFrom: 1000 });
  const result = await quiet(() => listInterviewSessions(ctx, { status: "all" }));

  assert.deepEqual(Object.keys(result), ["ok"]);
  assert.deepEqual(
    figures(result),
    [],
    "the 1,000 rows that WERE read must not survive anywhere in the result — a partial " +
      "value plus a flag is the shape this fix exists to avoid, because the next person " +
      "rendering the object has to remember the flag and eventually will not",
  );
});

// ── 3 ──
test("a failure is distinguishable from a company with no interviews", async () => {
  install({ sessions: seed(1000), failSessionFrom: 0 });
  const failed = await quiet(() => listInterviewSessions(ctx, { status: "all" }));

  install({ sessions: [] });
  const none = await listInterviewSessions(ctx, { status: "all" });

  assert.equal(none.ok, true, "an empty company is an ANSWER, not a failure");
  assert.equal(none.counts, undefined, "the answer is wrapped, so counts live under .value");
  assert.equal(none.value.counts.all, 0, "a true zero stays a zero");
  assert.notDeepEqual(
    failed,
    none,
    "these two must not be the same value. While they were, a failed first load showed the " +
      "day-one empty state — 'interview five people in the time one call takes' — to a " +
      "company that already had interviews we simply could not read",
  );
});

// ── 4 — THE LOAD-BEARING ONE. See the docblock. ──
test("1,500 rows across two pages are every one of them counted", async () => {
  install({ sessions: seed(1500) });
  const result = await listInterviewSessions(ctx, { status: "all" });

  assert.equal(result.ok, true, "nothing failed here");
  assert.equal(
    result.value.counts.all,
    1500,
    "the second page must be read. 1,000 would mean the loop stopped at a page boundary, " +
      "which is the same wrong number the old break produced and would pass tests 1-3",
  );
  assert.equal(result.value.total, 1500);
  assert.deepEqual(
    [result.value.counts.submitted, result.value.counts.invited],
    [750, 750],
    "and the rows from the second page are classified, not merely counted",
  );
  assert.equal(result.value.rows.length, result.value.pageSize, "one page of rows is returned");
});

// ── 5 ──
test("a failed answer chunk makes that column unknown for every row, and fails nothing else", async () => {
  install({ sessions: seed(250), failAnswerChunk: 2 });
  const result = await quiet(() => listInterviewSessions(ctx, { status: "all" }));

  assert.equal(
    result.ok,
    true,
    "the answer counts are one column. The sessions, their statuses and the counts came " +
      "from a read that worked, and a reviewer can still open an interview",
  );
  assert.equal(result.value.counts.all, 250);
  for (const row of result.value.rows) {
    assert.equal(
      row.progress,
      null,
      "unknown for EVERY row or for none. These 20 rows are in the chunk that succeeded, so " +
        "a partial map would populate them and leave the sessions after #100 reading 0/3 — " +
        "and map.get() cannot tell 'no answers' from 'that chunk failed'",
    );
  }

  install({ sessions: seed(250) });
  const ok = await listInterviewSessions(ctx, { status: "all" });
  assert.ok(
    ok.value.rows.every((r) => r.progress?.answered === 1),
    "control: the same 20 rows report their answer when the read works, so the assertion " +
      "above is about the failure and not about rows that never had a count",
  );
});

// ── 6 ──
test("the result states the filter it was actually read under", async () => {
  /*
   * Unrelated to paging, and broken today for that reason: the chips were
   * labelled from the client's own optimistic state, so a click set the
   * highlight and the badge before the read that would populate them had
   * returned. The strip named one filter above another filter's rows.
   *
   * The server resolving it and saying so is what makes the strip
   * self-consistent — including under the stale banner, where old numbers
   * wearing the new filter's name would be a second lie stacked on the first.
   */
  install({ sessions: seed(10) });
  const result = await listInterviewSessions(ctx, {
    status: "submitted",
    jobId: JOB,
    query: "Ahmed",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.applied,
    { status: "submitted", jobId: JOB, query: "Ahmed" },
    "the chips read their label from here, so it has to be the question the rows answer",
  );

  const defaults = await listInterviewSessions(ctx, {});
  assert.deepEqual(
    defaults.value.applied,
    { status: "all", jobId: null, query: "" },
    "and the RESOLVED values, not the arguments: an omitted filter has a defaulted " +
      "value the client never sent and would otherwise have to guess at",
  );
});

// ── 7 ──
test("the conditional break on a paging error is gone from src and stays gone", () => {
  /*
   * A grep-shaped pin, for the single habit that has cost this project the
   * most: a paged read that ends its page by breaking out of the loop when the
   * error is set, which turns a failure into a short answer. review.ts was the
   * last site in the tree; pageAll exists so there is no reason for another.
   *
   * The pattern is assembled from two pieces because this file is itself inside
   * src and would otherwise be its own first offender.
   */
  const BANNED = `if (error) ${"break"}`;
  assert.ok(
    `  ${BANNED};`.includes(BANNED),
    "self-check: the needle still matches the thing it bans",
  );

  const SRC = new URL("../../", import.meta.url);
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
    /\.(tsx|ts|mjs)$/.test(f),
  );
  assert.ok(files.length > 200, `expected to walk all of src, saw ${files.length} files`);

  const offenders = files.filter((f) => readFileSync(new URL(f, SRC), "utf8").includes(BANNED));
  assert.deepEqual(
    offenders,
    [],
    "a failed page must not be turned into a short result. Throw, or return an unreadable " +
      "state; pageAll already does the first",
  );
});
