/**
 * The network guard's decisions, with fabricated destinations.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * No browser, no network. Every URL below is made up. The property under test
 * is the verdict and the bookkeeping: a production-looking host, an unknown
 * project, a pooler, a WebSocket to the wrong project are all aborted and
 * recorded masked; the approved project and exact custom domains continue;
 * zero observed successes is a failure; a blocked request is a failure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "./guard-checks.mjs";
import {
  CUSTOM_DOMAINS_VAR,
  classify,
  createGuard,
  parseCustomDomains,
  policyFrom,
} from "./network-guard.mjs";

const REF = "stagingfakeref000000";
const PIN = { projectRefSha256: sha256(REF) };
const policy = policyFrom({ pin: PIN, customDomains: ["db.staging.example"] });
const APPROVED = `https://${REF}.supabase.co/rest/v1/jobs?select=id&apikey=MUSTNOTAPPEAR`;
const PROD_LIKE = "https://prodlikeref0000000000.supabase.co/rest/v1/jobs?select=id";
const UNKNOWN = "https://unknownref00000000000.supabase.co/auth/v1/token";
const POOLER = "https://aws-0-eu-west-1.pooler.supabase.com/";
const WS_WRONG = "wss://otherref000000000000.supabase.co/realtime/v1/websocket?apikey=X";
const WS_RIGHT = `wss://${REF}.supabase.co/realtime/v1/websocket`;

/* ─────────────────────────── classify ─────────────────────────── */

test("the approved project host is approved, via its ref hash, http and ws alike", () => {
  assert.equal(classify(APPROVED, policy).kind, "approved");
  assert.equal(classify(WS_RIGHT, policy).kind, "approved");
  assert.equal(classify(APPROVED, policy).via, "project-host");
});

test("a production-looking project, an unknown project, and the pooler are all forbidden", () => {
  for (const url of [PROD_LIKE, UNKNOWN, POOLER, `https://db.${REF}.supabase.co/`]) {
    assert.equal(classify(url, policy).kind, "forbidden", url);
  }
});

test("an unexpected Supabase WebSocket destination is forbidden", () => {
  assert.equal(classify(WS_WRONG, policy).kind, "forbidden");
});

test("the app itself and third parties are other, never approved", () => {
  for (const url of ["http://localhost:3000/ai-dashboard", "https://assets.calendly.com/x.js"]) {
    assert.equal(classify(url, policy).kind, "other", url);
  }
});

test("an exactly-listed custom domain is approved; any other custom host is not", () => {
  assert.equal(classify("https://db.staging.example/rest/v1/x", policy).kind, "approved");
  assert.equal(classify("https://db.staging.example/rest/v1/x", policy).via, "custom-domain");
  assert.equal(classify("https://evil.staging.example/rest/v1/x", policy).kind, "other");
  assert.equal(
    classify("https://supabase.evil.example/", policy).kind,
    "forbidden",
    "a host merely containing 'supabase' is forbidden rather than other",
  );
});

test("masking: no ref, no custom domain, no query string, no token ever appears", () => {
  for (const url of [APPROVED, PROD_LIKE, WS_WRONG, "https://db.staging.example/a/b?k=SECRET"]) {
    const { masked } = classify(url, policy);
    assert.doesNotMatch(
      masked,
      /stagingfakeref|prodlikeref|otherref|MUSTNOTAPPEAR|SECRET|\?/,
      masked,
    );
    assert.match(masked, /<path:\d+>$/);
  }
  assert.equal(classify(APPROVED, policy).masked, "https://<ref>.supabase.co/<path:12>");
  assert.equal(
    classify("https://db.staging.example/a/b", policy).masked,
    "https://<custom-domain>/<path:3>",
  );
  assert.equal(classify(POOLER, policy).masked, "https://<other>.supabase.com/<path:0>");
});

test("an unparseable URL is other and does not crash the guard", () => {
  assert.deepEqual(classify("not a url", policy), { kind: "other", masked: "<unparseable url>" });
});

/* ───────────────────────── custom domains ─────────────────────── */

