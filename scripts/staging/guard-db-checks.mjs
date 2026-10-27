/**
 * The staging-guard checks that need the database, over an INJECTED client.
 *
 * Nothing here constructs a client or imports the Supabase SDK. Each function
 * takes whatever object exposes `.schema(name).from(table).select(...)` or
 * `.schema(name).rpc(fn)` and nothing more, which is what lets
 * guard-db-checks.test.mjs drive them with a stub and prove each one fails
 * when its premise fails: offline, with no project to point at.
 *
 * ── The failure mode all of these are shaped around ──────────
 *
 * A read that errors and a read that returns nothing are different events, and
 * the dangerous one is the second. `{ data: [], error: null }` is a successful
 * read of an empty table, and every "does the sentinel agree" test written over
 * it passes: there is no row that disagrees. So no function below is allowed to
 * conclude anything from an empty, absent or null result. The count is
 * established first, and only then is content compared.
 *
 * ── Why the sentinel lives in its own schema ─────────────────
 *
 * `staging_guard`, not `public`. The restore in README-steps.md step 4 writes
 * only to public, so no restore of public can drop the sentinel and nobody has
 * to remember to recreate it. Reading it through PostgREST needs the schema on
 * the project's exposed-schemas list, a human step in Supabase settings
 * (README step 3). Without it the read errors and this module refuses: fail
 * closed means nothing runs, never something running unguarded.
 *
 * Nothing here prints a ref, a hash fragment, a PostgREST error or a URL.
 */

import { assertPinIsReal } from "./guard-checks.mjs";

export const SENTINEL_SCHEMA = "staging_guard";
export const SENTINEL_TABLE = "sentinel";
export const USAGE_FUNCTION = "usage";
export const TARGET_TABLE = "job_applications";
export const QUEUE_TABLE = "background_jobs";
export const RESEED_VAR = "STAGING_RESEED_OVER_EXISTING";
export const RESEED_VALUE = "yes";
export const WAL_BY_DASHBOARD_VAR = "STAGING_WAL_BY_DASHBOARD";
export const WAL_BY_DASHBOARD_VALUE = "yes";

const MB = 1024 * 1024;

/**
 * Abort thresholds, well inside both free-plan limits.
 *
 *   database   400 MB of the 500 MB quota. Exceeding the quota puts the project
 *              into read-only after a grace period, which would strand a
 *              half-seed in a database nobody can truncate.
 *   WAL dir    1 GB of the 2 GB disk. WAL lives on the disk, not in the quota.
 *   slot       512 MB retained by any one replication slot. A lagging slot pins
 *              WAL that checkpoints would otherwise recycle.
 */
export const USAGE_LIMITS = {
  dbBytes: 400 * MB,
  walBytes: 1024 * MB,
  slotRetainedBytes: 512 * MB,
};

function sentinelReader(client) {
  if (typeof client?.schema !== "function") {
    throw new Error(
      `the client has no .schema(); the sentinel lives in ${SENTINEL_SCHEMA}, not public, ` +
        `and a client that can only read public cannot prove identity.`,
    );
  }
  return client.schema(SENTINEL_SCHEMA);
}

/**
 * The database asserts its own identity.
 *
 * This is the one assertion that cannot be forged from the repository or from
 * an environment file: production has no `staging_guard` schema, so a
 * production connection fails here even if someone has edited the pin AND
 * relabelled the env. `.limit(2)` rather than a single-row read, because
 * "exactly one row" is part of what is being checked: two rows means someone
 * has been editing the sentinel, which is not a database to write to.
 */
export async function assertSentinel(client, pin) {
  // The same two-half definition of "usable" the env check uses, so the two
  // cannot drift: 64 hex characters AND not the (hex-shaped) placeholder.
  let expected;
  try {
    expected = assertPinIsReal(pin);
  } catch {
    throw new Error(
      "assertSentinel was given no usable pin. Comparing the database's claim " +
        "against an unset expectation would pass. Run step 3 of README-steps.md.",
    );
  }

  const { data, error } = await sentinelReader(client)
    .from(SENTINEL_TABLE)
    .select("project_ref_sha256, purpose")
    .limit(2);

  if (error) {
    // Deliberately not `cause: error`: a PostgREST error can carry the request
    // URL, and that URL contains the project ref.
    throw new Error(
      `could not read ${SENTINEL_SCHEMA}.${SENTINEL_TABLE}. On a fresh staging project, ` +
        `create it and add "${SENTINEL_SCHEMA}" to the exposed schemas first (README-steps.md ` +
        `step 3). On a database that should already have it, STOP: a connection with no ` +
        `sentinel is not one this script may write to.`,
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `${SENTINEL_TABLE} read returned no array. Refusing to infer identity from it.`,
    );
  }
  if (data.length !== 1) {
    throw new Error(
      `${SENTINEL_SCHEMA}.${SENTINEL_TABLE} must hold exactly one row; it holds ${data.length}. ` +
        `Zero means this is not the approved staging project: an empty table ` +
        `has no row that disagrees, which is why the count is checked first.`,
    );
  }
  if (data[0].project_ref_sha256 !== expected) {
    throw new Error(
      `${SENTINEL_SCHEMA}.${SENTINEL_TABLE} disagrees with the pin in git. The connected ` +
        `database does not identify itself as the approved staging project.`,
    );
  }
  return data[0].purpose ?? "(no purpose recorded)";
}

