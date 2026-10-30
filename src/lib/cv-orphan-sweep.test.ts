/**
 * The CV bucket's orphan sweep (cv-orphan-sweep.ts), the last phase of
 * cv_purge. The database and bucket are fake-live-db.mjs.
 *
 *   node --test src/lib/cv-orphan-sweep.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = { "server-only": "" };
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  runCvOrphanSweep,
  describeCvOrphanSweep,
  folderGroup,
  CV_ORPHAN_GRACE_MS,
  CV_ORPHAN_MAX_DELETES,
  CV_ORPHAN_MAX_SHARE,
} = await import("./cv-orphan-sweep.ts");
const { fakeLiveDb } = await import("../test-support/fake-live-db.mjs");

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-30T09:00:00.000Z");
const JOB = "2d4a8cde-0000-4000-8000-0000000000a1";
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LEGACY_URL = (path) => `https://project.example.co/storage/v1/object/public/cvs/${path}`;

/** Named, one per table; a legacy-URL-only row; and `orphans` files no row names, old enough. */
function world({ orphans = 3, filler = 40 } = {}) {
  const NAMED = {
    job_applications: `${JOB}/${key(1)}.pdf`,
    talent_profiles: `talent/cvs/${key(2)}.pdf`,
    client_batch_candidates: `batch/${key(3)}/${key(4)}.pdf`,
    hire_remote_profiles: `hire-remote/cvs/${key(5)}.pdf`,
  };
  const LEGACY = `manual/${key(6)}.pdf`;
  const YOUNG = `manual/${key(7)}.pdf`;
  const UNDATED = `manual/${key(8)}.pdf`;
  const ORPHANS = Array.from({ length: orphans }, (_, i) => `manual/${key(100 + i)}.pdf`);
  const FILLER = Array.from({ length: filler }, (_, i) => `${JOB}/${key(500 + i)}.pdf`);
  const db = fakeLiveDb({
    job_applications: [
      { id: key(1001), cv_path: NAMED.job_applications, cv_url: null },
      // A legacy row: no cv_path, only the old public URL.
      { id: key(1002), cv_path: null, cv_url: LEGACY_URL(LEGACY) },
      ...FILLER.map((p, i) => ({ id: key(2000 + i), cv_path: p, cv_url: null })),
    ],
    talent_profiles: [{ id: key(1003), cv_path: NAMED.talent_profiles, cv_url: null }],
    client_batch_candidates: [
      { id: key(1004), cv_path: NAMED.client_batch_candidates, cv_url: null },
    ],
    hire_remote_profiles: [{ id: key(1005), cv_path: NAMED.hire_remote_profiles, cv_url: null }],
  });
  const put = (path, createdAt) =>
    db.objects.set(path, { bytes: new Uint8Array([1]), contentType: "application/pdf", createdAt });
  for (const p of [...Object.values(NAMED), LEGACY, ...ORPHANS, ...FILLER]) put(p, NOW - 40 * DAY);
  put(YOUNG, NOW - 6 * DAY);
  put(UNDATED, null);
  return { db, NAMED, LEGACY, YOUNG, UNDATED, ORPHANS };
}

const sweep = (db, opts = {}, service = db.service) =>
  runCvOrphanSweep(service, { now: () => NOW, ...opts });

test("dry run by default: counts only, nothing deleted; only the exact word turns it on", async () => {
  const before = process.env.CV_ORPHAN_SWEEP_LIVE;
  try {
    for (const value of [undefined, "", "1", "TRUE", "yes", " true"]) {
      if (value === undefined) delete process.env.CV_ORPHAN_SWEEP_LIVE;
      else process.env.CV_ORPHAN_SWEEP_LIVE = value;
      const w = world();
      const size = w.db.objects.size;
      const r = await sweep(w.db);
      assert.equal(r.live, false, JSON.stringify(value));
      assert.equal(r.deleted, 3, "would delete");
      assert.equal(w.db.objects.size, size, "nothing deleted");
    }
    process.env.CV_ORPHAN_SWEEP_LIVE = "true";
    const w = world();
    assert.equal((await sweep(w.db)).live, true);
    assert.equal(
      w.ORPHANS.some((p) => w.db.objects.has(p)),
      false,
    );
  } finally {
    if (before === undefined) delete process.env.CV_ORPHAN_SWEEP_LIVE;
    else process.env.CV_ORPHAN_SWEEP_LIVE = before;
  }
});

test("live: only old files no row names go; one reference from any one table keeps a file", async () => {
  const w = world();
  const r = await sweep(w.db, { live: true });
  assert.deepEqual(
    { stopped: r.stopped, unreferenced: r.unreferenced, deleted: r.deleted, young: r.young },
    { stopped: null, unreferenced: 3, deleted: 3, young: 2 },
  );
  for (const p of w.ORPHANS) assert.equal(w.db.objects.has(p), false, p);
  for (const [table, p] of Object.entries(w.NAMED))
    assert.ok(w.db.objects.has(p), `named by ${table}`);
  assert.ok(w.db.objects.has(w.LEGACY), "named only by a legacy public cv_url");
});

test("a file younger than 7 days, or with no timestamp, is never judged", async () => {
  const w = world();
  await sweep(w.db, { live: true });
  assert.ok(w.db.objects.has(w.YOUNG), "6 days old");
  assert.ok(w.db.objects.has(w.UNDATED), "no timestamp reads as new");
  assert.equal(CV_ORPHAN_GRACE_MS, 7 * DAY);
});

