/**
 * Negative controls for the five pure staging-guard checks.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * Every env below is fabricated in this file. Nothing is read from a .env, no
 * real key or project ref appears here, and no check in guard-checks.mjs
 * touches the network — which is the whole reason they were split out of
 * guard.mjs.
 *
 * ── What a false pass would look like, per check ──────────────
 *
 *   checkOptIn                 a near-miss phrase treated as consent
 *   checkKeysAbsent            one of eleven variables not in the loop
 *   checkServiceKeyNotPublic   the service key published to every visitor
 *   checkRefMatchesPin         the UNSET pin passing, so any project passes
 *   checkAppUrlParity          a seeded staging DB and an app on production
 *
 * The fourth is the one that would have been missed. `approved-identity.json`
 * ships with `projectRefSha256: "REPLACE_ME_WITH_THE_HASH_FROM_STEP_4"`, and a
 * guard that compared that string to a real hash would simply report a
 * mismatch — indistinguishable from pointing at the wrong project, and silently
 * passing the moment someone "fixed" it by copying the observed hash in. The
 * length check is what makes an unfilled pin its own named failure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPinIsReal,
  assertScoringDisabled,
  checkAppUrlParity,
  checkKeysAbsent,
  checkOptIn,
  checkRefMatchesPin,
  checkServiceKeyNotPublic,
  MUST_BE_ABSENT,
  OPT_IN_VALUE,
  OPT_IN_VAR,
  PIN_PLACEHOLDER,
  projectRef,
  runPureChecks,
  sha256,
} from "./guard-checks.mjs";

function throwsWith(fn, needle, why) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `DID NOT THROW: ${why}`);
  assert.match(
    caught.message,
    needle,
    `threw, but not for the stated reason (${why}): ${caught.message}`,
  );
}

/** A fabricated env that passes all five checks, so each test can break exactly one thing. */
const FAKE_REF = "abcdefghijklmnopqrst";
const FAKE_SERVICE = "fabricated-not-a-key-service-role";
function validEnv(overrides = {}) {
  return {
    [OPT_IN_VAR]: OPT_IN_VALUE,
    SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE,
    NEXT_PUBLIC_SUPABASE_URL: `https://${FAKE_REF}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fabricated-not-a-key-anon",
    STAGING_APP_SUPABASE_URL: `https://${FAKE_REF}.supabase.co`,
    ...overrides,
  };
}
const validPin = () => ({ projectRefSha256: sha256(FAKE_REF), label: "remotiv-staging" });

test("the fabricated baseline passes all five, or every negative below proves nothing", () => {
  assert.doesNotThrow(() => runPureChecks(validEnv(), validPin()));
});

/* ─────────────────────────── checkOptIn ────────────────────────── */

test("checkOptIn rejects absence, emptiness and a near-miss", () => {
  for (const [label, value] of [
    ["unset", undefined],
    ["empty", ""],
    ["truthy but not the phrase", "yes"],
    ["the phrase with a typo", `${OPT_IN_VALUE}s`],
    ["the phrase with whitespace", ` ${OPT_IN_VALUE}`],
    ["uppercased", OPT_IN_VALUE.toUpperCase()],
  ]) {
    const env = validEnv({ [OPT_IN_VAR]: value });
    if (value === undefined) delete env[OPT_IN_VAR];
    throwsWith(
      () => checkOptIn(env),
      /not set to the exact opt-in value/,
      `${label} must not be consent`,
    );
  }
});

test("checkOptIn accepts only the exact phrase", () => {
  assert.doesNotThrow(() => checkOptIn(validEnv()));
});

/* ──────────────────────── checkKeysAbsent ──────────────────────── */

test("checkKeysAbsent fires for EVERY variable it claims to cover, one at a time", () => {
  // Looped over MUST_BE_ABSENT itself rather than a hand-written list, so a
  // variable added to the map without being added to the loop cannot slip
  // through untested. Eleven variables today.
  let covered = 0;
  for (const [consequence, vars] of Object.entries(MUST_BE_ABSENT)) {
    for (const v of vars) {
      throwsWith(
        () => checkKeysAbsent(validEnv({ [v]: "any-non-empty-value" })),
        new RegExp(`${v} \\(re-enables ${consequence}\\)`),
        `${v} present must be refused, and the message must name the consequence`,
      );
      covered += 1;
    }
  }
  assert.ok(
    covered >= 10,
    `only ${covered} variables were exercised; the map has shrunk unnoticed`,
  );
});

