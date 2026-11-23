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
 * #60 (the "#60" tests below): the text pass runs first, the storage pass has
 * a guaranteed share of the budget and reads NEWEST due first so a pile of
 * held rows cannot starve newer ones, a path whose object storage reports
 * missing is cleared (not held for ever), an error keeps it held, and the
 * result never says COMPLETE while anything due is left.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import ts from "typescript";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/fake-service-client-hook.mjs", import.meta.url));

const { FakeTable, fakeClient } = await import("./supabase/fake-table.ts");
const { runCvPurge, handleCvPurge, describeCvPurge, CV_SCORE_WORDS_CLEARED, scoreWordsLeft } =
  await import("./cv-purge.ts");

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

type Table = InstanceType<typeof FakeTable>;

/** The other tables a `cvs` key can live in (shared-storage-refs.ts TABLES_BY_COLUMN.cv_path). */
type Sibling = "talent_profiles" | "client_batch_candidates" | "hire_remote_profiles";
const SIBLINGS: Sibling[] = ["talent_profiles", "client_batch_candidates", "hire_remote_profiles"];

/**
 * The service the loop builds for itself, through the test hook. Storage
 * confirms only the objects in `objects` and takes them out of that set, so a
 * test can ask what is left. The shared-reference tables are empty unless
 * `siblings` fills one, so by default nothing is ever "still referenced
 * elsewhere".
 */
