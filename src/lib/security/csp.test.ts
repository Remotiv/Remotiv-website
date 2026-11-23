/**
 * The CSP builder, with the production guard at its centre.
 *
 *   node --test src/lib/security/csp.test.ts
 *
 * The staging convenience is that the Supabase host is derived from
 * NEXT_PUBLIC_SUPABASE_URL. The danger is that this quietly widens the headers
 * production ships. So the central test builds the PRODUCTION configuration and
 * asserts its CSP names the production Supabase host and nothing else: no
 * staging host, no wildcard Supabase, no second Supabase origin. The matching
 * negative control in negative-controls.mjs adds a second host and requires
 * this to go red.
 */
// @ts-nocheck - Node's .ts specifier vs this tsconfig; same as the other staging tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  baseDirectives,
  mediaDirectives,
  PRODUCTION_SUPABASE_URL,
  resolveSupabaseUrl,
  supabaseHost,
  supabaseImagePattern,
  toCsp,
} from "./csp.ts";

const PROD_HOST = "jlezhdhzuyubhqvxdwvg.supabase.co";
const STAGING_HOST = "ejjhxmzagrfctztsrnhn.supabase.co";

/** Count Supabase origins in a directive string, wildcard included. */
function supabaseOrigins(csp) {
  return (csp.match(/\b(?:https?|wss):\/\/[a-z0-9*.-]*supabase\.[a-z]+/gi) ?? []).map((s) =>
    s.toLowerCase(),
  );
}

test("resolveSupabaseUrl: a set value always wins; unset falls back to production, never the reverse", () => {
  assert.equal(
    resolveSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_HOST}` }),
    `https://${STAGING_HOST}`,
  );
  assert.equal(resolveSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: "" }), PRODUCTION_SUPABASE_URL);
  assert.equal(resolveSupabaseUrl({}), PRODUCTION_SUPABASE_URL);
  assert.equal(PRODUCTION_SUPABASE_URL, `https://${PROD_HOST}`);
});

test("supabaseHost extracts the host and rejects a non-URL", () => {
  assert.equal(supabaseHost(`https://${PROD_HOST}`), PROD_HOST);
  assert.throws(() => supabaseHost("not a url"), /not a valid URL/);
});

/* ─────────────── the production guard ─────────────── */

test("PRODUCTION CSP names the production Supabase host and NOTHING else", () => {
  const host = supabaseHost(
    resolveSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_SUPABASE_URL }),
  );
  const csp = toCsp(mediaDirectives({ supabaseHost: host, isProduction: true }));

  // Every Supabase origin in the whole policy is the production one. No
  // staging host, no `*.supabase`, no second origin can slip in.
  const origins = supabaseOrigins(csp);
  assert.ok(origins.length > 0, "the production host must appear");
  for (const o of origins) {
    assert.ok(
      o === `https://${PROD_HOST}` || o === `wss://${PROD_HOST}`,
      `a non-production Supabase origin is in the CSP: ${o}`,
    );
  }
  assert.doesNotMatch(csp, /\*\.supabase/i, "no wildcard Supabase origin");
  assert.doesNotMatch(
    csp,
    new RegExp(STAGING_HOST),
    "the staging host must never be in production CSP",
  );
  // Exactly the three places the host belongs: img-src, connect-src (https + wss as two), media-src.
  assert.equal(
    origins.filter((o) => o === `https://${PROD_HOST}`).length,
    3,
    "https host: img-src, connect-src, media-src",
  );
  assert.equal(
    origins.filter((o) => o === `wss://${PROD_HOST}`).length,
    1,
    "wss host: connect-src only",
  );
});

test("PRODUCTION connect-src is byte-identical to what production shipped before the refactor", () => {
  const host = supabaseHost(PRODUCTION_SUPABASE_URL);
  const base = baseDirectives({ supabaseHost: host, isProduction: true });
  const connect = base.find((d) => d.startsWith("connect-src"));
  assert.equal(
    connect,
    `connect-src 'self' https://${PROD_HOST} wss://${PROD_HOST} https://calendly.com https://*.calendly.com`,
  );
  assert.equal(
    base.find((d) => d.startsWith("img-src")),
    `img-src 'self' data: blob: https://${PROD_HOST} https://*.calendly.com`,
  );
  assert.ok(
    base.includes("upgrade-insecure-requests"),
    "production keeps upgrade-insecure-requests",
  );
});

/* ─────────────── staging gets staging, and only staging ─────────────── */

test("a STAGING url yields the staging host in the CSP and the production host nowhere", () => {
  const host = supabaseHost(
    resolveSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING_HOST}` }),
  );
  const csp = toCsp(mediaDirectives({ supabaseHost: host, isProduction: false }));
  assert.match(csp, new RegExp(`https://${STAGING_HOST}`));
  assert.match(csp, new RegExp(`wss://${STAGING_HOST}`));
  assert.doesNotMatch(
    csp,
    new RegExp(PROD_HOST),
    "the production host must not appear in a staging CSP",
  );
  for (const o of supabaseOrigins(csp)) {
    assert.ok(
      o.includes(STAGING_HOST),
      `a non-staging Supabase origin leaked into staging CSP: ${o}`,
    );
  }
  // Dev builds omit upgrade-insecure-requests so plain-HTTP localhost works.
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
});

test("the image remotePattern follows the same single host", () => {
  assert.deepEqual(supabaseImagePattern(STAGING_HOST), {
    protocol: "https",
    hostname: STAGING_HOST,
    pathname: "/storage/v1/object/**",
  });
});

/* ─────────────── script-src: no 'unsafe-eval' in production (#72) ─────────────── */

test("PRODUCTION script-src has no 'unsafe-eval', in the base and the media CSP alike", () => {
  const host = supabaseHost(PRODUCTION_SUPABASE_URL);
  for (const directives of [
    baseDirectives({ supabaseHost: host, isProduction: true }),
    mediaDirectives({ supabaseHost: host, isProduction: true }),
  ]) {
    assert.equal(
      directives.find((d) => d.startsWith("script-src")),
      "script-src 'self' 'unsafe-inline' https://assets.calendly.com",
    );
    assert.doesNotMatch(toCsp(directives), /unsafe-eval/);
  }
});

test("DEVELOPMENT script-src keeps 'unsafe-eval' (Next's dev runtime needs it)", () => {
  const dev = baseDirectives({ supabaseHost: STAGING_HOST, isProduction: false });
  assert.equal(
    dev.find((d) => d.startsWith("script-src")),
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://assets.calendly.com",
  );
});

test("the headers are built with isProduction from NODE_ENV, so next start serves the production CSP", () => {
  const config = readFileSync(new URL("../../../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /const isProduction = process\.env\.NODE_ENV === "production";/);
  assert.match(config, /const cspInput = \{ supabaseHost: SUPABASE_HOST, isProduction \};/);
});