test("checkKeysAbsent treats an empty string as absent, not as present", () => {
  // A staging env commonly carries `RESEND_API_KEY=` to document the blank.
  // That is genuinely absent — the SDK gets nothing — so it must not be a
  // failure, or operators learn to delete the documentation.
  assert.doesNotThrow(() => checkKeysAbsent(validEnv({ RESEND_API_KEY: "", CRON_SECRET: "" })));
});

test("checkKeysAbsent reports all offenders at once, not just the first", () => {
  let msg = "";
  try {
    checkKeysAbsent(validEnv({ ANTHROPIC_API_KEY: "x", CRON_SECRET: "y", RESEND_API_KEY: "z" }));
  } catch (e) {
    msg = e.message;
  }
  assert.match(
    msg,
    /3 variable\(s\)/,
    "one-at-a-time reporting makes an operator re-run the guard three times",
  );
  for (const v of ["ANTHROPIC_API_KEY", "CRON_SECRET", "RESEND_API_KEY"])
    assert.match(msg, new RegExp(v));
});

test("checkKeysAbsent never prints a value, only a variable name", () => {
  const secret = "SENTINEL-VALUE-THAT-MUST-NOT-APPEAR";
  let msg = "";
  try {
    checkKeysAbsent(validEnv({ ANTHROPIC_API_KEY: secret }));
  } catch (e) {
    msg = e.message;
  }
  assert.doesNotMatch(
    msg,
    /SENTINEL-VALUE/,
    "AGENTS.md: not the value, not a prefix, not a truncated sample",
  );
  for (let n = 4; n <= secret.length; n += 1) {
    assert.doesNotMatch(msg, new RegExp(secret.slice(0, n)), `a ${n}-char prefix leaked`);
  }
});

/* ───────────────────── checkServiceKeyNotPublic ────────────────── */

test("checkServiceKeyNotPublic catches the service key published to the browser", () => {
  throwsWith(
    () => checkServiceKeyNotPublic(validEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_SERVICE })),
    /NEXT_PUBLIC_SUPABASE_ANON_KEY holds the same value as SUPABASE_SERVICE_ROLE_KEY/,
    "a service-role key served to every visitor",
  );
});

test("checkServiceKeyNotPublic catches it under ANY NEXT_PUBLIC_ name", () => {
  // The check is not a whitelist of known public variables; a copy-paste into
  // an invented name is the realistic version of this mistake.
  throwsWith(
    () => checkServiceKeyNotPublic(validEnv({ NEXT_PUBLIC_ADMIN_KEY: FAKE_SERVICE })),
    /NEXT_PUBLIC_ADMIN_KEY/,
    "an arbitrary NEXT_PUBLIC_ name is just as public",
  );
});

test("checkServiceKeyNotPublic refuses to run with no service key rather than passing", () => {
  const env = validEnv();
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  throwsWith(
    () => checkServiceKeyNotPublic(env),
    /SUPABASE_SERVICE_ROLE_KEY is not set/,
    "with no key to compare, every comparison is vacuously clean",
  );
});

test("checkServiceKeyNotPublic does not print the key, even when it has leaked", () => {
  let msg = "";
  try {
    checkServiceKeyNotPublic(validEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_SERVICE }));
  } catch (e) {
    msg = e.message;
  }
  assert.doesNotMatch(
    msg,
    new RegExp(FAKE_SERVICE),
    "the message names variables; the comparison is by hash",
  );
});

/* ────────────────────── projectRef / the pin ───────────────────── */

test("projectRef refuses anything that is not a Supabase project host", () => {
  throwsWith(() => projectRef(undefined, "V"), /V is not set/, "unset must not yield a ref");
  throwsWith(() => projectRef("", "V"), /V is not set/, "empty must not yield a ref");
  throwsWith(
    () => projectRef("not a url", "V"),
    /V is not a valid URL/,
    "a bare string is not a URL",
  );
  throwsWith(
    () => projectRef("https://evil.example.com", "V"),
    /does not point at a Supabase project host/,
    "a guard that passes against an arbitrary endpoint guards nothing",
  );
  throwsWith(
    () => projectRef("https://supabase.co", "V"),
    /does not point at a Supabase project host/,
    "the bare apex has no project ref",
  );
});