function install(
  apps: Table,
  opts: {
    objects?: Set<string>;
    comments?: Table;
    scores?: Table;
    siblings?: Partial<Record<Sibling, Table>>;
    /** Paths storage errors on: remove() leaves them, info() cannot answer. */
    errorPaths?: Set<string>;
  } = {},
) {
  const objects = opts.objects ?? new Set<string>();
  const errorPaths = opts.errorPaths ?? new Set<string>();
  const tables = {
    job_applications: apps,
    talent_profiles: opts.siblings?.talent_profiles ?? new FakeTable([]),
    client_batch_candidates: opts.siblings?.client_batch_candidates ?? new FakeTable([]),
    hire_remote_profiles: opts.siblings?.hire_remote_profiles ?? new FakeTable([]),
    application_team_comments: opts.comments ?? new FakeTable([]),
    application_scores: opts.scores ?? new FakeTable([]),
  };
  const storageCalls: string[][] = [];
  const infoCalls: string[] = [];
  const client = Object.assign(fakeClient(tables), {
    storage: {
      from: (_bucket: string) => ({
        async remove(paths: string[]) {
          storageCalls.push(paths);
          const gone = paths.filter((p) => objects.has(p) && !errorPaths.has(p));
          for (const p of gone) objects.delete(p);
          return { data: gone.map((name) => ({ name })), error: null };
        },
        // Storage's own answers (storage-js 2.105.0, read on staging for #6):
        // a missing object is StorageApiError 400 / statusCode "404".
        async info(path: string) {
          infoCalls.push(path);
          if (errorPaths.has(path)) {
            return { data: null, error: { status: 500, statusCode: "500", message: "upstream" } };
          }
          if (objects.has(path)) return { data: { size: 1000 }, error: null };
          return {
            data: null,
            error: { status: 400, statusCode: "404", message: "Object not found" },
          };
        },
      }),
    },
  });
  (globalThis as { __fakeServiceClientForTests?: () => unknown }).__fakeServiceClientForTests =
    () => client;
  return { storageCalls, infoCalls, objects };
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

/** The paths of the odd rows dueRows() gives a path: storage errors on them, so they are held. */
const oddPaths = (rows: { cv_path: string | null }[]) =>
  new Set(rows.map((r) => r.cv_path).filter((p): p is string => p !== null));

test("#55a: every clearable row is cleared and every unconfirmable row is held, with a writer moving unread rows under the loop", async () => {
  const rows = dueRows(1200);
  const apps = new FakeTable(rows);
  // The second writer: after every read, move 40 rows the loop has NOT read
  // yet, rolling through the table, as a recruiter changing stages does.
  const read = new Set<string>();
  let k = 0;
  apps.between = (_n, returned) => {
    for (const r of returned) if ("cv_path" in r) read.add(String(r.id));
    const unread = rows.map((r) => r.id).filter((id) => !read.has(id));
    for (const id of unread.slice(
      (k * 40) % Math.max(unread.length, 1),
      ((k * 40) % Math.max(unread.length, 1)) + 40,
    )) {
      if (apps.rows.some((r) => r.id === id)) apps.touch(id);
    }
    k += 1;
  };
  install(apps, { errorPaths: oddPaths(rows) });
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

  assert.deepEqual(untouched, [], "the text pass reached every due row");
  assert.deepEqual(cleared, expectedCleared, "the cleared SET is exactly the rows without a path");
  assert.deepEqual(held, expectedHeld, "the held SET is exactly the rows storage errored on");
  assert.equal(result.text.cleared, 1200);
  assert.deepEqual(
    {
      examined: result.storage.examined,
      heldError: result.storage.heldError,
      rowsCleared: result.storage.rowsCleared,
    },
    { examined: 600, heldError: 600, rowsCleared: 0 },
    "the storage pass examined every row with a path exactly once: no repeats, no misses",
  );
  assert.equal(result.complete, false, "600 held rows are due work left: never COMPLETE");
  assert.equal(result.dueLeft, 600);
  assert.equal(log.length, 1);
  assert.match(log[0], /INCOMPLETE .*600 held on a storage error/);
});

test("#55a: an unconfirmable row is read ONCE per run, not retried within it", async () => {
  const rows = dueRows(1200);
  const apps = new FakeTable(rows);
  install(apps, { errorPaths: oddPaths(rows) });
  const seen = new Map<string, number>();
  apps.between = (_n, returned) => {
    // Storage pages select cv_path and cv_delete_after; the text pass and the
    // shared-path self-check do not select both.
    for (const r of returned) {
      if ("cv_path" in r && "cv_delete_after" in r) {
        seen.set(String(r.id), (seen.get(String(r.id)) ?? 0) + 1);
      }
    }
  };
  const { restore } = captureLog();
  try {
    await runCvPurge({ id: "j2", payload: {} });
  } finally {
    restore();
  }
  const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(twice, [], "no due row is read twice by the storage pass in one run");
  assert.equal(seen.size, 600);
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
  assert.equal(apps.rows.filter((r) => r.cv_path !== null).length, 0);
  assert.deepEqual(
    {
      removed: result.storage.removed,
      alreadyMissing: result.storage.alreadyMissing,
      heldError: result.storage.heldError,
      rowsCleared: result.storage.rowsCleared,
    },
    { removed: 2, alreadyMissing: 3, heldError: 0, rowsCleared: 5 },
  );
  assert.equal(result.complete, true);
});

/* ── the report ───────────────────────────────────────────── */

// Negative control (#60): count the cut page as held ("unconfirmed") instead
// of not attempted, and this test fails.
test("#60: a budget cut mid-page reports the rest of the page as NOT ATTEMPTED, never as held or complete", async () => {
  const rows = dueRows(1200);
  const apps = new FakeTable(rows);
  install(apps, { objects: oddPaths(rows) });
  // A clock the test moves: past the whole budget as soon as the first storage page is read.
  let nowMs = 1_000_000;
  apps.between = (_n, returned) => {
    if (returned.some((r) => "cv_path" in r && "cv_delete_after" in r)) nowMs += 50_000;
  };
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j4", payload: {} }, { budgetMs: 18_000, clock: () => nowMs });
  } finally {
    restore();
  }
  assert.equal(result.complete, false);
  assert.equal(result.text.finished, true, "the text pass ran first and finished");
  assert.equal(result.storage.finished, false);
  assert.deepEqual(
    {
      examined: result.storage.examined,
      notAttempted: result.storage.notAttempted,
      heldError: result.storage.heldError,
      removed: result.storage.removed,
    },
    { examined: 500, notAttempted: 500, heldError: 0, removed: 0 },
  );
  assert.equal(result.dueLeft, 600, "every row with a path is still due, and the result says so");
  assert.match(log[0], /INCOMPLETE .*budget of 18000 ms reached before the end of: storage/);
  assert.match(log[0], /500 not attempted/);
  assert.doesNotMatch(log[0], /COMPLETE in/);
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
    // Past the budget once the files are done: the next check is the comments loop's.
    if (apps.rows.every((r) => r.cv_text === null && r.cv_path === null)) nowMs += 50_000;
  };
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j5", payload: {} }, { budgetMs: 18_000, clock: () => nowMs });
  } finally {
    restore();
  }
  assert.equal(result.complete, false);
  assert.equal(result.storage.finished, true);
  assert.equal(result.comments.finished, false);
  assert.equal(result.comments.deleted, 0);
  assert.equal(
    comments.rows.length,
    3,
    "no comment was deleted; the report must not claim otherwise",
  );
  assert.match(log[0], /reached before the end of: comments, scores/);
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
  assert.equal(result.comments.deleted, 3);
  assert.equal(comments.rows.length, 0);
});

/** A result with every pass finished and nothing left, to vary one field at a time. */
function finishedResult(over: Record<string, unknown> = {}) {
  return {
    complete: true,
    budgetMs: 18_000,
    elapsedMs: 5,
    text: { cleared: 1, finished: true },
    storage: {
      examined: 1,
      rowsCleared: 1,
      removed: 1,
      alreadyMissing: 0,
      sharedKept: 0,
      heldError: 0,
      notAttempted: 0,
      finished: true,
    },
    comments: { deleted: 0, finished: true },
    scores: { cleared: 0, finished: true },
    dueLeft: 0,
    ...over,
  };
}

