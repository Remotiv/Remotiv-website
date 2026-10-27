/**
 * LIVE: does the sentinel's protection actually hold, on the real staging project?
 *
 *   npm run staging:access
 *   (node --env-file=.env.staging --test scripts/staging/access.live-test.mjs)
 *
 * Deliberately named *.live-test.mjs so the offline glob "*.test.mjs" never
 * picks it up: it needs .env.staging and a network. Read-only. Every client is
 * built here or by guard.mjs; nothing is written; nothing is printed but
 * variable names, bucket names, counts and PostgREST error CODES.
 *
 * The step-3 SQL grants staging_guard to service_role only, enables RLS, and
 * revokes from public, anon and authenticated. A schema on the Data API whose
 * protection nobody has watched hold is the same class of thing as a guard
 * nobody has seen fail, so this watches it: service_role reads one row equal
 * to the pin; anon and both authenticated accounts obtain NO contents, by
 * grant (42501) or by RLS (zero rows), and cannot call usage().
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import {
  assertAccountFree,
  assertAccountUsable,
  ACCOUNTS as STAGING_ACCOUNTS,
} from "./accounts.mjs";
import { loadPin, openStaging, signInStagingAccount } from "./guard.mjs";
import { assertPinIsReal } from "./guard-checks.mjs";
import { SENTINEL_SCHEMA, SENTINEL_TABLE, USAGE_FUNCTION } from "./guard-db-checks.mjs";
import { uuidFrom } from "./seed-plan.mjs";

export const BUCKETS = [
  "cvs",
  "company-logos",
  "talent_photos",
  "interview-videos",
  "final-interview-recordings",
];

const env = process.env;
let service;
let anon;
let owner;
let scoped;

const clientOpts = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

before(async () => {
  ({ service } = await openStaging({ intent: "harness" }));
  anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, clientOpts);
  owner = await signInStagingAccount({
    emailVar: "STAGING_TEST_EMAIL",
    passwordVar: "STAGING_TEST_PASSWORD",
  });
  scoped = await signInStagingAccount({
    emailVar: "STAGING_SCOPED_EMAIL",
    passwordVar: "STAGING_SCOPED_PASSWORD",
  });
});

/** A client that presents a signed-in user's token: the `authenticated` role. */
const asUser = (session) =>
  createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    ...clientOpts,
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });

const readSentinel = (client) =>
  client
    .schema(SENTINEL_SCHEMA)
    .from(SENTINEL_TABLE)
    .select("project_ref_sha256, purpose")
    .limit(2);

/** Asserts a read yielded NO contents, and says which mechanism refused it. */
function assertNoContents({ data, error }, who) {
  const rows = Array.isArray(data) ? data.length : 0;
  assert.ok(
    error !== null || rows === 0,
    `${who} OBTAINED ${rows} sentinel row(s). The grants or RLS from step 3 do not hold.`,
  );
  if (error) {
    // The code only. A PostgREST message can carry the request path.
    console.log(`  ${who}: refused by grant/RLS, PostgREST code ${error.code ?? "(none)"}`);
  } else {
    console.log(`  ${who}: refused by RLS, 0 rows`);
  }
}

test("service_role reads exactly one sentinel row, equal to the pin in git", async () => {
  const { data, error } = await readSentinel(service);
  assert.equal(error, null, `service_role read failed with code ${error?.code}`);
  assert.equal(data.length, 1, `expected exactly one row, read ${data.length}`);
  assert.equal(data[0].project_ref_sha256, assertPinIsReal(loadPin()));
  assert.ok(data[0].purpose, "the row has no purpose text");
});

test("anon CANNOT obtain the sentinel's contents", async () => {
  assertNoContents(await readSentinel(anon), "anon");
});

test("the owner account (authenticated) CANNOT obtain the sentinel's contents", async () => {
  assertNoContents(await readSentinel(asUser(owner.session)), "authenticated (owner)");
});

test("the scoped account (authenticated) CANNOT obtain the sentinel's contents", async () => {
  assertNoContents(await readSentinel(asUser(scoped.session)), "authenticated (scoped)");
});

test("anon and authenticated cannot call staging_guard.usage()", async () => {
  for (const [who, client] of [
    ["anon", anon],
    ["authenticated", asUser(owner.session)],
  ]) {
    const { data, error } = await client.schema(SENTINEL_SCHEMA).rpc(USAGE_FUNCTION);
    assert.ok(error !== null, `${who} CALLED usage() and got ${JSON.stringify(data)}`);
    console.log(`  ${who}: usage() refused, PostgREST code ${error.code ?? "(none)"}`);
  }
});

test("service_role can call usage() and both figures are numbers", async () => {
  const { data, error } = await service.schema(SENTINEL_SCHEMA).rpc(USAGE_FUNCTION);
  assert.equal(error, null, `usage() failed with code ${error?.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  assert.equal(typeof row.db_bytes, "number");
  console.log(
    `  usage(): db ${(row.db_bytes / 1_048_576).toFixed(1)} MB, wal ${
      row.wal_bytes === null
        ? "unreadable (dashboard)"
        : `${(row.wal_bytes / 1_048_576).toFixed(1)} MB`
    }`,
  );
});

test("the five storage buckets exist", async () => {
  const { data, error } = await service.storage.listBuckets();
  assert.equal(error, null, "listBuckets failed");
  const names = new Set((data ?? []).map((b) => b.name));
  const missing = BUCKETS.filter((b) => !names.has(b));
  assert.deepEqual(missing, [], `buckets missing in staging: ${missing.join(", ")}`);
  console.log(`  buckets: all ${BUCKETS.length} present`);
});

/**
 * Both accounts exist (sign-in succeeded in before()) and are in one of the
 * two states the pipeline accepts: FREE before the seed, or USABLE after it,
 * judged the way company-access.ts judges it. Anything else, such as a
 * membership in some other company or the wrong role, fails here with the
 * variable named, rather than deep in a browser login.
 */
test("both test accounts exist and are FREE (pre-seed) or USABLE (post-seed), nothing else", async () => {
  const fixture = uuidFrom("company");
  for (const [a, account] of [
    [STAGING_ACCOUNTS[0], owner],
    [STAGING_ACCOUNTS[1], scoped],
  ]) {
    let state;
    try {
      await assertAccountFree(service, { userId: account.userId, emailVar: a.emailVar });
      state = "FREE: no membership yet; the seed writes it";
    } catch (freeErr) {
      try {
        const u = await assertAccountUsable(service, {
          userId: account.userId,
          emailVar: a.emailVar,
          fixtureCompanyId: fixture,
          role: a.role,
        });
        state = `USABLE: ${u.role} of the fixture company`;
      } catch (usableErr) {
        assert.fail(
          `${a.emailVar} is neither free nor usable:\n  ${freeErr.message}\n  ${usableErr.message}`,
        );
      }
    }
    console.log(`  ${a.emailVar}: signed in, ${state}`);
  }
});
