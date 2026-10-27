/**
 * Negative controls for the database-backed guard checks, with a stub client.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * No network, no project, no SDK. The stub records what was asked for, which
 * schema it was asked in, and returns whatever the test wants. That is the
 * only way to drive the cases that matter: a read that errors, a read that
 * succeeds and returns nothing, a count that comes back null, and a usage
 * figure nobody could read.
 *
 * ── What a false pass would look like here ───────────────────
 *
 *   assertSentinel           an EMPTY sentinel table accepted, because no row
 *                            in it disagrees with the pin. Prevented by checking
 *                            the row count before comparing any row's content.
 *                            Or: the sentinel read from PUBLIC, where a restore
 *                            of public could have dropped it, so the check
 *                            passes against whatever public happens to hold.
 *   assertTargetEmpty        a null count read as zero, because `null > 0` is
 *                            false. Prevented by requiring typeof "number".
 *   assertQueueEmpty         the same null-as-zero, on the table that proves
 *                            the seed had no side effects.
 *   assertUsageWithinLimits  a null size compared with `>=` and found to be
 *                            "under" the limit.
 *
 * Every one is the same defect as the four vacuous test guards and the seventh
 * instance Waleed named: a check over nothing passes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PIN_PLACEHOLDER } from "./guard-checks.mjs";
import {
  assertQueueEmpty,
  assertSentinel,
  assertTargetEmpty,
  assertUsageWithinLimits,
  QUEUE_TABLE,
  RESEED_VALUE,
  RESEED_VAR,
  SENTINEL_SCHEMA,
  SENTINEL_TABLE,
  TARGET_TABLE,
  USAGE_FUNCTION,
  USAGE_LIMITS,
  WAL_BY_DASHBOARD_VALUE,
  WAL_BY_DASHBOARD_VAR,
} from "./guard-db-checks.mjs";

const PIN_HASH = "a".repeat(64);
const pin = (h = PIN_HASH) => ({ projectRefSha256: h, label: "remotiv-staging" });
const MB = 1024 * 1024;

/**
 * A client that returns one canned result and records table AND schema.
 *
 * `.from()` on the bare client records schema "public", because that is what
 * a real PostgREST client does when nobody called `.schema()`. The sentinel
 * check must never appear there. `.select()` is both awaitable and chainable
 * because the sentinel read ends in `.limit(2)` and the count reads end at
 * `.select(...)`.
 */
function stub(result, { rpc = result } = {}) {
  const calls = [];
  const rpcs = [];
  const from = (schema) => (table) => {
    calls.push({ schema, table });
    return {
      select: () =>
        Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) }),
    };
  };
  return {
    calls,
    rpcs,
    from: from("public"),
    schema: (name) => ({
      from: from(name),
      rpc: (fn) => {
        rpcs.push({ schema: name, fn });
        return Promise.resolve(rpc);
      },
    }),
  };
}

/** A client with no `.schema()` at all: the shape of an SDK that can only read public. */
function publicOnlyStub(result) {
  const s = stub(result);
  const { schema: _dropped, ...rest } = s;
  return rest;
}

async function rejectsWith(promise, needle, why) {
  let caught;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `DID NOT REJECT: ${why}`);
  assert.match(
    caught.message,
    needle,
    `rejected, but not for the stated reason (${why}): ${caught.message}`,
  );
  return caught;
}

/* ───────────────────────── assertSentinel ──────────────────────── */

test("assertSentinel accepts exactly one agreeing row, and reads the right table", async () => {
  const client = stub({
    data: [{ project_ref_sha256: PIN_HASH, purpose: "load test" }],
    error: null,
  });
  assert.equal(await assertSentinel(client, pin()), "load test");
  assert.deepEqual(client.calls, [{ schema: SENTINEL_SCHEMA, table: SENTINEL_TABLE }]);
});

test("assertSentinel reads the sentinel from the staging_guard schema, never public", async () => {
  // The restore writes to public and only public. A sentinel read from public
  // is a sentinel the restore could have replaced, so the schema is part of
  // what makes this check evidence. Two assertions: the recorded schema, and
  // the refusal of a client that cannot address a schema at all.
  const client = stub({ data: [{ project_ref_sha256: PIN_HASH, purpose: "p" }], error: null });
  await assertSentinel(client, pin());
  assert.equal(client.calls.length, 1, "exactly one read");
  assert.equal(client.calls[0].schema, "staging_guard");
  assert.notEqual(client.calls[0].schema, "public");

  await rejectsWith(
    assertSentinel(
      publicOnlyStub({ data: [{ project_ref_sha256: PIN_HASH }], error: null }),
      pin(),
    ),
    /has no \.schema\(\)/,
    "a client that can only read public must be refused, not used",
  );
});

test("assertSentinel rejects an EMPTY sentinel table", async () => {
  // The vacuous case. No row in an empty table disagrees with the pin.
  await rejectsWith(
    assertSentinel(stub({ data: [], error: null }), pin()),
    /holds 0\./,
    "an empty table is not agreement, it is the absence of a claim",
  );
});

