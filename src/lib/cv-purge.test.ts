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
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import ts from "typescript";

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
    siblings?: Partial<Record<Sibling, Table>>;
  } = {},
) {
  const objects = opts.objects ?? new Set<string>();
  const tables = {
    job_applications: apps,
    talent_profiles: opts.siblings?.talent_profiles ?? new FakeTable([]),
    client_batch_candidates: opts.siblings?.client_batch_candidates ?? new FakeTable([]),
    hire_remote_profiles: opts.siblings?.hire_remote_profiles ?? new FakeTable([]),
    application_team_comments: opts.comments ?? new FakeTable([]),
  };
  const storageCalls: string[][] = [];
  const client = Object.assign(fakeClient(tables), {
    storage: {
      from: (_bucket: string) => ({
        async remove(paths: string[]) {
          storageCalls.push(paths);
          const gone = paths.filter((p) => objects.has(p));
          for (const p of gone) objects.delete(p);
          return { data: gone.map((name) => ({ name })), error: null };
        },
      }),
    },
  });
  (globalThis as { __fakeServiceClientForTests?: () => unknown }).__fakeServiceClientForTests =
    () => client;
  return { storageCalls, objects };
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
    examined: result.examined,
    cleared: result.cleared,
    unconfirmed: result.unconfirmed,
    objectsRemoved: result.objectsRemoved,
    objectsKept: result.objectsKept,
  };
}

const ONE_DUE_ROW_CLEARED = {
  examined: 1,
  cleared: 1,
  unconfirmed: 0,
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
      examined: 1,
      cleared: 1,
      unconfirmed: 0,
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
    examined: 2,
    cleared: 2,
    unconfirmed: 0,
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