/** A `count: "exact", head: true` read, refusing a null count rather than reading it as zero. */
async function exactCount(client, table, why) {
  const { count, error } = await client.from(table).select("id", { count: "exact", head: true });
  if (error) throw new Error(`could not count ${table}; ${why}`);
  if (typeof count !== "number") {
    throw new Error(
      `${table} count came back ${JSON.stringify(count)}, not a number. ` +
        `null > 0 is false, so this would otherwise read as an empty table.`,
    );
  }
  return count;
}

/**
 * The seed does not run on top of existing rows.
 *
 * Not a production safeguard, assertSentinel settled that, but against a second
 * seed run doubling every figure the harness then asserts against the manifest.
 */
export async function assertTargetEmpty(client, env) {
  const count = await exactCount(client, TARGET_TABLE, "refusing to seed");
  if (count > 0 && env[RESEED_VAR] !== RESEED_VALUE) {
    throw new Error(
      `${TARGET_TABLE} already holds ${count.toLocaleString("en-US")} rows. Seeding ` +
        `on top of them makes every harness figure meaningless. Truncate first, or ` +
        `set ${RESEED_VAR}=${RESEED_VALUE} if you know the rows are from a previous ` +
        `run of this same script.`,
    );
  }
  return count;
}

/**
 * Nothing the seed did enqueued work.
 *
 * The restored schema keeps one trigger that inserts into background_jobs
 * (final_interview_bots_orphan_guard, migration 040), and three reasons say it
 * cannot fire during a seed: the seed writes no bot rows, nothing deletes one,
 * and the queue has no drain without CRON_SECRET. Three reasons are an
 * argument. This is the measurement: the queue is read after the seed and must
 * be empty. A null count is refused, not read as zero.
 */
export async function assertQueueEmpty(client) {
  const count = await exactCount(client, QUEUE_TABLE, "the seed cannot prove nothing was enqueued");
  if (count > 0) {
    throw new Error(
      `${QUEUE_TABLE} holds ${count.toLocaleString("en-US")} row(s) after the seed. Something ` +
        `the seed did enqueued work. Inspect the rows before anything drains them; do not ` +
        `run the harness over a seed that had side effects.`,
    );
  }
  return count;
}

/**
 * Both free-plan limits, read from the database through staging_guard.usage().
 *
 * The 500 MB quota and the 2 GB disk are independent: WAL lives on the disk
 * and is not counted in the quota, so a seed can sit far under one limit while
 * filling the other. `usage()` returns both, plus the most WAL any replication
 * slot is retaining. Every figure must be a number before it is compared:
 * `null > limit` is false, so a null would read as "within limits".
 *
 * The one permitted null is `wal_bytes`, and only with an explicit statement
 * that the operator is watching WAL on the dashboard's disk report instead,
 * because pg_ls_waldir() may not be executable by the project's postgres role.
 * That statement is a variable name, never a value.
 */
export async function assertUsageWithinLimits(client, env, limits = USAGE_LIMITS) {
  const { data, error } = await sentinelReader(client).rpc(USAGE_FUNCTION);
  if (error) {
    throw new Error(
      `could not call ${SENTINEL_SCHEMA}.${USAGE_FUNCTION}(). It is created with the sentinel ` +
        `(README-steps.md step 3); without it the seed cannot see either limit and refuses.`,
    );
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.db_bytes !== "number") {
    throw new Error(
      `${USAGE_FUNCTION}() returned no numeric db_bytes. A size nobody read is not a size under ` +
        `the limit.`,
    );
  }
  if (row.db_bytes >= limits.dbBytes) {
    throw new Error(
      `database size is ${Math.round(row.db_bytes / MB)} MB, at or over the ${Math.round(
        limits.dbBytes / MB,
      )} MB abort threshold. Stop and truncate before the 500 MB quota makes the project read-only.`,
    );
  }

  if (typeof row.wal_bytes !== "number") {
    if (env[WAL_BY_DASHBOARD_VAR] !== WAL_BY_DASHBOARD_VALUE) {
      throw new Error(
        `${USAGE_FUNCTION}() could not read the WAL directory (pg_ls_waldir is not executable ` +
          `by this role). Watch WAL on the dashboard's disk report and set ` +
          `${WAL_BY_DASHBOARD_VAR}=${WAL_BY_DASHBOARD_VALUE} to say so; the seed will not ` +
          `assume an unread figure is small.`,
      );
    }
  } else if (row.wal_bytes >= limits.walBytes) {
    throw new Error(
      `WAL directory is ${Math.round(row.wal_bytes / MB)} MB, at or over the ${Math.round(
        limits.walBytes / MB,
      )} MB abort threshold on a 2 GB disk. Stop; let checkpoints recycle before continuing.`,
    );
  }

  const retained = row.slot_retained_bytes;
  if (typeof retained === "number" && retained >= limits.slotRetainedBytes) {
    throw new Error(
      `a replication slot is retaining ${Math.round(retained / MB)} MB of WAL, at or over the ` +
        `${Math.round(limits.slotRetainedBytes / MB)} MB threshold. Checkpoints cannot recycle ` +
        `what a slot pins; stop and look at pg_replication_slots.`,
    );
  }

  return {
    dbMb: Math.round(row.db_bytes / MB),
    walMb: typeof row.wal_bytes === "number" ? Math.round(row.wal_bytes / MB) : null,
    slotMb: typeof retained === "number" ? Math.round(retained / MB) : null,
  };
}