test("#55a: describeCvPurge puts the verdict first, and says COMPLETE only when nothing is left", () => {
  assert.match(describeCvPurge("x", finishedResult()), /^\[cv-purge\] job x: COMPLETE/);
  const held = describeCvPurge(
    "x",
    finishedResult({
      complete: false,
      storage: { ...finishedResult().storage, heldError: 2 },
      dueLeft: 2,
    }),
  );
  assert.match(held, /^\[cv-purge\] job x: INCOMPLETE/);
  assert.match(held, /2 held on a storage error; due rows left=2/);
  const unknown = describeCvPurge("x", finishedResult({ complete: false, dueLeft: null }));
  assert.match(unknown, /due rows left: unknown/);
});

/* ── a failed read names where it was ─────────────────────── */

test("#55a: a failed storage page read throws with the cursor position, not an offset", async () => {
  // Find, by watching one clean run, which query reads the SECOND storage page.
  const probe = new FakeTable(dueRows(1200));
  install(probe, { errorPaths: oddPaths(dueRows(1200)) });
  const pages: { n: number; lastId: string }[] = [];
  probe.between = (n, returned) => {
    if (returned.length > 0 && returned.every((r) => "cv_path" in r && "cv_delete_after" in r)) {
      pages.push({ n, lastId: String(returned[returned.length - 1].id) });
    }
  };
  const quiet = captureLog();
  try {
    await runCvPurge({ id: "j7a", payload: {} });
  } finally {
    quiet.restore();
  }
  assert.ok(pages.length >= 2, "the run reads two storage pages");

  const apps = new FakeTable(dueRows(1200));
  const { storageCalls } = install(apps, { errorPaths: oddPaths(dueRows(1200)) });
  const client = (
    globalThis as { __fakeServiceClientForTests?: () => unknown }
  ).__fakeServiceClientForTests?.() as { storage: unknown };
  const failing = Object.assign(
    fakeClient(
      {
        job_applications: apps,
        talent_profiles: new FakeTable([]),
        client_batch_candidates: new FakeTable([]),
        hire_remote_profiles: new FakeTable([]),
        application_team_comments: new FakeTable([]),
      },
      { failOnQuery: pages[1].n },
    ),
    { storage: client.storage },
  );
  (globalThis as { __fakeServiceClientForTests?: () => unknown }).__fakeServiceClientForTests =
    () => failing;
  void storageCalls;
  const { restore } = captureLog();
  try {
    await assert.rejects(
      runCvPurge({ id: "j7", payload: {} }),
      new RegExp(
        `cv purge: after 2025-12-31T00:00:00\\+00:00 / ${pages[0].lastId}: connection reset`,
      ),
    );
  } finally {
    restore();
  }
});

/* ── #28: the deletion boundaries ────────────────────────────── */

/*
 * Every row dueRows() seeds has cv_delete_after set AND company_id_snapshot
 * set, so until these tests nothing had shown a protected row surviving a
 * run. Each boundary below is seeded next to a genuinely due row that IS
 * cleared, so a run that deleted nothing could not pass.
 *
 * The fake honours both guards the way Postgres does: its `lte` is false for
 * a null actual and its `not(col, "is", null)` excludes a null
 * (fake-table.ts, operator()). A protected row is therefore kept out by the
 * selector itself, not by anything a test arranges.
 */

const pathOf = (id: string) => `cvs/${id}.pdf`;

function row(
  id: string,
  fields: { cv_delete_after: string | null; company_id_snapshot: string | null },
) {
  return { id, cv_path: pathOf(id), cv_text: `text of ${id}`, ...fields };
}

const due = (id: string) => row(id, { cv_delete_after: PAST, company_id_snapshot: CO });

/** One run over `rows`, every row's object present in storage, siblings as given. */
async function purge(rows: ReturnType<typeof row>[], siblings?: Partial<Record<Sibling, Table>>) {
  const apps = new FakeTable(rows.map((r) => ({ ...r })));
  const { storageCalls, objects } = install(apps, {
    objects: new Set(rows.map((r) => r.cv_path)),
    siblings,
  });
  const { restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j28", payload: {} });
  } finally {
    restore();
  }
  return { apps, storageCalls, objects, result };
}

type World = Awaited<ReturnType<typeof purge>>;

const rowById = (apps: Table, id: string) => apps.rows.find((r) => r.id === id);

