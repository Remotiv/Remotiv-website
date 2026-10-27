/**
 * The RUNNING app proves which database it reads, before anything else happens.
 *
 * Called by the seed before its first write and by the harness in beforeAll,
 * before any browser exists. Pure over an injected fetch, so the refusals can
 * be driven with fabricated responses and shown to fire (app-identity.test.mjs
 * and negative-controls.mjs).
 *
 * ── What is proven ───────────────────────────────────────────
 *
 *   1. the app can read staging_guard.sentinel, and its hash equals the pin
 *      in git. In production the schema does not exist, the route is a bare
 *      404, and this throws BEFORE a browser is opened or a candidate-data
 *      request is made.
 *   2. the app was launched in isolation (scripts/staging/app.mjs): it reports
 *      the locked variable names, and every one of them is absent in its own
 *      process. An app started any other way reports nothing and is refused;
 *      "I did not check" is not "absent".
 *
 * Nothing identifying crosses the wire or reaches a message: hashes and
 * variable NAMES only.
 */

import { assertPinIsReal, MUST_BE_ABSENT, projectRef, sha256 } from "./guard-checks.mjs";

export const IDENTITY_ROUTE = "/api/staging-probe/identity";
const HASH = /^[0-9a-f]{64}$/;

/**
 * The three connections that must all be the approved project, plus the key.
 *
 * The sentinel proves the SERVER's service-role client. The browser never uses
 * it: it is handed NEXT_PUBLIC_SUPABASE_URL and the anon key, inlined from the
 * app's environment (src/lib/supabase/client.ts). STAGING_APP_SUPABASE_URL is
 * the scripts' own statement of the app's project. Each is compared with the
 * pin as a hash, every disagreement is collected, and the error names each
 * party that disagreed, so "the server is on staging" can never stand in for
 * "the browser is". Fails closed when the app reports nothing.
 */
export function connectionDisagreements({ body, expected, appUrlRefSha256 }) {
  const c = body.connections;
  if (!c || typeof c !== "object") {
    return [
      "the app reports no connection details (connections missing); the browser's project is unknown",
    ];
  }
  const out = [];
  if (body.projectRefSha256 !== expected) {
    out.push(
      "the server-side connection (staging_guard.sentinel, read by the app's service client)",
    );
  }
  if (c.publicRefSha256 !== expected) {
    out.push(
      "the browser's public URL (NEXT_PUBLIC_SUPABASE_URL in the app's environment, inlined into the browser bundle)",
    );
  }
  if (appUrlRefSha256 !== expected) {
    out.push("STAGING_APP_SUPABASE_URL (the scripts' statement of the app's project)");
  }
  if (c.anonKeyRefSha256 !== null && c.anonKeyRefSha256 !== expected) {
    out.push("the anon key (its ref claim names a different project)");
  }
  if (c.anonKeyValid !== true) {
    out.push(
      c.anonKeyValid === false
        ? "the anon key (the project's auth settings endpoint rejected it)"
        : "the anon key (its validity could not be verified against the project)",
    );
  }
  return out;
}

export async function proveAppIdentity({
  baseUrl,
  cookie,
  pin,
  appUrl,
  fetchImpl = globalThis.fetch,
}) {
  const expected = assertPinIsReal(pin);
  const appUrlRefSha256 = sha256(projectRef(appUrl, "STAGING_APP_SUPABASE_URL"));
  if (!baseUrl) throw new Error("STAGING_BASE_URL is not set; the app's identity cannot be asked");
  if (!cookie) throw new Error("proveAppIdentity needs a signed-in session cookie");

  let res;
  try {
    res = await fetchImpl(`${baseUrl}${IDENTITY_ROUTE}`, {
      headers: { cookie },
      redirect: "manual",
    });
  } catch {
    throw new Error(
      `could not reach the app at STAGING_BASE_URL${IDENTITY_ROUTE}. Identity unproven; ` +
        `no browser is opened and no candidate-data request is made.`,
    );
  }

  if (res.status === 404) {
    // The gate names WHICH check refused, in a fixed-enum header (never a
    // value): see _lib/gate.ts RefusalCode. Reported so a 404 is debuggable
    // instead of four-cause guesswork.
    const code =
      res.headers?.get?.("x-staging-probe-refused") ??
      "(no code; older build or not the probe route)";
    throw new Error(
      `${IDENTITY_ROUTE} answered 404, refusal code: ${code}. What each means:\n` +
        `  sentinel-unreadable  app cannot read staging_guard.sentinel (PRODUCTION, or schema not on the Data API).\n` +
        `  sentinel-count/hash  the sentinel row is missing, duplicated, or malformed.\n` +
        `  unauthenticated      the cookie session was not accepted by the app's server client.\n` +
        `  no-company           signed in, but the account has no active company membership yet.\n` +
        `STOP: no browser is opened, no candidate-data request is made, nothing below may run.`,
    );
  }
  if (res.status !== 200) {
    throw new Error(`${IDENTITY_ROUTE} answered ${res.status}; the app's identity is unproven`);
  }

  const body = await res.json();
  if (typeof body.projectRefSha256 !== "string" || !HASH.test(body.projectRefSha256)) {
    throw new Error("the identity route returned no usable hash; refusing to compare");
  }
  if (body.projectRefSha256 !== expected) {
    throw new Error(
      "THE RUNNING APP IS NOT CONNECTED TO THE APPROVED STAGING PROJECT: its sentinel hash " +
        "does not equal the pin in scripts/staging/approved-identity.json. Every number a " +
        "harness produced would be about the wrong database. Stop here.",
    );
  }
  if (!body.sentinelPurpose) {
    throw new Error("the app read a sentinel with no purpose text; it has asserted nothing");
  }

  const disagreed = connectionDisagreements({ body, expected, appUrlRefSha256 });
  if (disagreed.length > 0) {
    throw new Error(
      `NOT EVERY CONNECTION IS THE APPROVED STAGING PROJECT. ${disagreed.length} of them ` +
        `disagree with the pin:\n  - ${disagreed.join("\n  - ")}\nThe server being on staging ` +
        `does not make the browser so. Stop here.`,
    );
  }

  const iso = body.isolation;
  if (
    !iso ||
    typeof iso !== "object" ||
    !Array.isArray(iso.checked) ||
    !Array.isArray(iso.present)
  ) {
    throw new Error(
      "the running app was not launched in isolation: it reports no locked variable names. " +
        "Start it with `npm run staging:app` (scripts/staging/app.mjs), which locks every name " +
        ".env.local could supply. An app started with plain `next dev` has read .env.local.",
    );
  }
  const required = Object.values(MUST_BE_ABSENT).flat();
  const unchecked = required.filter((n) => !iso.checked.includes(n));
  if (unchecked.length > 0) {
    throw new Error(
      `the app did not check these required-absent variables: ${unchecked.join(", ")}`,
    );
  }
  if (iso.present.length > 0) {
    throw new Error(
      `the running app has ${iso.present.length} variable(s) set that must be absent: ` +
        `${iso.present.join(", ")}. It has read an env file the launcher did not lock, or ` +
        `was started outside the launcher. Names only; no value was read.`,
    );
  }
  return { checked: iso.checked.length, connections: 3, anonKeyValid: true };
}