test("a reference read that fails deletes nothing, before the judging or at the fresh check", async () => {
  for (const table of [
    "job_applications",
    "talent_profiles",
    "client_batch_candidates",
    "hire_remote_profiles",
  ]) {
    const w = world();
    w.db.failNext(table, "select");
    const size = w.db.objects.size;
    const r = await sweep(w.db, { live: true });
    assert.equal(r.stopped, "reference_read_failed", table);
    assert.equal(w.db.objects.size, size, `${table}: nothing deleted`);
  }
  // At the fresh check right before the delete: the clock's second read comes just before it.
  const w = world();
  let reads = 0;
  const size = w.db.objects.size;
  const r = await sweep(w.db, {
    live: true,
    now: () => {
      reads += 1;
      if (reads === 2) w.db.failNext("hire_remote_profiles", "select");
      return NOW;
    },
  });
  assert.equal(r.stopped, "reference_read_failed");
  assert.equal(w.db.objects.size, size, "nothing deleted");
});

test("a file a row starts to name after the listing is kept at the fresh check", async () => {
  const w = world();
  let reads = 0;
  const r = await sweep(w.db, {
    live: true,
    now: () => {
      reads += 1;
      if (reads === 2) {
        w.db.tables.talent_profiles.push({ id: key(1009), cv_path: w.ORPHANS[0], cv_url: null });
      }
      return NOW;
    },
  });
  assert.equal(r.keptAtRecheck, 1);
  assert.equal(r.deleted, 2);
  assert.ok(w.db.objects.has(w.ORPHANS[0]));
});

test("more than 20% of the bucket unreferenced: nothing is deleted at all", async () => {
  assert.equal(CV_ORPHAN_MAX_SHARE, 0.2);
  // 12 orphans of 12 + 4 named + legacy + young + undated + 40 filler = 59 files: 20.3%.
  const w = world({ orphans: 12 });
  const size = w.db.objects.size;
  const r = await sweep(w.db, { live: true });
  assert.equal(r.stopped, "too_many_unreferenced");
  assert.equal(r.unreferenced, 12);
  assert.equal(r.deleted, 0);
  assert.equal(w.db.objects.size, size);
  // 11 of 58 (19%) is under the line and goes.
  const under = world({ orphans: 11 });
  assert.equal((await sweep(under.db, { live: true })).deleted, 11);
});

test("the cap: never more than the maximum per run, the rest left for the next run", async () => {
  assert.equal(CV_ORPHAN_MAX_DELETES, 500);
  const w = world({ orphans: 10 });
  const r = await sweep(w.db, { live: true, maxDeletes: 4 });
  assert.equal(r.stopped, "cap");
  assert.equal(r.deleted, 4);
  assert.equal(w.ORPHANS.filter((p) => w.db.objects.has(p)).length, 6);
  const again = await sweep(w.db, { live: true, maxDeletes: 4 });
  assert.equal(again.deleted, 4);
});

test("a listing that fails, or a delete that fails, stops the sweep", async () => {
  const w = world();
  const broken = {
    ...w.db.service,
    from: w.db.service.from.bind(w.db.service),
    storage: {
      from: (b) => ({
        ...w.db.service.storage.from(b),
        list: async () => ({ data: null, error: { message: "unreachable" } }),
      }),
    },
  };
  const size = w.db.objects.size;
  assert.equal((await sweep(w.db, { live: true }, broken)).stopped, "listing_failed");
  assert.equal(w.db.objects.size, size);
  const failingRemove = {
    ...w.db.service,
    from: w.db.service.from.bind(w.db.service),
    storage: {
      from: (b) => ({
        ...w.db.service.storage.from(b),
        remove: async () => ({ data: null, error: { message: "denied" } }),
      }),
    },
  };
  assert.equal((await sweep(w.db, { live: true }, failingRemove)).stopped, "delete_failed");
});

test("the log line carries counts by folder group and age band, never a path", async () => {
  const w = world();
  const r = await sweep(w.db);
  assert.deepEqual(r.byGroup, { manual: 3 });
  assert.deepEqual(r.byAge, { "30-180d": 3 });
  const line = describeCvOrphanSweep("job-1", r);
  assert.match(line, /DRY RUN/);
  assert.match(line, /would delete=3/);
  assert.doesNotMatch(line, /\.pdf|[0-9a-f]{8}-[0-9a-f]{4}/);
  assert.deepEqual(
    [
      `${JOB}/x.pdf`,
      "manual/x.pdf",
      "batch/b/x.pdf",
      "talent/cvs/x.pdf",
      "hire-remote/cvs/x.pdf",
      "x.pdf",
    ].map(folderGroup),
    ["job folder", "manual", "batch", "talent/cvs", "hire-remote/cvs", "other"],
  );
});

test("wiring: the cv_purge job runs the sweep last, and a sweep failure never fails the purge", () => {
  const src = readFileSync(new URL("./cv-purge.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function handleCvPurge("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const purge = body.indexOf("await runCvPurge(job);");
  const sweepAt = body.indexOf("await runCvOrphanSweep(createServiceClient())");
  assert.ok(purge > 0 && sweepAt > purge, "purge, then the sweep");
  assert.match(body, /\} catch \{/);
  const sweepSrc = readFileSync(new URL("./cv-orphan-sweep.ts", import.meta.url), "utf8");
  assert.match(sweepSrc, /process\.env\.CV_ORPHAN_SWEEP_LIVE === "true"/);
});