test("custom domains must be exact bare hostnames: wildcard, scheme, port and path are refused", () => {
  assert.deepEqual(parseCustomDomains(undefined), []);
  assert.deepEqual(parseCustomDomains(" db.Staging.example , api.staging.example "), [
    "db.staging.example",
    "api.staging.example",
  ]);
  for (const bad of [
    "*.staging.example",
    "https://db.staging.example",
    "db.staging.example:443",
    "db.staging.example/x",
    "localhost",
  ]) {
    assert.throws(() => parseCustomDomains(bad), new RegExp(CUSTOM_DOMAINS_VAR), bad);
  }
});

test("policyFrom refuses an unset pin: no policy can be built from the placeholder", () => {
  assert.throws(
    () => policyFrom({ pin: { projectRefSha256: "deadbeef".repeat(8) } }),
    /no usable projectRefSha256/,
  );
});

/* ─────────────────────────── the guard ────────────────────────── */

const fakeRoute = (url) => {
  const calls = [];
  return {
    calls,
    request: () => ({ url: () => url }),
    abort: async (reason) => calls.push(["abort", reason]),
    continue: async () => calls.push(["continue"]),
  };
};
const fakeWs = (url) => {
  const calls = [];
  return {
    calls,
    url: () => url,
    close: (opts) => calls.push(["close", opts?.code]),
    connectToServer: () => calls.push(["connect"]),
  };
};

test("a forbidden http request is ABORTED before the network and recorded masked", async () => {
  const g = createGuard(policy);
  const r = fakeRoute(PROD_LIKE);
  await g.handleRoute(r);
  assert.deepEqual(r.calls, [["abort", "blockedbyclient"]]);
  assert.equal(g.violations.length, 1);
  assert.equal(g.violations[0].transport, "http");
  assert.doesNotMatch(JSON.stringify(g.violations), /prodlikeref/);
});

test("an approved http request continues and is counted as an attempt", async () => {
  const g = createGuard(policy);
  const r = fakeRoute(APPROVED);
  await g.handleRoute(r);
  assert.deepEqual(r.calls, [["continue"]]);
  assert.equal(g.violations.length, 0);
  assert.equal(g.observed.approvedAttempts, 1);
});

test("a WebSocket to the wrong project is CLOSED, never connected; the right one connects", () => {
  const g = createGuard(policy);
  const wrong = fakeWs(WS_WRONG);
  g.handleWebSocket(wrong);
  assert.deepEqual(wrong.calls, [["close", 1008]]);
  assert.equal(g.violations[0].transport, "websocket");
  const right = fakeWs(WS_RIGHT);
  g.handleWebSocket(right);
  assert.deepEqual(right.calls, [["connect"]]);
});

test("a BLOCKED request still FAILS the run: assertClean throws and names the masked destination", async () => {
  const g = createGuard(policy);
  await g.handleRoute(fakeRoute(UNKNOWN));
  assert.throws(
    () => g.assertClean("applicants/newest"),
    (e) => {
      assert.match(e.message, /BROWSER NETWORK VIOLATION during applicants\/newest/);
      assert.match(e.message, /blocked request is still a request/);
      assert.match(e.message, /<ref>\.supabase\.co/);
      assert.doesNotMatch(e.message, /unknownref/);
      return true;
    },
  );
});

test("assertClean is silent with no violations", async () => {
  const g = createGuard(policy);
  await g.handleRoute(fakeRoute(APPROVED));
  await g.handleRoute(fakeRoute("http://localhost:3000/x"));
  g.assertClean("x");
});

test("ZERO observed successful staging requests is a failure, not a pass", () => {
  const g = createGuard(policy);
  assert.throws(() => g.assertObserved(), /ZERO successful browser requests/);
  g.onResponse({ url: () => APPROVED, status: () => 500 });
  assert.throws(() => g.assertObserved(), /ZERO/, "a 500 is not a success");
  g.onResponse({ url: () => PROD_LIKE, status: () => 200 });
  assert.throws(() => g.assertObserved(), /ZERO/, "a success elsewhere does not count");
  g.onResponse({ url: () => APPROVED, status: () => 200 });
  g.assertObserved();
  assert.equal(g.observed.approvedOk, 1);
});

test("the zero-observed message points at the CSP when nothing was even attempted", () => {
  const g = createGuard(policy);
  assert.throws(() => g.assertObserved(), /Content-Security-Policy connect-src/);
});
