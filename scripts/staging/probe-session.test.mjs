/**
 * The cookie header the seed builds decodes back through @supabase/ssr's own
 * readers to the session it was built from, under the name the app's server
 * client will look for.
 *
 *   node --test "scripts/staging/*.test.mjs"
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { combineChunks, parseCookieHeader, stringFromBase64URL } from "@supabase/ssr";
import { sessionCookieHeader } from "./probe-session.mjs";

const URL = "https://abcdefghijklmnopqrst.supabase.co";
const session = {
  access_token: "fabricated.access.token",
  refresh_token: "fabricated-refresh",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1_900_000_000,
  user: { id: "11111111-1111-4111-8111-111111111111" },
};

async function decode(header) {
  const cookies = parseCookieHeader(header);
  const combined = await combineChunks("sb-abcdefghijklmnopqrst-auth-token", (name) => {
    const c = cookies.find((x) => x.name === name);
    return c ? c.value : null;
  });
  assert.ok(combined, "no cookie under the expected name");
  assert.ok(combined.startsWith("base64-"), "the value is not base64url-encoded");
  return JSON.parse(stringFromBase64URL(combined.slice("base64-".length)));
}

test("the header round-trips through @supabase/ssr under sb-<ref>-auth-token", async () => {
  const header = sessionCookieHeader(session, URL);
  assert.match(header, /^sb-abcdefghijklmnopqrst-auth-token=/);
  assert.deepEqual(await decode(header), session);
});

test("a long session is chunked into .0, .1 and still round-trips", async () => {
  const long = { ...session, access_token: "x".repeat(5000) };
  const header = sessionCookieHeader(long, URL);
  assert.match(header, /auth-token\.0=/);
  assert.match(header, /auth-token\.1=/);
  assert.deepEqual(await decode(header), long);
});

test("no session means no header, not an empty one the app would reject silently", () => {
  for (const bad of [null, {}, { access_token: "" }]) {
    assert.throws(() => sessionCookieHeader(bad, URL), /no access_token/);
  }
});

test("a non-Supabase URL is refused rather than producing a cookie for the wrong host", () => {
  assert.throws(() => sessionCookieHeader(session, "https://example.com"), /Supabase project host/);
});
