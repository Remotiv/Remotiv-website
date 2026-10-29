// @ts-nocheck
/**
 * The CV purge loop under a moving table (#55a), and the honesty of its report.
 *
 *   node --test src/lib/cv-purge.test.ts
 *
 * What #55a found on staging: the loop ordered by cv_delete_after alone and
 * paged by offset; with a second writer flipping an indexed column on rows it
 * had not reached, one full run left 237, then 303, of 1,200 due rows with
 * their CV text intact, and logged a count that read as complete. The fake
 * table here is the same adversary: every write the loop makes moves the row
 * (a non-HOT update), and a `between` hook moves rows the loop has not read
 * yet, as that second writer did. The assertions are by ID SET, never by
 * count, because equal counts are exactly what hid the defect.
 *
 * The negative controls in scripts/staging/negative-controls.mjs revert the
 * `id` order key and the incomplete result, and require the tests named
 * there to go red.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/fake-service-client-hook.mjs", import.meta.url));

const { FakeTable, fakeClient } = await import("./supabase/fake-table.ts");
const { runCvPurge, describeCvPurge } = await import("./cv-purge.ts");

const PAST = "2025-12-31T00:00:00+00:00";
const CO = "company-1";

type Log = string[];

/** `n` due applications sharing one cv_delete_after; odd rows carry a path no object backs. */
function dueRows(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const id = `app-${String(i).padStart(5, "0")}`;
    return {
      id,
      // ODD rows carry a path no object backs, so every page of 500 ends on a
      // held row: a cursor set on the last row PROCESSED instead of the last
      // row READ would re-read that row, and the once-per-run test sees it.
      cv_path: i % 2 === 1 ? `cvs/${id}.pdf` : null,
      cv_text: `text of ${id}`,
      cv_delete_after: PAST,
      company_id_snapshot: CO,
    };
  });
}

/**
 * The service the loop builds for itself, through the test hook. Storage
 * confirms only the objects in `objects`; the shared-reference tables are
 * empty, so nothing is ever "still referenced elsewhere".
 */
function install(
  apps: InstanceType<typeof FakeTable>,
  opts: { objects?: Set<string>; comments?: InstanceType<typeof FakeTable> } = {},
) {
  const tables = {
    job_applications: apps,
    talent_profiles: new FakeTable([]),
    client_batch_candidates: new FakeTable([]),
    hire_remote_profiles: new FakeTable([]),
    application_team_comments: opts.comments ?? new FakeTable([]),
  };
  const storageCalls: string[][] = [];
  const client = Object.assign(fakeClient(tables), {
    storage: {
      from: (_bucket: string) => ({
        async remove(paths: string[]) {
          storageCalls.push(paths);
          const gone = paths.filter((p) => opts.objects?.has(p));
          return { data: gone.map((name) => ({ name })), error: null };
        },
      }),
    },
  });
  (globalThis as { __fakeServiceClientForTests?: () => unknown }).__fakeServiceClientForTests =
    () => client;
  return { storageCalls };
}

function captureLog(): { log: Log; restore: () => void } {
  const log: Log = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    log.push(args.map(String).join(" "));
  };
  return { log, restore: () => (console.log = original) };
}

const ids = (rows: { id: unknown }[]) => new Set(rows.map((r) => String(r.id)));

/* ── the skip, and its absence ───────────────────────────── */