test("assertSentinel rejects more than one row", async () => {
  const two = [
    { project_ref_sha256: PIN_HASH, purpose: "a" },
    { project_ref_sha256: PIN_HASH, purpose: "b" },
  ];
  await rejectsWith(
    assertSentinel(stub({ data: two, error: null }), pin()),
    /must hold exactly one row; it holds 2/,
    "two rows means the sentinel is being edited",
  );
});

test("assertSentinel rejects a row that disagrees with the pin", async () => {
  await rejectsWith(
    assertSentinel(stub({ data: [{ project_ref_sha256: "b".repeat(64) }], error: null }), pin()),
    /disagrees with the pin in git/,
    "production forging the repo side must still fail here",
  );
});

test("assertSentinel rejects a read error instead of treating it as absence", async () => {
  await rejectsWith(
    assertSentinel(stub({ data: null, error: { message: "relation does not exist" } }), pin()),
    /could not read staging_guard\.sentinel/,
    "a missing table, or an unexposed schema, is not a database to write to",
  );
});

test("assertSentinel does not leak the PostgREST error, which embeds the project URL", async () => {
  const err = await rejectsWith(
    assertSentinel(
      stub({
        data: null,
        error: { message: "GET https://SECRETREF.supabase.co/rest/v1/x failed" },
      }),
      pin(),
    ),
    /could not read/,
    "the error path must still refuse",
  );
  assert.doesNotMatch(
    err.message,
    /SECRETREF/,
    "AGENTS.md: a project-identifying URL is in the credential category",
  );
  assert.equal(
    err.cause,
    undefined,
    "a cause chain would carry the request URL into the printed stack",
  );
});

test("assertSentinel rejects a non-array result rather than inferring identity", async () => {
  await rejectsWith(
    assertSentinel(stub({ data: { project_ref_sha256: PIN_HASH }, error: null }), pin()),
    /returned no array/,
    "a shape change must not be read as one agreeing row",
  );
});

test("assertSentinel refuses an unset pin before it reads anything", async () => {
  const client = stub({ data: [{ project_ref_sha256: PIN_HASH }], error: null });
  // The placeholder is hex-shaped on purpose, so it is the case that only the
  // not-placeholder half catches; "z" x 64 is the case only the format half does.
  for (const bad of [
    undefined,
    {},
    { projectRefSha256: PIN_PLACEHOLDER },
    { projectRefSha256: PIN_PLACEHOLDER.toUpperCase() },
    { projectRefSha256: "z".repeat(64) },
  ]) {
    await rejectsWith(
      assertSentinel(client, bad),
      /no usable pin/,
      `pin ${JSON.stringify(bad)} must not pass`,
    );
  }
  assert.deepEqual(client.calls, [], "the pin is validated before a single round trip");
});

test("assertSentinel accepts an uppercase pin", async () => {
  const client = stub({ data: [{ project_ref_sha256: PIN_HASH, purpose: "ok" }], error: null });
  assert.equal(await assertSentinel(client, pin(PIN_HASH.toUpperCase())), "ok");
});

/* ──────────────────────── assertTargetEmpty ────────────────────── */

test("assertTargetEmpty accepts an empty target, and reads the right table", async () => {
  const client = stub({ count: 0, error: null });
  assert.equal(await assertTargetEmpty(client, {}), 0);
  assert.deepEqual(client.calls, [{ schema: "public", table: TARGET_TABLE }]);
});

test("assertTargetEmpty rejects a NULL count instead of reading it as zero", async () => {
  // `null > 0` is false. Without the typeof check this is a silent pass, and
  // the seed then doubles a table it believes is empty.
  for (const count of [null, undefined, "0"]) {
    await rejectsWith(
      assertTargetEmpty(stub({ count, error: null }), {}),
      /not a number/,
      `count ${JSON.stringify(count)} must not read as empty`,
    );
  }
});

test("assertTargetEmpty rejects existing rows without the explicit override", async () => {
  const err = await rejectsWith(
    assertTargetEmpty(stub({ count: 10_000, error: null }), {}),
    /already holds 10,000 rows/,
    "a second seed run doubles every figure the harness asserts",
  );
  assert.match(
    err.message,
    new RegExp(`${RESEED_VAR}=${RESEED_VALUE}`),
    "the message must name the way out",
  );
});

test("assertTargetEmpty honours the override only on its exact value", async () => {
  const client = () => stub({ count: 10_000, error: null });
  assert.equal(await assertTargetEmpty(client(), { [RESEED_VAR]: RESEED_VALUE }), 10_000);
  for (const v of ["YES", "true", "1", " yes"]) {
    await rejectsWith(
      assertTargetEmpty(client(), { [RESEED_VAR]: v }),
      /already holds/,
      `${JSON.stringify(v)} is not the opt-in value`,
    );
  }
});

test("assertTargetEmpty rejects a count error rather than proceeding", async () => {
  await rejectsWith(
    assertTargetEmpty(stub({ count: null, error: { message: "boom" } }), {}),
    /could not count job_applications/,
    "an unknown row count is not a known-empty table",
  );
});

