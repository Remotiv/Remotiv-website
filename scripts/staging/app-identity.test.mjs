/**
 * proveAppIdentity, driven with fabricated responses.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * Each test hands the function the response it exists to refuse, and
 * requires the refusal. The 404 case is the one that matters most: it is what
 * production answers, and the message must say that nothing opens a browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionDisagreements, IDENTITY_ROUTE, proveAppIdentity } from "./app-identity.mjs";
import { MUST_BE_ABSENT, sha256 } from "./guard-checks.mjs";

/** A fabricated project: the pin is the hash of a made-up ref, so every party can agree. */
const REF = "stagingfakeref000000";
const HASH = sha256(REF);
const APP_URL = `https://${REF}.supabase.co`;
const PIN = { projectRefSha256: HASH, label: "fake" };
const REQUIRED = Object.values(MUST_BE_ABSENT).flat();
const ISOLATED = { checked: [...REQUIRED, "REDIS_URL"], present: [] };
const AGREED = { publicRefSha256: HASH, anonKeyRefSha256: HASH, anonKeyValid: true };

const respond = (status, body) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
};

const ok = (over = {}) => ({
  projectRefSha256: HASH,
  sentinelPurpose: "load test",
  isolation: ISOLATED,
  connections: AGREED,
  ...over,
});

const run = (status, body, appUrl = APP_URL) =>
  proveAppIdentity({
    baseUrl: "http://localhost:3100",
    cookie: "sb-x-auth-token=y",
    pin: PIN,
    appUrl,
    fetchImpl: respond(status, body).fetchImpl,
  });

test("a 404 is refused with a message that says no browser is opened", async () => {
  await assert.rejects(run(404, null), (e) => {
    assert.match(e.message, /404/);
    assert.match(e.message, /PRODUCTION/);
    assert.match(e.message, /no browser is opened/);
    return true;
  });
});

test("the app and the pin agreeing, in isolation, on all three connections, is the only pass", async () => {
  const r = await run(200, ok());
  assert.deepEqual(r, { checked: ISOLATED.checked.length, connections: 3, anonKeyValid: true });
});

/* ───────────────── the browser's connection, not only the server's ───────────────── */