test("#55a: every clearable row is cleared and every unconfirmable row is held, with a writer moving unread rows under the loop", async () => {
  const rows = dueRows(1200);
  const apps = new FakeTable(rows);
  // The second writer: after every read, move 40 rows the loop has NOT read
  // yet, rolling through the table, as a recruiter changing stages does.
  const read = new Set<string>();
  let k = 0;
  apps.between = (_n, returned) => {
    for (const r of returned) read.add(String(r.id));
    const unread = rows.map((r) => r.id).filter((id) => !read.has(id));
    for (const id of unread.slice(
      (k * 40) % Math.max(unread.length, 1),
      ((k * 40) % Math.max(unread.length, 1)) + 40,
    )) {
      if (apps.rows.some((r) => r.id === id)) apps.touch(id);
    }
    k += 1;
  };
  install(apps);
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j1", payload: {} });
  } finally {
    restore();
  }

  const expectedCleared = ids(rows.filter((r) => r.cv_path === null));
  const expectedHeld = ids(rows.filter((r) => r.cv_path !== null));
  const cleared = ids(apps.rows.filter((r) => r.cv_text === null && r.cv_path === null));
  const held = ids(apps.rows.filter((r) => r.cv_text === null && r.cv_path !== null));
  const untouched = apps.rows.filter((r) => r.cv_text !== null).map((r) => r.id);

  assert.deepEqual(untouched, [], "a row with its text still set was never reached by the run");
  assert.deepEqual(cleared, expectedCleared, "the cleared SET is exactly the rows without a path");
  assert.deepEqual(
    held,
    expectedHeld,
    "the held SET is exactly the rows whose object storage could not confirm",
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.complete && {
      examined: result.examined,
      cleared: result.cleared,
      unconfirmed: result.unconfirmed,
    },
    { examined: 1200, cleared: 600, unconfirmed: 600 },
    "examined counts every due row exactly once: no repeats, no misses",
  );
  assert.equal(log.length, 1);
  assert.match(log[0], /COMPLETE in \d+ ms: examined=1200 cleared=600 unconfirmed=600/);
});

test("#55a: an unconfirmable row is read ONCE per run, not retried within it", async () => {
  const rows = dueRows(1200);
  const apps = new FakeTable(rows);
  install(apps);
  const seen = new Map<string, number>();
  apps.between = (_n, returned) => {
    // Page reads select cv_delete_after; the shared-path self-check does not.
    for (const r of returned) {
      if ("cv_delete_after" in r) seen.set(String(r.id), (seen.get(String(r.id)) ?? 0) + 1);
    }
  };
  const { restore } = captureLog();
  try {
    await runCvPurge({ id: "j2", payload: {} });
  } finally {
    restore();
  }
  const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(twice, [], "no due row is read twice in one run");
  assert.equal(seen.size, 1200);
});

test("#55a: a confirmed object clears the path too, and the result counts it", async () => {
  const rows = dueRows(10);
  const apps = new FakeTable(rows);
  const { storageCalls } = install(apps, {
    objects: new Set(["cvs/app-00001.pdf", "cvs/app-00003.pdf"]),
  });
  const { restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j3", payload: {} });
  } finally {
    restore();
  }
  assert.equal(storageCalls.length, 1);
  assert.deepEqual(
    ids(apps.rows.filter((r) => r.cv_path === null)),
    ids(rows.filter((r, i) => r.cv_path === null || i === 1 || i === 3)),
  );
  assert.deepEqual(
    result.complete && {
      cleared: result.cleared,
      unconfirmed: result.unconfirmed,
      objectsRemoved: result.objectsRemoved,
    },
    { cleared: 7, unconfirmed: 3, objectsRemoved: 2 },
  );
});

/* ── the report ───────────────────────────────────────────── */

test("#55a: a run that stops for budget says INCOMPLETE and reports 'so far' numbers, never a total", async () => {
  const rows = dueRows(1200);
  const apps = new FakeTable(rows);
  install(apps);
  // A clock the test moves: past the budget as soon as the first page is read.
  let nowMs = 1_000_000;
  apps.between = (n) => {
    if (n === 1) nowMs += 50_000;
  };
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j4", payload: {} }, { budgetMs: 18_000, clock: () => nowMs });
  } finally {
    restore();
  }
  assert.equal(result.complete, false);
  assert.ok(!result.complete);
  assert.equal(result.stoppedDuring, "applications");
  assert.equal(result.examinedSoFar, 500, "only the first page was read before the budget ran out");
  assert.equal(result.clearedSoFar, 250);
  assert.equal(
    result.unconfirmedSoFar,
    250,
    "the page's paths were never attempted: text cleared, path kept",
  );
  assert.ok(
    !("examined" in result) && !("cleared" in result),
    "an incomplete result carries no field that reads as a total",
  );
  assert.equal(
    apps.rows.filter((r) => r.cv_text !== null).length,
    700,
    "700 due rows were left for the next run, and the result says so",
  );
  assert.match(log[0], /INCOMPLETE, budget of 18000 ms reached during applications/);
  assert.match(log[0], /examined so far=500/);
  assert.match(log[0], /NOT examined/);
  assert.doesNotMatch(
    log[0],
    /examined=/,
    "the complete-run field name never appears on an incomplete run",
  );
});

