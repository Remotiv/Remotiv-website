/**
 * The staging guard's pure checks: env in, thrown Error out.
 *
 * Split out of guard.mjs so they can be tested with a fabricated env and no
 * network. The two checks that need the database (the sentinel row, and the
 * target table being empty) stay in guard.mjs, which injects a client.
 *
 * ── Nothing here ever prints a secret ────────────────────────
 *
 * Not the value, not a prefix, not a truncated sample, not a pattern label, and
 * not the project ref — a ref identifies the project and belongs in the same
 * category. Comparisons are made between SHA-256 hashes so a mismatch can be
 * reported as "does not match the pin" with no fragment of either side in the
 * message. Note also that execFileSync/execSync embed the whole argv in their
 * error text, which is why nothing here shells out.
 *
 * ── Why src/lib/supabase/guard.ts cannot do this job ─────────
 *
 * That guard is a different instrument. assertServiceClientAllowed() no-ops
 * once NODE_ENV is anything but "development", and what it consults is
 * SUPABASE_PROJECT_ENV — a variable the environment declares about itself. A
 * .env file copied from production and relabelled "staging" satisfies it
 * completely. The check below instead compares the project identity against a
 * hash committed to git, which a mislabelled env file cannot satisfy.
 */

import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export const OPT_IN_VAR = "REMOTIV_STAGING_WRITES_APPROVED";
export const OPT_IN_VALUE = "yes-i-have-read-scripts-staging-README-steps";

/**
 * What approved-identity.json ships with before step 3 of the README is done.
 *
 * Deliberately 64 hex characters, so it PASSES the format half below. That is
 * what makes the not-placeholder half provable: with a non-hex placeholder the
 * format check refused it first, and removing the placeholder check changed
 * nothing anyone could observe. A guard that cannot be shown to fail is not a
 * guard. "deadbeef" repeated is recognisable as a placeholder to a human and
 * indistinguishable from a real hash to a regex, which is exactly the point.
 */
export const PIN_PLACEHOLDER = "deadbeef".repeat(8);
const PIN_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * A pin is usable only when BOTH halves hold: it is a 64-character hex string,
 * AND it is not the placeholder the file ships with.
 *
 * Either half alone is useless. The format check passes the shipped
 * placeholder and any plausible 64-hex fake someone pastes in. The
 * not-placeholder check passes the word "todo". Together they reject the two
 * states a careless edit actually produces, and that is why this is one
 * function with two conditions rather than two tests someone can delete one
 * of. The message names the variable, never the value.
 */
export function assertPinIsReal(pin) {
  const value = pin?.projectRefSha256;
  if (
    typeof value !== "string" ||
    !PIN_HEX.test(value) ||
    value.toLowerCase() === PIN_PLACEHOLDER
  ) {
    throw new Error(
      "approved-identity.json has no usable projectRefSha256. Run step 3 of " +
        "README-steps.md to compute it. An unset pin must not pass.",
    );
  }
  return value.toLowerCase();
}

/**
 * Variables whose PRESENCE re-enables a paid or outbound path.
 *
 * Grouped by what each group switches back on, because the error message names
 * the consequence rather than just the variable. Verified against shipped
 * source: the four model chokepoints throw without their key, five more
 * pre-check and return a no_key failure, and the queue drains only through a
 * worker route that refuses every request when CRON_SECRET is unset.
 */
export const MUST_BE_ABSENT = {
  "paid model calls": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  "queued background work": ["CRON_SECRET"],
  "outbound messaging": [
    "RESEND_API_KEY",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "RECALL_API_KEY",
    "RECALL_RECORDING_ENABLED",
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_CALENDAR_CLIENT_SECRET",
  ],
};

/**
 * The project ref out of a Supabase URL, with no logging of either.
 *
 * Throws on anything that is not a Supabase project host, because a silent
 * fallback here would let a guard pass against an arbitrary endpoint.
 */
export function projectRef(rawUrl, varName) {
  if (typeof rawUrl !== "string" || rawUrl === "") {
    throw new Error(`${varName} is not set`);
  }
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new Error(`${varName} is not a valid URL`);
  }
  if (!host.endsWith(".supabase.co") && !host.endsWith(".supabase.in")) {
    throw new Error(`${varName} does not point at a Supabase project host`);
  }
  const ref = host.split(".")[0];
  if (!ref) throw new Error(`${varName} has no project ref in its hostname`);
  return ref;
}

