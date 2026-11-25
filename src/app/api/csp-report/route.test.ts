/**
 * #72 step 13: the CSP report endpoint, as shipped. The real POST handler and
 * the real NextRequest (next/server.js); only the rate limiter is stubbed (it
 * has its own tests), so the handler's own decisions are what is checked:
 * always 204, and exactly the sanitized log lines.
 *
 *   node --test src/app/api/csp-report/route.test.ts
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  if (specifier === "@/app/api/_lib/rate-limit") {
    return {
      url: "data:text/javascript," + encodeURIComponent("export function rateLimit(request, opts) { globalThis.__cspLimit.calls.push(opts); return globalThis.__cspLimit.next(); }"),
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}`)}`,
);

globalThis.__cspLimit = { calls: [], next: () => ({ ok: true }) };
const { POST } = await import("./route.ts");
const { NextRequest } = await import("next/server.js");

const SECRET = "tok_9f8e7d6c5b4a";
const IP = "203.0.113.77";

const post = (body, contentType = "application/csp-report") =>
  new NextRequest("https://remotiv.work/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType, "x-real-ip": IP, "x-forwarded-for": IP },
    body,
  });

/** Call POST, capturing every console line it writes. */
async function call(req) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    const res = await POST(req);
    return { status: res.status, body: await res.text(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

const noLeak = (lines) => {
  for (const l of lines) {
    for (const leak of [
      SECRET,
      IP,
      "ayesha",
      "Ayesha",
      "__next_f",
      "alert(",
      "?q=",
      "/applicants/",
    ]) {
      assert.ok(!l.includes(leak), `"${leak}" reached a log line: ${l}`);
    }
  }
};

// Negative control: log the report's document-uri as it is (not pageOf) in
// csp-report.ts and this test fails.
test("(a) a legacy report-uri body: 204, one sanitized line", async () => {
  const r = await call(
    post(
      JSON.stringify({
        "csp-report": {
          "document-uri": `https://remotiv.work/ai-dashboard/applicants/${SECRET}?q=ayesha%40example.test`,
          "effective-directive": "script-src-elem",
          "violated-directive": "script-src-elem 'self' 'nonce-abc'",
          "blocked-uri": "inline",
          "script-sample": 'self.__next_f.push([1,"Ayesha Khan"])',
        },
      }),
    ),
  );
  assert.equal(r.status, 204);
  assert.equal(r.body, "");
  assert.deepEqual(r.lines, [
    "[csp-report] directive=script-src-elem blocked=inline page=/ai-dashboard",
  ]);
  noLeak(r.lines);
});

test("(b) a Reporting API array: 204, one line per CSP violation, other report types ignored", async () => {
  const r = await call(
    post(
      JSON.stringify([
        {
          type: "csp-violation",
          url: `https://remotiv.work/admin/jobs/${SECRET}`,
          body: {
            documentURL: `https://remotiv.work/admin/jobs/${SECRET}?x=1`,
            effectiveDirective: "script-src-elem",
            blockedURL: `https://evil.example/x.js?t=${SECRET}`,
            sample: "alert(1)",
          },
        },
        { type: "deprecation", body: { id: "x", message: "ayesha" } },
        {
          type: "csp-violation",
          body: {
            documentURL: "https://remotiv.work/ai-dashboard",
            effectiveDirective: "script-src",
            blockedURL: "eval",
          },
        },
      ]),
      "application/reports+json",
    ),
  );
  assert.equal(r.status, 204);
  assert.deepEqual(r.lines, [
    "[csp-report] directive=script-src-elem blocked=https://evil.example page=/admin",
    "[csp-report] directive=script-src blocked=eval page=/ai-dashboard",
  ]);
  noLeak(r.lines);
});

test("(c) junk: 204 and nothing logged", async () => {
  for (const junk of [
    "not json at all",
    "null",
    "42",
    '"a string"',
    '{"other":1}',
    "[]",
    '[{"type":"csp-violation"}]',
  ]) {
    const r = await call(post(junk, "text/plain"));
    assert.equal(r.status, 204, junk);
    assert.deepEqual(r.lines, [], junk);
  }
});

test("(d) an oversized body: 204 and nothing logged, even when it holds a valid report", async () => {
  const report = {
    "csp-report": {
      "document-uri": "https://remotiv.work/ai-dashboard",
      "effective-directive": "script-src-elem",
      "blocked-uri": "inline",
      "script-sample": "x".repeat(20_000),
    },
  };
  const r = await call(post(JSON.stringify(report)));
  assert.equal(r.status, 204);
  assert.deepEqual(r.lines, []);
});

test("rate-limited: 204, nothing read or logged; the limiter is the memory-only csp-report bucket", async () => {
  globalThis.__cspLimit = { calls: [], next: () => ({ ok: false, retryAfter: 60 }) };
  const r = await call(
    post(
      JSON.stringify({
        "csp-report": { "document-uri": "https://remotiv.work/x", "blocked-uri": "inline" },
      }),
    ),
  );
  assert.equal(r.status, 204);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(globalThis.__cspLimit.calls, [
    { max: 60, windowMs: 60_000, bucketKey: "csp-report", group: "local" },
  ]);
  globalThis.__cspLimit = { calls: [], next: () => ({ ok: true }) };
});
