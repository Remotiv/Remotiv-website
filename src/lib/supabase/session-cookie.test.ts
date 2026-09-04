/**
 * The gate's cookie peek and the recover handler's destination filter.
 *
 *   node --test src/lib/supabase/session-cookie.test.ts
 *
 * The cookie is built with @supabase/ssr's OWN chunker and encoder, so these
 * assert against the real envelope, not a hand-rolled imitation of it.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRY_MARGIN_MS } from "@supabase/auth-js/dist/main/lib/constants.js";
import { createChunks, stringToBase64URL } from "@supabase/ssr";
import {
  AUTH_JS_EXPIRY_MARGIN_MS,
  PEEK_MARGIN_MS,
  peekSession,
  safeNext,
  sessionCookieName,
} from "./session-cookie.ts";

const URL_ = "https://abcdefghijklmnopqrst.supabase.co";
const NAME = "sb-abcdefghijklmnopqrst-auth-token";

function jar(session: object | string, pad = 0) {
  const json =
    typeof session === "string"
      ? session
      : JSON.stringify({ ...session, padding: "x".repeat(pad) });
  const chunks = createChunks(NAME, `base64-${stringToBase64URL(json)}`);
  const map = new Map(chunks.map((c) => [c.name, c.value]));
  return {
    get: (n: string) => (map.has(n) ? { value: map.get(n) } : undefined),
    names: [...map.keys()],
  };
}
const NOW = 1_800_000_000_000;
const at = (msFromNow: number) => Math.floor((NOW + msFromNow) / 1000);

test("the local copy of auth-js's expiry margin has not drifted from the library", () => {
  assert.equal(AUTH_JS_EXPIRY_MARGIN_MS, EXPIRY_MARGIN_MS);
});

test("cookie name is derived exactly as supabase-js derives it", () => {
  assert.equal(sessionCookieName(URL_), NAME);
});

test("no cookie → none", async () => {
  assert.deepEqual(await peekSession({ get: () => undefined }, URL_, NOW), { state: "none" });
});

test("a token with an hour left is live", async () => {
  const r = await peekSession(
    jar({ expires_at: at(60 * 60 * 1000), refresh_token: "r" }),
    URL_,
    NOW,
  );
  assert.equal(r.state, "live");
});

test("the gate's line sits AHEAD of auth-js's: a token auth-js would still accept is already 'expired' here", async () => {
  // 100s left: outside auth-js's 90s margin (it would NOT refresh), inside ours.
  const r = await peekSession(jar({ expires_at: at(100 * 1000) }), URL_, NOW);
  assert.equal(r.state, "expired");
  assert.ok(
    PEEK_MARGIN_MS > EXPIRY_MARGIN_MS,
    "peek margin must exceed auth-js's or the gate can hand auth-js a token it will refresh",
  );
});

test("just past our margin is live; auth-js will not refresh it either", async () => {
  const r = await peekSession(jar({ expires_at: at(PEEK_MARGIN_MS + 1000) }), URL_, NOW);
  assert.equal(r.state, "live");
});

test("an already-expired token is expired", async () => {
  const r = await peekSession(jar({ expires_at: at(-2 * 60 * 60 * 1000) }), URL_, NOW);
  assert.equal(r.state, "expired");
});

test("a cookie large enough to be CHUNKED is reassembled before decoding", async () => {
  const j = jar({ expires_at: at(3_600_000) }, 7000);
  assert.ok(j.names.length >= 3, `expected chunks, got ${j.names.join(",")}`);
  assert.ok(
    j.names.every((n) => n.startsWith(`${NAME}.`)),
    "chunk names carry the base key",
  );
  assert.equal((await peekSession(j, URL_, NOW)).state, "live");
});

test("corrupt or unexpected cookies read as none, never throw", async () => {
  for (const bad of [
    "base64-not!!valid",
    "{not json",
    JSON.stringify({ expires_at: "soon" }),
    JSON.stringify({}),
  ]) {
    const map = new Map([[NAME, bad]]);
    const r = await peekSession(
      { get: (n) => (map.has(n) ? { value: map.get(n) } : undefined) },
      URL_,
      NOW,
    );
    assert.equal(r.state, "none", `for ${bad}`);
  }
});

test("safeNext keeps dashboard paths and collapses everything else to the root", () => {
  assert.equal(
    safeNext("/ai-dashboard/applicants?stage=interview"),
    "/ai-dashboard/applicants?stage=interview",
  );
  for (const bad of [
    null,
    "",
    "https://evil.example",
    "//evil.example/x",
    "/admin",
    "/ai-dashboard\\evil",
    "/ai-dashboard/x\r\nSet-Cookie: a=b",
    "/ai-dashboard/api/session/recover?next=/ai-dashboard",
    "/ai-dashboard/login",
  ]) {
    assert.equal(safeNext(bad), "/ai-dashboard", `for ${JSON.stringify(bad)}`);
  }
});