/** 1. The operator opted in, with the exact phrase. A typo must not be a near-miss. */
export function checkOptIn(env) {
  if (env[OPT_IN_VAR] !== OPT_IN_VALUE) {
    throw new Error(
      `${OPT_IN_VAR} is not set to the exact opt-in value. This script writes ` +
        `10,000 rows; it does not run by accident. See scripts/staging/README-steps.md.`,
    );
  }
}

/** 2. No key that would re-enable a paid or outbound path is present. */
export function checkKeysAbsent(env) {
  const found = [];
  for (const [consequence, vars] of Object.entries(MUST_BE_ABSENT)) {
    for (const v of vars) {
      if (env[v] !== undefined && env[v] !== "") found.push(`${v} (re-enables ${consequence})`);
    }
  }
  if (found.length > 0) {
    throw new Error(
      `${found.length} variable(s) that must be absent are set:\n  ${found.join("\n  ")}\n` +
        `Remove them from the staging env file. Variable names only above — no values are read.`,
    );
  }
}

/**
 * 3. No NEXT_PUBLIC_ variable carries the service role key.
 *
 * Compared by hash, so neither the key nor any part of it is ever formatted
 * into a message. A NEXT_PUBLIC_ variable is shipped to the browser, so this
 * would be a service-role key published to every visitor.
 */
export function checkServiceKeyNotPublic(env) {
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const target = sha256(service);
  const leaked = Object.keys(env)
    .filter((k) => k.startsWith("NEXT_PUBLIC_"))
    .filter((k) => typeof env[k] === "string" && env[k] !== "" && sha256(env[k]) === target);
  if (leaked.length > 0) {
    throw new Error(
      `${leaked.join(", ")} holds the same value as SUPABASE_SERVICE_ROLE_KEY. ` +
        `NEXT_PUBLIC_ variables are served to the browser.`,
    );
  }
}

/**
 * 4. The project this env points at is the one pinned in git.
 *
 * The pin is a hash in scripts/staging/approved-identity.json, so the approved
 * project can be committed without committing anything that identifies it.
 */
export function checkRefMatchesPin(env, pin) {
  const expected = assertPinIsReal(pin);
  const ref = projectRef(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
  if (sha256(ref) !== expected) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL does not point at the project pinned in " +
        "scripts/staging/approved-identity.json. Refusing to write.",
    );
  }
}

/**
 * 5. The Next.js app points at the same project as this script.
 *
 * The app reads its own environment. A correctly-pointed seed script and an
 * app still pointed at production is exactly the failure this catches, and it
 * is invisible to every other check here. Parity only — the browser-side proof
 * that the RUNNING app agrees is a separate mechanism, because a variable in a
 * file is a claim and a response from the server is evidence.
 */
export function checkAppUrlParity(env) {
  const seedRef = projectRef(env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL");
  const appRef = projectRef(env.STAGING_APP_SUPABASE_URL, "STAGING_APP_SUPABASE_URL");
  if (sha256(seedRef) !== sha256(appRef)) {
    throw new Error(
      "STAGING_APP_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL are different " +
        "projects. The app under test and the data being seeded must be the same one.",
    );
  }
}

/** All five, in order. Identity before connection, every time. */
export function runPureChecks(env, pin) {
  checkOptIn(env);
  checkKeysAbsent(env);
  checkServiceKeyNotPublic(env);
  checkRefMatchesPin(env, pin);
  checkAppUrlParity(env);
}

/**
 * Every seeded job must disable scoring EXPLICITLY.
 *
 * `cv-scoring.ts:1527` reads `ai_cv_scoring_enabled === false` and
 * `applicants/actions.ts:1147` reads `!== false`. Under both, NULL means
 * ENABLED, so a seeded job that leaves the column unset will be scored the
 * moment anything drains the queue.
 *
 * The empty-list refusal is the point: `[].filter(...)` returns no offenders,
 * which reads identically to a clean seed. This function has no way to tell
 * "all 18 jobs are explicitly false" from "I was handed nothing" unless it
 * asks, so it asks.
 */
export function assertScoringDisabled(jobRows) {
  if (!Array.isArray(jobRows) || jobRows.length === 0) {
    throw new Error(
      "assertScoringDisabled was given no jobs. A filter over an empty list " +
        "reports zero offenders, which is indistinguishable from a clean seed.",
    );
  }
  const bad = jobRows.filter((j) => j.ai_cv_scoring_enabled !== false);
  if (bad.length > 0) {
    throw new Error(
      `${bad.length} of ${jobRows.length} seeded job(s) do not set ` +
        `ai_cv_scoring_enabled to false. NULL is ENABLED on both read paths, ` +
        `so this must be explicit.`,
    );
  }
  return jobRows.length;
}