test("projectRef accepts both Supabase hosts and returns the ref alone", () => {
  assert.equal(projectRef(`https://${FAKE_REF}.supabase.co`, "V"), FAKE_REF);
  assert.equal(projectRef(`https://${FAKE_REF}.supabase.in/rest/v1/`, "V"), FAKE_REF);
});

test("checkRefMatchesPin rejects the UNSET pin as its own named failure", () => {
  // The case that ships today. Not "mismatch": "no usable pin".
  for (const pin of [
    undefined,
    null,
    {},
    { projectRefSha256: "" },
    { projectRefSha256: PIN_PLACEHOLDER },
    { projectRefSha256: sha256(FAKE_REF).slice(0, 63) },
    { projectRefSha256: 64 },
  ]) {
    throwsWith(
      () => checkRefMatchesPin(validEnv(), pin),
      /no usable projectRefSha256/,
      `pin ${JSON.stringify(pin)} must not pass`,
    );
  }
});

/*
 * ── assertPinIsReal: BOTH halves, and why one is not enough ──────
 *
 * The committed pin starts life as a placeholder. The test that used to live
 * here asserted it was STILL the placeholder, which meant that the moment the
 * real hash was pasted in, the test went red and the tempting fix was to
 * delete it, removing the only static check that the pin exists at all.
 *
 * The replacement asserts two things about the value and needs both:
 *
 *   1. it matches ^[0-9a-f]{64}$        rejects "todo", "", a 63-char paste
 *   2. it is not the placeholder string  rejects the file as shipped
 *
 * Either alone is useless. The format check passes a hard-coded fake that
 * happens to be hex; the not-placeholder check passes the word "todo". The
 * file-level test that applies this to approved-identity.json lives in
 * approved-identity.test.mjs and is RED until step 3 is done, by design.
 */

test("assertPinIsReal rejects the shipped placeholder", () => {
  throwsWith(
    () => assertPinIsReal({ projectRefSha256: PIN_PLACEHOLDER }),
    /no usable projectRefSha256/,
    "the file as shipped must be refused",
  );
});

test("assertPinIsReal rejects a non-hex value such as todo", () => {
  for (const value of ["todo", "", "g".repeat(64), sha256(FAKE_REF).slice(0, 63), 64, null]) {
    throwsWith(
      () => assertPinIsReal({ projectRefSha256: value }),
      /no usable projectRefSha256/,
      `${JSON.stringify(value)} is not a SHA-256`,
    );
  }
  throwsWith(() => assertPinIsReal(undefined), /no usable/, "no pin at all");
});

test("assertPinIsReal accepts a real hash and returns it lowercased", () => {
  const hash = sha256(FAKE_REF);
  assert.equal(assertPinIsReal({ projectRefSha256: hash }), hash);
  assert.equal(assertPinIsReal({ projectRefSha256: hash.toUpperCase() }), hash);
});

test("checkRefMatchesPin rejects a ref that is not the pinned project", () => {
  throwsWith(
    () =>
      checkRefMatchesPin(
        validEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }),
        validPin(),
      ),
    /does not point at the project pinned in/,
    "the production project must not satisfy a staging pin",
  );
});

test("checkRefMatchesPin accepts an uppercase pin, and nothing else", () => {
  assert.doesNotThrow(() =>
    checkRefMatchesPin(validEnv(), { projectRefSha256: sha256(FAKE_REF).toUpperCase() }),
  );
});

test("checkRefMatchesPin does not print the ref or the hash on failure", () => {
  let msg = "";
  try {
    checkRefMatchesPin(
      validEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }),
      validPin(),
    );
  } catch (e) {
    msg = e.message;
  }
  assert.doesNotMatch(
    msg,
    /zzzzzzzz/,
    "a project ref identifies the project and is in the credential category",
  );
  assert.doesNotMatch(
    msg,
    new RegExp(sha256(FAKE_REF).slice(0, 8)),
    "nor the expected side of the comparison",
  );
});

/* ───────────────────────── checkAppUrlParity ───────────────────── */