/* ───────────────────────── assertQueueEmpty ────────────────────── */

test("assertQueueEmpty accepts an empty queue, and reads background_jobs in public", async () => {
  const client = stub({ count: 0, error: null });
  assert.equal(await assertQueueEmpty(client), 0);
  assert.deepEqual(client.calls, [{ schema: "public", table: QUEUE_TABLE }]);
});

test("assertQueueEmpty rejects a non-empty queue", async () => {
  // The measurement behind keeping migration 040's enqueueing trigger. Three
  // reasons say it cannot fire during a seed; this is what says it did not.
  await rejectsWith(
    assertQueueEmpty(stub({ count: 1, error: null })),
    /holds 1 row\(s\) after the seed/,
    "one queued row is one side effect the seed was not supposed to have",
  );
});

test("assertQueueEmpty rejects a NULL count instead of reading it as zero", async () => {
  for (const count of [null, undefined]) {
    await rejectsWith(
      assertQueueEmpty(stub({ count, error: null })),
      /not a number/,
      `count ${JSON.stringify(count)} must not read as an empty queue`,
    );
  }
});

test("assertQueueEmpty rejects a count error rather than certifying the queue", async () => {
  await rejectsWith(
    assertQueueEmpty(stub({ count: null, error: { message: "boom" } })),
    /could not count background_jobs/,
    "an unreadable queue is not a provably empty one",
  );
});

/* ───────────────────── assertUsageWithinLimits ─────────────────── */

const usage = (row) => stub({ data: null, error: null }, { rpc: { data: [row], error: null } });

test("assertUsageWithinLimits calls staging_guard.usage() and returns MB figures", async () => {
  const client = usage({ db_bytes: 60 * MB, wal_bytes: 200 * MB, slot_retained_bytes: 0 });
  assert.deepEqual(await assertUsageWithinLimits(client, {}), { dbMb: 60, walMb: 200, slotMb: 0 });
  assert.deepEqual(client.rpcs, [{ schema: SENTINEL_SCHEMA, fn: USAGE_FUNCTION }]);
});

test("assertUsageWithinLimits rejects a database size at or over the threshold", async () => {
  await rejectsWith(
    assertUsageWithinLimits(usage({ db_bytes: USAGE_LIMITS.dbBytes, wal_bytes: 0 }), {}),
    /database size is 400 MB, at or over the 400 MB abort threshold/,
    "the quota is the first limit",
  );
});

test("assertUsageWithinLimits rejects a WAL directory at or over the threshold", async () => {
  await rejectsWith(
    assertUsageWithinLimits(usage({ db_bytes: 1, wal_bytes: USAGE_LIMITS.walBytes }), {}),
    /WAL directory is 1024 MB/,
    "the disk is the second limit, independent of the quota",
  );
});

test("assertUsageWithinLimits rejects a slot retaining too much WAL", async () => {
  await rejectsWith(
    assertUsageWithinLimits(
      usage({ db_bytes: 1, wal_bytes: 1, slot_retained_bytes: USAGE_LIMITS.slotRetainedBytes }),
      {},
    ),
    /replication slot is retaining 512 MB/,
    "a slot pins WAL that checkpoints cannot recycle",
  );
});

test("assertUsageWithinLimits rejects a null db size instead of reading it as small", async () => {
  // `null >= limit` is false, so without the typeof check a size nobody read
  // would pass as "under the quota".
  await rejectsWith(
    assertUsageWithinLimits(usage({ db_bytes: null, wal_bytes: 0 }), {}),
    /no numeric db_bytes/,
    "an unread size is not a small size",
  );
});

test("assertUsageWithinLimits rejects an unreadable WAL figure unless the dashboard is being watched", async () => {
  const unreadable = () => usage({ db_bytes: 1, wal_bytes: null, slot_retained_bytes: null });
  const err = await rejectsWith(
    assertUsageWithinLimits(unreadable(), {}),
    /could not read the WAL directory/,
    "pg_ls_waldir may be refused to this role; the seed must not assume",
  );
  assert.match(err.message, new RegExp(`${WAL_BY_DASHBOARD_VAR}=${WAL_BY_DASHBOARD_VALUE}`));
  assert.deepEqual(
    await assertUsageWithinLimits(unreadable(), { [WAL_BY_DASHBOARD_VAR]: WAL_BY_DASHBOARD_VALUE }),
    { dbMb: 0, walMb: null, slotMb: null },
  );
  await rejectsWith(
    assertUsageWithinLimits(unreadable(), { [WAL_BY_DASHBOARD_VAR]: "YES" }),
    /could not read the WAL directory/,
    "only the exact value is consent",
  );
});

test("assertUsageWithinLimits rejects an rpc error rather than proceeding blind", async () => {
  const client = stub(
    { data: null, error: null },
    { rpc: { data: null, error: { message: "x" } } },
  );
  await rejectsWith(
    assertUsageWithinLimits(client, {}),
    /could not call staging_guard\.usage\(\)/,
    "no usage function means no visibility of either limit",
  );
});