test("#55a: a budget that runs out during the comments pass is reported as that", async () => {
  const apps = new FakeTable(dueRows(4));
  const comments = new FakeTable(
    Array.from({ length: 3 }, (_, i) => ({
      id: `c-${i}`,
      "job_applications.cv_delete_after": PAST,
      "job_applications.company_id_snapshot": CO,
    })),
  );
  install(apps, { comments });
  let nowMs = 0;
  apps.between = () => {
    // Past the budget once the applications are done: the next check is the
    // comments loop's.
    if (apps.rows.every((r) => r.cv_text === null)) nowMs += 50_000;
  };
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j5", payload: {} }, { budgetMs: 18_000, clock: () => nowMs });
  } finally {
    restore();
  }
  assert.ok(!result.complete);
  assert.equal(result.stoppedDuring, "comments");
  assert.equal(result.examinedSoFar, 4);
  assert.equal(result.commentsDeletedSoFar, 0);
  assert.equal(
    comments.rows.length,
    3,
    "no comment was deleted; the report must not claim otherwise",
  );
  assert.match(log[0], /reached during comments/);
});

test("#55a: a complete run deletes the due comments and counts them", async () => {
  const apps = new FakeTable(dueRows(4));
  const comments = new FakeTable(
    Array.from({ length: 3 }, (_, i) => ({
      id: `c-${i}`,
      "job_applications.cv_delete_after": PAST,
      "job_applications.company_id_snapshot": CO,
    })),
  );
  install(apps, { comments });
  const { restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j6", payload: {} });
  } finally {
    restore();
  }
  assert.ok(result.complete);
  assert.equal(result.commentsDeleted, 3);
  assert.equal(comments.rows.length, 0);
});

test("#55a: describeCvPurge puts the stop reason first in both shapes", () => {
  const complete = describeCvPurge("x", {
    complete: true,
    examined: 1,
    cleared: 1,
    unconfirmed: 0,
    objectsRemoved: 0,
    objectsKept: 0,
    commentsDeleted: 0,
    elapsedMs: 5,
  });
  const incomplete = describeCvPurge("x", {
    complete: false,
    stoppedDuring: "applications",
    budgetMs: 18_000,
    examinedSoFar: 500,
    clearedSoFar: 1,
    unconfirmedSoFar: 2,
    objectsRemoved: 0,
    objectsKept: 0,
    commentsDeletedSoFar: 0,
    elapsedMs: 18_001,
  });
  assert.match(complete, /^\[cv-purge\] job x: COMPLETE/);
  assert.match(incomplete, /^\[cv-purge\] job x: INCOMPLETE/);
});

/* ── a failed read names where it was ─────────────────────── */

test("#55a: a failed page read throws with the cursor position, not an offset", async () => {
  const apps = new FakeTable(dueRows(600));
  install(apps);
  const client = (
    globalThis as { __fakeServiceClientForTests?: () => unknown }
  ).__fakeServiceClientForTests?.() as {
    from: (t: string) => unknown;
  };
  // Fail the second applications page. The fake counts queries PER TABLE:
  // the first page is job_applications query 1, the three shared-path
  // self-checks (250 paths in chunks of 100) are 2-4, the two updates 5-6,
  // so the second page is 7.
  const failing = Object.assign(
    fakeClient(
      {
        job_applications: apps,
        talent_profiles: new FakeTable([]),
        client_batch_candidates: new FakeTable([]),
        hire_remote_profiles: new FakeTable([]),
        application_team_comments: new FakeTable([]),
      },
      { failOnQuery: 7 },
    ),
    {
      storage: (client as { storage: unknown }).storage,
    },
  );
  (globalThis as { __fakeServiceClientForTests?: () => unknown }).__fakeServiceClientForTests =
    () => failing;
  const { restore } = captureLog();
  try {
    await assert.rejects(
      runCvPurge({ id: "j7", payload: {} }),
      /cv purge: after 2025-12-31T00:00:00\+00:00 \/ app-00499: connection reset/,
    );
  } finally {
    restore();
  }
});