test("checkAppUrlParity catches a correctly-seeded DB with the app on another project", () => {
  // Invisible to all four checks above: the seed is pointed at staging, the
  // pin matches, no key is present, the operator opted in — and the browser
  // harness then drives an app reading production.
  throwsWith(
    () =>
      checkAppUrlParity(
        validEnv({ STAGING_APP_SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }),
      ),
    /different projects/,
    "the app under test and the data seeded must be one project",
  );
});

test("checkAppUrlParity refuses an unset app URL rather than skipping the comparison", () => {
  const env = validEnv();
  delete env.STAGING_APP_SUPABASE_URL;
  throwsWith(
    () => checkAppUrlParity(env),
    /STAGING_APP_SUPABASE_URL is not set/,
    "an absent second opinion is not agreement",
  );
});

test("checkAppUrlParity compares projects, not URL strings", () => {
  // Same project, different path and trailing slash. A string comparison would
  // fail this and teach the operator to normalise by hand.
  assert.doesNotThrow(() =>
    checkAppUrlParity(validEnv({ STAGING_APP_SUPABASE_URL: `https://${FAKE_REF}.supabase.co/` })),
  );
});

/* ───────────────────────── runPureChecks order ─────────────────── */

test("runPureChecks reports the opt-in first, before anything reads a key", () => {
  // Order matters for a reason that is not cosmetic: the identity checks read
  // SUPABASE_SERVICE_ROLE_KEY and the URLs. An operator who has not opted in
  // should be told that and nothing else.
  const env = validEnv({ [OPT_IN_VAR]: "no" });
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  throwsWith(
    () => runPureChecks(env, validPin()),
    /not set to the exact opt-in value/,
    "consent is checked first",
  );
});

test("runPureChecks fails if ANY single check fails", () => {
  const breakages = [
    [{ [OPT_IN_VAR]: "no" }, validPin()],
    [{ ANTHROPIC_API_KEY: "x" }, validPin()],
    [{ NEXT_PUBLIC_LEAK: FAKE_SERVICE }, validPin()],
    [{}, { projectRefSha256: sha256("someone-elses-project") }],
    [{ STAGING_APP_SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }, validPin()],
  ];
  for (const [override, pin] of breakages) {
    assert.throws(
      () => runPureChecks(validEnv(override), pin),
      `runPureChecks passed with ${JSON.stringify(override)} — one check is not wired in`,
    );
  }
  assert.equal(breakages.length, 5, "there are five pure checks; each needs a breakage here");
});

/* ─────────────────────── assertScoringDisabled ─────────────────── */

test("assertScoringDisabled refuses an empty list rather than finding it clean", () => {
  // [].filter(...) returns no offenders. Without this guard, a seed that
  // collected zero job rows would be certified as having scoring disabled.
  for (const bad of [[], undefined, null, "not an array"]) {
    throwsWith(
      () => assertScoringDisabled(bad),
      /was given no jobs/,
      `${JSON.stringify(bad)} must not read as a clean seed`,
    );
  }
});

test("assertScoringDisabled rejects NULL, which is ENABLED on both read paths", () => {
  throwsWith(
    () =>
      assertScoringDisabled([{ ai_cv_scoring_enabled: false }, { ai_cv_scoring_enabled: null }]),
    /1 of 2 seeded job\(s\)/,
    "cv-scoring.ts reads === false and applicants/actions.ts reads !== false",
  );
});

test("assertScoringDisabled rejects an absent column and a truthy value", () => {
  throwsWith(
    () => assertScoringDisabled([{}]),
    /1 of 1 seeded job\(s\)/,
    "unset is NULL is enabled",
  );
  throwsWith(
    () => assertScoringDisabled([{ ai_cv_scoring_enabled: true }]),
    /1 of 1 seeded job\(s\)/,
    "explicitly enabled is the worst case",
  );
  throwsWith(
    () => assertScoringDisabled([{ ai_cv_scoring_enabled: "false" }]),
    /1 of 1 seeded job\(s\)/,
    'the string "false" is truthy and is not the boolean the code compares',
  );
});

test("assertScoringDisabled returns the count it checked, so a caller can prove it ran", () => {
  assert.equal(
    assertScoringDisabled([{ ai_cv_scoring_enabled: false }, { ai_cv_scoring_enabled: false }]),
    2,
  );
});
