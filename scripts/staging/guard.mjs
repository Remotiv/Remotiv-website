/**
 * The gate every staging script passes through before it holds a client.
 *
 *   import { openStaging } from "./guard.mjs";
 *   const { service } = await openStaging({ intent: "seed" });
 *
 * Nothing in this directory may construct a Supabase client itself. This module
 * is the only place that does, and it returns one only after every check has
 * passed. It no longer CONTAINS those checks: they live in guard-checks.mjs
 * (env only) and guard-db-checks.mjs (over an injected client), so that each
 * one can be driven with a fabricated env or a stub and proven to fail when the
 * thing it guards is wrong. See guard-checks.test.mjs and guard-db-checks.test.mjs.
 *
 * What is left here is the part that cannot be tested offline and must not be
 * duplicated anywhere: reading the real environment, loading the pin, building
 * the client, and the ORDER.
 *
 * ── WHY NOT src/lib/supabase/guard.ts ────────────────────────
 *
 * Because it cannot do this job. It is a no-op whenever NODE_ENV is not
 * "development", so on any deployed or CI-like run it checks nothing at all —
 * and what it does check is SUPABASE_PROJECT_ENV, a variable the environment
 * sets about itself. An environment file that says "I am staging" is not
 * evidence that it is; it is the same claim read back.
 *
 * ── THE THREE INDEPENDENT ASSERTIONS ─────────────────────────
 *
 *   1. git        — scripts/staging/approved-identity.json, committed.
 *   2. the env    — the project ref the connection actually resolves to.
 *   3. the DB     — a sentinel row the connected database returns about itself.
 *
 * All three must agree. (1) cannot be changed by editing .env.staging and (3)
 * cannot be changed by editing the repo, so production fails at (3) even if
 * someone forges (1) and (2). A fourth, separate assertion belongs to the
 * harness: proof from the RUNNING app that it reads this same project. A
 * variable in a file is a claim; a response from the server is evidence.
 *
 * ── ORDER IS PART OF THE DESIGN ──────────────────────────────
 *
 * Every env check runs before a client exists. An operator who has not opted
 * in is told that and nothing else, and no identity check reads a key until
 * consent and the absence of paid/outbound keys are both settled.
 *
 * ── NOTHING IS EVER PRINTED ──────────────────────────────────
 *
 * No ref, no key, no URL, no fragment, no "starts with" sample. Comparisons are
 * between SHA-256 hashes and failures name the VARIABLE. `cut -c1-12` of a
 * secret is still part of the secret, and an execFileSync error embeds the whole
 * argv — so this module shells out to nothing. Note also that env values are
 * passed through UNTRIMMED: the opt-in is an exact phrase, and silently
 * trimming here would make this module disagree with the tested definition.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { MUST_BE_ABSENT, OPT_IN_VAR, runPureChecks } from "./guard-checks.mjs";
import {
  assertSentinel,
  assertTargetEmpty,
  SENTINEL_SCHEMA,
  SENTINEL_TABLE,
} from "./guard-db-checks.mjs";

// fileURLToPath, not .pathname: this checkout's path contains spaces, which a
// URL percent-encodes and fs does not decode.
const PIN_PATH = fileURLToPath(new URL("./approved-identity.json", import.meta.url));

export function loadPin() {
  return JSON.parse(readFileSync(PIN_PATH, "utf8"));
}

/**
 * Run every check, then hand back a service client.
 *
 * `intent` is "seed" or "harness". The seed is the only one permitted to write
 * and the only one that gets the emptiness check — a harness run against
 * already-seeded data is the normal case.
 */
export async function openStaging({ intent }) {
  if (intent !== "seed" && intent !== "harness") {
    throw new Error('openStaging: intent must be "seed" or "harness"');
  }

  const env = process.env;
  const pin = loadPin();
  const say = (n, msg) => console.log(`  [${n}] ${msg}`);
  console.log(`staging guard - intent: ${intent}`);

  // ── 1-5, env only, no client in existence yet ──
  runPureChecks(env, pin);
  say(1, `${OPT_IN_VAR} is the exact opt-in phrase`);
  say(2, `all ${Object.values(MUST_BE_ABSENT).flat().length} paid/outbound variables absent`);
  say(3, "the service-role key is in no NEXT_PUBLIC_ variable");
  say(4, `the project ref matches the pin in git (${pin.label})`);
  say(5, "the app's Supabase URL resolves to the same project");

  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── 6 — the database asserts its own identity ──
  say(6, `${SENTINEL_SCHEMA}.${SENTINEL_TABLE} agrees: ${await assertSentinel(service, pin)}`);

  // ── 7 — the seed does not run on top of existing data ──
  if (intent === "seed") {
    say(7, `the target table holds ${await assertTargetEmpty(service, env)} rows`);
  }

  console.log("staging guard: all checks passed\n");
  opened = true;
  return { service, projectRefSha256: pin.projectRefSha256.toLowerCase() };
}

let opened = false;

/**
 * Sign in a staging test account with the anon key, after the guard has passed.
 *
 * The second and last place in this directory that constructs a client. It
 * refuses to run before openStaging() has, so a sign-in can never happen
 * against a project the guard has not identified. Returns the user id and the
 * session; the session is for building the cookie the probe routes read and
 * is never printed. Errors name the VARIABLES, never their values.
 *
 * @param {{ emailVar: string, passwordVar: string }} names env variable names
 */
export async function signInStagingAccount({ emailVar, passwordVar }) {
  if (!opened) {
    throw new Error("signInStagingAccount called before openStaging(); identity is unproven");
  }
  const env = process.env;
  for (const v of [emailVar, passwordVar, "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    if (!env[v]) throw new Error(`${v} is not set`);
  }
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await anon.auth.signInWithPassword({
    email: env[emailVar],
    password: env[passwordVar],
  });
  if (error || !data?.session || !data?.user) {
    // Not the Supabase error text: it can echo the email address.
    throw new Error(
      `could not sign in the account in ${emailVar}. Check that it exists in the STAGING ` +
        `project's auth users and that ${passwordVar} is its password.`,
    );
  }
  return { userId: data.user.id, email: env[emailVar], session: data.session };
}

// Re-exported so callers keep importing the guard, not its internals. The
// functions themselves live in guard-checks.mjs and guard-db-checks.mjs, where
// they are tested without pulling the Supabase SDK into a test process.
export { assertScoringDisabled } from "./guard-checks.mjs";
export { assertQueueEmpty, assertUsageWithinLimits } from "./guard-db-checks.mjs";