test("a browser public URL on another project is refused and NAMED, with the server agreeing", async () => {
  const other = sha256("someotherproject0000");
  await assert.rejects(
    run(200, ok({ connections: { ...AGREED, publicRefSha256: other } })),
    (e) => {
      assert.match(e.message, /NOT EVERY CONNECTION/);
      assert.match(e.message, /the browser's public URL \(NEXT_PUBLIC_SUPABASE_URL/);
      assert.doesNotMatch(
        e.message,
        /server-side connection/,
        "the server agreed; it must not be blamed",
      );
      assert.doesNotMatch(
        e.message,
        /STAGING_APP_SUPABASE_URL \(the scripts/,
        "the scripts' URL agreed",
      );
      return true;
    },
  );
});

test("STAGING_APP_SUPABASE_URL on another project is refused and NAMED", async () => {
  await assert.rejects(run(200, ok(), "https://someotherproject0000.supabase.co"), (e) => {
    assert.match(e.message, /STAGING_APP_SUPABASE_URL \(the scripts' statement/);
    assert.doesNotMatch(e.message, /browser's public URL/);
    return true;
  });
});

test("an anon key whose ref claim names another project is refused and NAMED", async () => {
  const other = sha256("someotherproject0000");
  await assert.rejects(
    run(200, ok({ connections: { ...AGREED, anonKeyRefSha256: other } })),
    /the anon key \(its ref claim names a different project\)/,
  );
});

test("an anon key the project rejects, or one that could not be verified, is refused", async () => {
  await assert.rejects(
    run(200, ok({ connections: { ...AGREED, anonKeyValid: false } })),
    /the anon key \(the project's auth settings endpoint rejected it\)/,
  );
  await assert.rejects(
    run(200, ok({ connections: { ...AGREED, anonKeyValid: null } })),
    /the anon key \(its validity could not be verified/,
  );
});

test("a publishable (non-JWT) anon key has no ref claim and is judged by validity alone", async () => {
  const r = await run(200, ok({ connections: { ...AGREED, anonKeyRefSha256: null } }));
  assert.equal(r.anonKeyValid, true);
});

test("an app that reports no connections at all is refused: fail closed, not fail open", async () => {
  for (const connections of [undefined, null, "x"]) {
    await assert.rejects(run(200, ok({ connections })), /reports no connection details/);
  }
});

test("every disagreeing party is listed together, so one fix does not hide the next", () => {
  const other = sha256("someotherproject0000");
  const out = connectionDisagreements({
    body: {
      projectRefSha256: other,
      connections: { publicRefSha256: other, anonKeyRefSha256: other, anonKeyValid: false },
    },
    expected: HASH,
    appUrlRefSha256: other,
  });
  assert.equal(out.length, 5, out.join("\n"));
  assert.ok(out.some((s) => s.startsWith("the server-side connection")));
  assert.ok(out.some((s) => s.startsWith("the browser's public URL")));
  assert.ok(out.some((s) => s.startsWith("STAGING_APP_SUPABASE_URL")));
  assert.equal(out.filter((s) => s.startsWith("the anon key")).length, 2);
});

test("the route is called with the session cookie and no redirect following", async () => {
  const { fetchImpl, calls } = respond(200, ok());
  await proveAppIdentity({
    baseUrl: "http://localhost:3100",
    cookie: "c=1",
    pin: PIN,
    appUrl: APP_URL,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://localhost:3100${IDENTITY_ROUTE}`);
  assert.equal(calls[0].init.headers.cookie, "c=1");
  assert.equal(calls[0].init.redirect, "manual");
});

test("a hash that differs from the pin is refused as the wrong database", async () => {
  await assert.rejects(
    run(200, ok({ projectRefSha256: "b".repeat(64) })),
    /NOT CONNECTED TO THE APPROVED/,
  );
});

test("a malformed or missing hash is refused, never compared", async () => {
  for (const bad of [undefined, "", "todo", "G".repeat(64)]) {
    await assert.rejects(run(200, ok({ projectRefSha256: bad })), /no usable hash/);
  }
});

test("an app launched outside the launcher reports no isolation and is refused", async () => {
  for (const iso of [undefined, null, {}, { checked: "x" }]) {
    await assert.rejects(run(200, ok({ isolation: iso })), /not launched in isolation/);
  }
});

test("an app with a required-absent variable PRESENT is refused, naming the variable", async () => {
  const body = ok({ isolation: { checked: ISOLATED.checked, present: ["ANTHROPIC_API_KEY"] } });
  await assert.rejects(run(200, body), (e) => {
    assert.match(e.message, /must be absent/);
    assert.match(e.message, /ANTHROPIC_API_KEY/);
    return true;
  });
});

test("an app that did not check every guard-required name is refused", async () => {
  const body = ok({ isolation: { checked: ["REDIS_URL"], present: [] } });
  await assert.rejects(run(200, body), /did not check these required-absent variables/);
});

test("an unreachable app and a non-200 answer are both refusals", async () => {
  await assert.rejects(
    proveAppIdentity({
      baseUrl: "http://localhost:1",
      cookie: "c=1",
      pin: PIN,
      appUrl: APP_URL,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    /could not reach the app/,
  );
  await assert.rejects(run(500, null), /answered 500/);
});

test("an unset pin is refused before any request is made", async () => {
  const { fetchImpl, calls } = respond(200, ok());
  await assert.rejects(
    proveAppIdentity({
      baseUrl: "http://localhost:3100",
      cookie: "c=1",
      pin: { projectRefSha256: "deadbeef".repeat(8) },
      appUrl: APP_URL,
      fetchImpl,
    }),
    /no usable projectRefSha256/,
  );
  assert.equal(calls.length, 0, "no request may be made against an unset pin");
});