/** The row is exactly as seeded, its object is still in storage, and no remove named it. */
function assertUntouched(world: World, id: string, why: string) {
  const r = rowById(world.apps, id);
  assert.deepEqual(
    { cv_path: r?.cv_path, cv_text: r?.cv_text },
    { cv_path: pathOf(id), cv_text: `text of ${id}` },
    `${why}: the row was written`,
  );
  assert.ok(world.objects.has(pathOf(id)), `${why}: the object was removed from storage`);
  assert.ok(
    !world.storageCalls.some((paths) => paths.includes(pathOf(id))),
    `${why}: a remove named the path`,
  );
}

/** The row's path and text are gone, and so is its object. */
function assertCleared(world: World, id: string, why: string) {
  const r = rowById(world.apps, id);
  assert.deepEqual(
    { cv_path: r?.cv_path, cv_text: r?.cv_text },
    { cv_path: null, cv_text: null },
    `${why}: the due row was not cleared`,
  );
  assert.equal(world.objects.has(pathOf(id)), false, `${why}: the due row's object survived`);
}

/** A complete result's counts, so a protected row cannot hide inside a total. */
function counts(result: World["result"]) {
  assert.ok(result.complete, "the run must complete");
  return {
    text: result.text.cleared,
    examined: result.storage.examined,
    cleared: result.storage.rowsCleared,
    held: result.storage.heldError,
    objectsRemoved: result.storage.removed,
    objectsKept: result.storage.sharedKept,
  };
}

const ONE_DUE_ROW_CLEARED = {
  text: 1,
  examined: 1,
  cleared: 1,
  held: 0,
  objectsRemoved: 1,
  objectsKept: 0,
};

test("#28: a row with cv_delete_after NULL is never touched: a null date means keep forever", async () => {
  const world = await purge([
    due("app-due"),
    row("app-forever", { cv_delete_after: null, company_id_snapshot: CO }),
  ]);
  assertCleared(world, "app-due", "the due row");
  assertUntouched(world, "app-forever", "the keep-forever row");
  assert.deepEqual(counts(world.result), ONE_DUE_ROW_CLEARED, "the protected row is in no total");
});

test("#28: a row with company_id_snapshot NULL is never touched, even with its date expired: it is Remotiv's own", async () => {
  const world = await purge([
    due("app-due"),
    row("app-remotiv", { cv_delete_after: PAST, company_id_snapshot: null }),
  ]);
  assertCleared(world, "app-due", "the due row");
  assertUntouched(world, "app-remotiv", "the Remotiv-owned row");
  assert.deepEqual(counts(world.result), ONE_DUE_ROW_CLEARED, "the protected row is in no total");
});

test("#28: each guard alone is sufficient: a row that passes only ONE of the two survives, so only both failing together loses it", async () => {
  const world = await purge([
    due("app-due"),
    // Guard 1 (the date) passes this row; only guard 2 (the company) holds it.
    row("app-remotiv-expired", { cv_delete_after: PAST, company_id_snapshot: null }),
    // Guard 2 passes this row; only guard 1 holds it.
    row("app-company-forever", { cv_delete_after: null, company_id_snapshot: CO }),
  ]);
  assertCleared(world, "app-due", "the due row");
  assertUntouched(
    world,
    "app-remotiv-expired",
    "the null-company row, held by the company guard alone",
  );
  assertUntouched(world, "app-company-forever", "the null-date row, held by the date guard alone");
  assert.deepEqual(
    counts(world.result),
    ONE_DUE_ROW_CLEARED,
    "neither protected row is in a total",
  );
});

for (const table of SIBLINGS) {
  test(`#28: a path ${table} still names survives the purge: the row expires, the object is kept and counted`, async () => {
    const shared = due("app-shared");
    const world = await purge([shared], {
      [table]: new FakeTable([{ id: "other-row", cv_path: shared.cv_path }]),
    });
    const r = rowById(world.apps, "app-shared");
    assert.deepEqual(
      { cv_path: r?.cv_path, cv_text: r?.cv_text },
      { cv_path: null, cv_text: null },
      "the application still expires: its path and text go",
    );
    assert.ok(world.objects.has(shared.cv_path), `the object ${table} still names was removed`);
    assert.ok(
      !world.storageCalls.some((paths) => paths.includes(shared.cv_path)),
      "a remove named the shared path",
    );
    assert.deepEqual(counts(world.result), {
      text: 1,
      examined: 1,
      cleared: 1,
      held: 0,
      objectsRemoved: 0,
      objectsKept: 1,
    });
  });
}

test("#28: a due row's OWN reference is not 'shared': with no other row naming the path, the object goes and the row is cleared", async () => {
  // Two due rows on one page: both are in the self set, so neither counts as
  // the other's reference either. Siblings empty.
  const world = await purge([due("app-only-ref"), due("app-only-ref-2")]);
  assertCleared(world, "app-only-ref", "the first due row");
  assertCleared(world, "app-only-ref-2", "the second due row");
  assert.deepEqual(counts(world.result), {
    text: 2,
    examined: 2,
    cleared: 2,
    held: 0,
    objectsRemoved: 2,
    objectsKept: 0,
  });
});

/*
 * Source text only, on purpose. The fake's select() is a column projection
 * over one table with no parent, so `!inner` has no effect there: a
 * behavioural test would pass with the hint removed and prove nothing. The
 * real check, an impossible parent predicate matching zero rows against
 * production, is recorded at cv-purge.ts:422-427. What CAN be pinned here is
 * that the hint is still inside the one `.select()` that is called on
 * `.from("application_team_comments")` and feeds the delete. The assertion
 * walks the AST for exactly that call, so a comment or any other string
 * carrying the words cannot satisfy it.
 */
test("#28: the comments selector carries the !inner hint (source text; the fake cannot test the join)", () => {
  const src = readFileSync(new URL("./cv-purge.ts", import.meta.url), "utf8");
  const sf = ts.createSourceFile(
    "cv-purge.ts",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const selects: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "select"
    ) {
      const receiver = n.expression.expression;
      if (
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === "from" &&
        receiver.arguments.length === 1 &&
        ts.isStringLiteral(receiver.arguments[0]) &&
        receiver.arguments[0].text === "application_team_comments"
      ) {
        const arg = n.arguments[0];
        selects.push(
          arg && ts.isStringLiteralLike(arg)
            ? arg.text
            : `<not a string literal: ${arg?.getText(sf)}>`,
        );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.equal(
    selects.length,
    1,
    `expected exactly one .from("application_team_comments").select(...), found ${selects.length}`,
  );
  assert.ok(
    selects[0].includes("job_applications!inner("),
    `the comments selector lost its !inner hint: ${selects[0]}`,
  );
});

/* ── #91: the AI's words about an expired CV ─────────────────── */

/**
 * A full v4 scorecard on an application whose CV is due. The parent's two
 * guard columns are flattened onto the row under their embedded names, as the
 * comments tests do, because the fake evaluates the filter, not the join.
 */
function card(applicationId: string, parent: { due?: boolean; snapshot?: string | null } = {}) {
  return {
    application_id: applicationId,
    company_id: CO,
    job_id: "job-1",
    status: "scored",
    overall_score: 74,
    screening_score: 60,
    confidence: "medium",
    human_adjusted_score: 80,
    human_feedback: "Spoke to them; stronger than the card says.",
    adjusted_by: "member-1",
    adjusted_by_name: "A Recruiter",
    adjusted_at: "2026-02-01T00:00:00+00:00",
    // Generated in Postgres; the fake stores it so the test can see it is not written.
    effective_score: 80,
    ai_model: "model-x",
    prompt_version: "cv-v7",
    error: null,
    verdict: "Strong fit at Acme Corp; verify SQL depth",
    summary: "Eight years at Acme Corp in B2B sales.",
    evidence: [{ claim: "requirements_match", quote: "Led a team of 6 at Acme Corp" }],
    strengths: [{ point: "Team leadership", quote: "Led a team of 6 at Acme Corp" }],
    concerns: ["Role at Acme Corp was mostly account growth"],
    missing_requirements: ["SQL"],
    dimension_scores: [
      {
        dimension: "requirements_match",
        score: 70,
        reasoning: "Meets most",
        quote: "Led a team of 6",
      },
      { dimension: "experience_depth", score: 82, reasoning: "Eight years", quote: "2016-2024" },
      {
        dimension: "domain_relevance",
        score: 65,
        reasoning: "B2B",
        quote: "B2B sales",
        unstated: true,
      },
      { dimension: "responsibilities_fit", score: 77, reasoning: "Close", quote: "Owned pipeline" },
    ],
    must_haves: [
      { item: "Team leadership", status: "evidenced", quote: "Led a team of 6" },
      { item: "SQL", status: "not_found", quote: "" },
    ],
    "job_applications.cv_delete_after": parent.due === false ? "2099-01-01T00:00:00+00:00" : PAST,
    "job_applications.company_id_snapshot": parent.snapshot === undefined ? CO : parent.snapshot,
  };
}

const WORD_COLUMNS = new Set([
  "summary",
  "verdict",
  "evidence",
  "strengths",
  "concerns",
  "missing_requirements",
  "dimension_scores",
  "must_haves",
]);

async function purgeQuietly(scores: Table, apps: Table = new FakeTable([])) {
  install(apps, { scores });
  const { restore } = captureLog();
  try {
    return await runCvPurge({ id: "j91", payload: {} });
  } finally {
    restore();
  }
}

test("#91: the scores pass clears exactly the AI's words and nothing else", async () => {
  const before = card("app-1");
  const scores = new FakeTable([before]);
  const result = await purgeQuietly(scores);
  assert.ok(result.complete);
  assert.equal(result.scores.cleared, 1);

  const after = scores.rows[0];
  assert.equal(after.summary, null);
  assert.equal(after.verdict, null);
  assert.deepEqual(after.evidence, []);
  assert.deepEqual(after.strengths, []);
  assert.deepEqual(after.concerns, []);
  assert.deepEqual(after.missing_requirements, []);
  assert.deepEqual(after.dimension_scores, [
    { dimension: "requirements_match", score: 70, reasoning: "", quote: "" },
    { dimension: "experience_depth", score: 82, reasoning: "", quote: "" },
    { dimension: "domain_relevance", score: 65, reasoning: "", quote: "", unstated: true },
    { dimension: "responsibilities_fit", score: 77, reasoning: "", quote: "" },
  ]);
  assert.deepEqual(after.must_haves, [
    { item: "Team leadership", status: "evidenced", quote: "" },
    { item: "SQL", status: "not_found", quote: "" },
  ]);
  for (const [column, value] of Object.entries(before)) {
    if (WORD_COLUMNS.has(column)) continue;
    assert.deepEqual(after[column], value, `${column} is not the scores pass's to touch`);
  }
  assert.equal(scoreWordsLeft(after), false);
  assert.ok(
    !JSON.stringify(after).includes("Acme"),
    "no CV span or named employer survives anywhere on the card",
  );
});

test("#91: every score, the confidence, the status and every human_* column survive, so effective_score cannot move", async () => {
  const scores = new FakeTable([card("app-1")]);
  await purgeQuietly(scores);
  const after = scores.rows[0];
  assert.equal(after.overall_score, 74);
  assert.equal(after.screening_score, 60);
  assert.equal(after.confidence, "medium");
  assert.equal(after.status, "scored");
  assert.equal(after.human_adjusted_score, 80);
  assert.equal(after.human_feedback, "Spoke to them; stronger than the card says.");
  assert.equal(after.adjusted_by_name, "A Recruiter");
  assert.equal(after.effective_score, 80);
  for (const column of Object.keys(CV_SCORE_WORDS_CLEARED)) {
    assert.ok(WORD_COLUMNS.has(column), `${column} is a word column`);
  }
  assert.deepEqual(
    Object.keys(CV_SCORE_WORDS_CLEARED).filter((c) =>
      /score|status|confidence|^human_|^adjusted_/.test(c),
    ),
    [],
    "the cleared set names no column effective_score is derived from",
  );
});

test("#91: an already-clean card is not written again, and a second run clears nothing", async () => {
  const clean = {
    ...card("app-0"),
    ...CV_SCORE_WORDS_CLEARED,
    dimension_scores: [{ dimension: "requirements_match", score: 70, reasoning: "", quote: "" }],
    must_haves: [{ item: "SQL", status: "not_found", quote: "" }],
  };
  const dirty = card("app-1");
  const scores = new FakeTable([clean, dirty]);
  const first = await purgeQuietly(scores);
  assert.ok(first.complete);
  assert.equal(first.scores.cleared, 1, "only the dirty card was written");
  assert.equal(
    scores.rows[0].application_id,
    "app-0",
    "the clean card was not touched: an update moves a row",
  );

  const snapshot = structuredClone(scores.rows);
  const second = await purgeQuietly(scores);
  assert.ok(second.complete);
  assert.equal(second.scores.cleared, 0);
  assert.deepEqual(scores.rows, snapshot);
});

test("#91: a card whose CV is not due, or on Remotiv's own pool, keeps every word", async () => {
  const notDue = card("app-1", { due: false });
  const ownPool = card("app-2", { snapshot: null });
  const scores = new FakeTable([notDue, ownPool]);
  const result = await purgeQuietly(scores);
  assert.ok(result.complete);
  assert.equal(result.scores.cleared, 0);
  assert.deepEqual(scores.rows, [notDue, ownPool]);
});

test("#91: older shapes clear too: the v4 evidence envelope, a keyed dimension object, v1 bare strengths", async () => {
  const legacy = {
    ...card("app-1"),
    verdict: null,
    evidence: { v: 4, verdict: "Fit at Acme Corp", items: [{ claim: "x", quote: "Acme Corp" }] },
    strengths: ["Led a team at Acme Corp"],
    dimension_scores: {
      requirements_match: { score: 70, reasoning: "At Acme Corp", quote: "Acme" },
    },
  };
  const scores = new FakeTable([legacy]);
  await purgeQuietly(scores);
  const after = scores.rows[0];
  assert.deepEqual(after.evidence, []);
  assert.deepEqual(after.strengths, []);
  assert.deepEqual(after.dimension_scores, {
    requirements_match: { score: 70, reasoning: "", quote: "" },
  });
  assert.ok(!JSON.stringify(after).includes("Acme"));
});

test("#91: the scores pass pages by application_id and reaches every due card past one page", async () => {
  const many = Array.from({ length: 1203 }, (_, i) => card(`app-${String(i).padStart(5, "0")}`));
  const scores = new FakeTable(many);
  const result = await purgeQuietly(scores);
  assert.ok(result.complete);
  assert.equal(result.scores.cleared, 1203);
  assert.equal(scores.rows.filter((r) => scoreWordsLeft(r)).length, 0);
});

test("#91: a budget that runs out during the scores pass is reported as that, with nothing claimed", async () => {
  const comments = new FakeTable([]);
  const scores = new FakeTable([card("app-1")]);
  const apps = new FakeTable([]);
  install(apps, { comments, scores });
  let nowMs = 0;
  comments.between = () => {
    nowMs += 50_000;
  };
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j92", payload: {} }, { budgetMs: 18_000, clock: () => nowMs });
  } finally {
    restore();
  }
  assert.ok(!result.complete);
  assert.equal(result.scores.finished, false);
  assert.equal(result.scores.cleared, 0);
  assert.equal(scoreWordsLeft(scores.rows[0]), true, "nothing was cleared; the report says so");
  assert.match(log[0], /reached before the end of: scores/);
});

test("#91: the scores selector carries the !inner hint (source text; the fake cannot test the join)", () => {
  const src = readFileSync(new URL("./cv-purge.ts", import.meta.url), "utf8");
  const at = src.indexOf('.from("application_scores")\n      .select(');
  assert.ok(at > 0, "the scores pass reads application_scores");
  const read = src.slice(at, at + 800);
  assert.ok(
    read.includes("job_applications!inner(cv_delete_after, company_id_snapshot)"),
    "the scores selector lost its !inner hint",
  );
  assert.match(
    read,
    /\.lte\("job_applications\.cv_delete_after", now\)\s*\.not\("job_applications\.company_id_snapshot", "is", null\)/,
    "the same two guards as the comments pass",
  );
});

/* ── #60: the storage pass ────────────────────────────────── */

const day = (d: number) =>
  `2025-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}T00:00:00+00:00`;

// Negative control: put the storage pass back to OLDEST first and the newer
// due row is never reached while the held pile lasts.
test("#60: a pile of held rows across several runs never starves a newer due row", async () => {
  // 1,500 old rows whose storage errors every time (held, forever, on purpose),
  // and on each run one new row that became due after all of them.
  const pile = Array.from({ length: 1500 }, (_, i) => ({
    id: `held-${String(i).padStart(5, "0")}`,
    cv_path: `cvs/held-${i}.pdf`,
    cv_text: null,
    cv_delete_after: day(i % 200),
    company_id_snapshot: CO,
  }));
  const apps = new FakeTable(pile.map((r) => ({ ...r })));
  const objects = new Set<string>();
  install(apps, { objects, errorPaths: new Set(pile.map((r) => r.cv_path)) });
  for (let run = 0; run < 3; run++) {
    const fresh = {
      id: `new-${run}`,
      cv_path: `cvs/new-${run}.pdf`,
      cv_text: `text of new-${run}`,
      cv_delete_after: day(300 + run),
      company_id_snapshot: CO,
    };
    apps.rows.push({ ...fresh });
    objects.add(fresh.cv_path);
    // A clock that allows one storage page (500 rows) per run, then cuts.
    let nowMs = 0;
    let storagePages = 0;
    apps.between = (_n, returned) => {
      if (returned.some((r) => "cv_path" in r && "cv_delete_after" in r)) {
        storagePages += 1;
        if (storagePages >= 2) nowMs += 50_000;
      }
    };
    const { restore } = captureLog();
    try {
      await runCvPurge({ id: `j60-${run}`, payload: {} }, { budgetMs: 18_000, clock: () => nowMs });
    } finally {
      restore();
    }
    const r = apps.rows.find((x) => x.id === fresh.id);
    assert.deepEqual(
      { cv_path: r?.cv_path, cv_text: r?.cv_text },
      { cv_path: null, cv_text: null },
      `run ${run}: the newer due row was reached and cleared despite the held pile`,
    );
    assert.equal(objects.has(fresh.cv_path), false, `run ${run}: its file was removed`);
  }
});

// Negative control: drop the existence check and an already-missing file
// keeps its row held for ever.
test("#60: a file already missing from storage is cleared, not held for ever", async () => {
  const apps = new FakeTable([due("app-gone"), due("app-here")]);
  const { infoCalls } = install(apps, { objects: new Set([pathOf("app-here")]) });
  const { restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j60m", payload: {} });
  } finally {
    restore();
  }
  assert.equal(rowById(apps, "app-gone")?.cv_path, null, "the missing file's path is cleared");
  assert.equal(rowById(apps, "app-here")?.cv_path, null);
  assert.deepEqual(infoCalls, [pathOf("app-gone")], "only the unconfirmed path was checked");
  assert.deepEqual(
    { removed: result.storage.removed, alreadyMissing: result.storage.alreadyMissing },
    { removed: 1, alreadyMissing: 1 },
  );
  assert.equal(result.complete, true);
});

// Negative control: treat any info() error as "missing" and the errored row
// is cleared, stranding a file that may still exist.
test("#60: a storage error stays held (fail closed): the path is kept and the run is not complete", async () => {
  const apps = new FakeTable([due("app-error"), due("app-ok")]);
  install(apps, {
    objects: new Set([pathOf("app-error"), pathOf("app-ok")]),
    errorPaths: new Set([pathOf("app-error")]),
  });
  const { log, restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge({ id: "j60e", payload: {} });
  } finally {
    restore();
  }
  assert.equal(rowById(apps, "app-error")?.cv_path, pathOf("app-error"), "the path is kept");
  assert.equal(rowById(apps, "app-error")?.cv_text, null, "its text still went, in the text pass");
  assert.equal(rowById(apps, "app-ok")?.cv_path, null);
  assert.equal(result.storage.heldError, 1);
  assert.equal(result.complete, false);
  assert.equal(result.dueLeft, 1);
  assert.match(log[0], /INCOMPLETE/);
  assert.doesNotMatch(log[0], /COMPLETE in/);
});

// Negative control: run the text pass inside the storage pass (after the
// files) and a storage stop leaves text behind.
test("#60: the text pass runs first: a storage pass cut at once still leaves no due text", async () => {
  const rows = dueRows(40);
  const apps = new FakeTable(rows);
  install(apps, { objects: oddPaths(rows) });
  let nowMs = 0;
  apps.between = (_n, returned) => {
    if (returned.some((r) => "cv_path" in r && "cv_delete_after" in r)) nowMs += 50_000;
  };
  const { restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge(
      { id: "j60t", payload: {} },
      { budgetMs: 18_000, clock: () => nowMs },
    );
  } finally {
    restore();
  }
  assert.equal(apps.rows.filter((r) => r.cv_text !== null).length, 0);
  assert.equal(result.text.cleared, 40);
  assert.equal(result.storage.notAttempted, 20);
  assert.equal(result.complete, false);
});

test("#60: the storage pass has a guaranteed share: a slow text pass cannot take the whole budget", async () => {
  const rows = dueRows(2000);
  const apps = new FakeTable(rows);
  install(apps, { objects: oddPaths(rows) });
  // Every text page costs 3 s of an 18 s budget: the text pass may use only
  // its quarter (4.5 s), so the storage pass still starts.
  let nowMs = 0;
  apps.between = (_n, returned) => {
    if (returned.length > 0 && returned.every((r) => !("cv_path" in r))) nowMs += 3_000;
  };
  const { restore } = captureLog();
  let result: Awaited<ReturnType<typeof runCvPurge>>;
  try {
    result = await runCvPurge(
      { id: "j60s", payload: {} },
      { budgetMs: 18_000, clock: () => nowMs },
    );
  } finally {
    restore();
  }
  assert.equal(result.text.finished, false, "the text pass stopped at its share");
  assert.ok(result.storage.examined > 0, "the storage pass ran in its own share");
  assert.ok(result.storage.removed > 0);
  assert.equal(result.complete, false);
});

// Negative control: move the sweep back after `await runCvPurge(job)` with no
// finally, and a purge that throws skips it.
test("#60: the orphan sweep still runs when the purge throws, and the purge's error still reaches the queue", async () => {
  const apps = new FakeTable(dueRows(4));
  const { storageCalls } = install(apps);
  const client = (
    globalThis as { __fakeServiceClientForTests?: () => unknown }
  ).__fakeServiceClientForTests?.() as { storage: unknown };
  const failing = Object.assign(fakeClient({ job_applications: apps }, { failOnQuery: 1 }), {
    storage: client.storage,
  });
  (globalThis as { __fakeServiceClientForTests?: () => unknown }).__fakeServiceClientForTests =
    () => failing;
  void storageCalls;
  const errors: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  try {
    await assert.rejects(handleCvPurge({ id: "j60x", payload: {} }), /cv purge: text page/);
  } finally {
    console.error = realError;
    console.log = realLog;
  }
  assert.ok(
    errors.some((l) => l.startsWith("[cv-orphan-sweep] job j60x")),
    "the sweep ran (its own line was written) after the purge threw",
  );
});
