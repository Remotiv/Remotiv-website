/**
 * #72 step 13: a Content-Security-Policy-Report-Only without 'unsafe-inline'
 * beside the enforced policy, which is unchanged.
 *
 *   node --test src/lib/security/csp-report-only.test.ts
 *
 * Per route group:
 *   marketing (everything else)  enforced only, unchanged
 *   /ai-dashboard, /admin        enforced (unchanged) + Report-Only with a
 *                                per-request nonce, set by src/proxy.ts on the
 *                                request (Next stamps the nonce) and response
 *   /interview                   enforced only, unchanged (not built yet)
 * The proxy and next.config.ts run as shipped (real next/server). Synthetic.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  return next(specifier, context);
}`)}`,
);

const csp = await import("./csp.ts");
const { reportLines } = await import("./csp-report.ts");
const { proxy, config: proxyConfig } = await import("../../proxy.ts");
const { NextRequest } = await import("next/server.js");

const HOST = "jlezhdhzuyubhqvxdwvg.supabase.co";
const prod = { supabaseHost: HOST, isProduction: true };
const directive = (policy, name) =>
  policy.split("; ").find((d) => d === name || d.startsWith(`${name} `));

/* ── the enforced policy is unchanged ─────────────────────────── */

// Negative control: change anything in baseDirectives (or put 'unsafe-inline'
// in the wrong place) and this fails.
test("the ENFORCED policy is byte-identical to before: 'unsafe-inline' still allowed, nothing else moved", () => {
  assert.equal(
    csp.toCsp(csp.baseDirectives(prod)),
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://assets.calendly.com",
      "style-src 'self' 'unsafe-inline' https://assets.calendly.com",
      `img-src 'self' data: blob: https://${HOST} https://*.calendly.com`,
      "font-src 'self' data:",
      `connect-src 'self' https://${HOST} wss://${HOST} https://calendly.com https://*.calendly.com`,
      "frame-src 'self' https://calendly.com https://*.calendly.com",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
  assert.equal(
    csp.toCsp(csp.mediaDirectives(prod)),
    `${csp.toCsp(csp.baseDirectives(prod))}; media-src 'self' blob: https://${HOST}`,
  );
});

/* ── the Report-Only policy ───────────────────────────────────── */

// Negative control: put 'unsafe-inline' back into reportOnlyScriptSrc and this
// fails.
test("Report-Only script-src: this request's nonce and the scroll script's hash, never 'unsafe-inline' or (in production) 'unsafe-eval'", () => {
  const ro = csp.toCsp(csp.reportOnlyDirectives({ ...prod, nonce: "TESTNONCE" }));
  const scriptSrc = directive(ro, "script-src");
  assert.equal(
    scriptSrc,
    `script-src 'self' 'nonce-TESTNONCE' ${csp.SCROLL_RESTORATION_SHA256} https://assets.calendly.com`,
  );
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'|'unsafe-eval'/);
  assert.equal(directive(ro, "report-uri"), "report-uri /api/csp-report");
  // Every other directive is the enforced dashboard policy's, so reports are about scripts only.
  const enforced = csp.mediaDirectives(prod).filter((d) => !d.startsWith("script-src "));
  const others = csp
    .reportOnlyDirectives({ ...prod, nonce: "TESTNONCE" })
    .filter((d) => !d.startsWith("script-src ") && !d.startsWith("report-uri "));
  assert.deepEqual(others, enforced);
  // Development keeps 'unsafe-eval' (Next's dev runtime), as the enforced one does.
  assert.match(
    directive(
      csp.toCsp(csp.reportOnlyDirectives({ ...prod, isProduction: false, nonce: "N" })),
      "script-src",
    ),
    /'unsafe-eval'/,
  );
});

// Negative control: change one character of SCROLL_RESTORATION_SCRIPT (or of
// the hash) and this fails.
test("the scroll script's hash is the SHA-256 of the exact string the root layout renders", () => {
  const digest = createHash("sha256")
    .update(csp.SCROLL_RESTORATION_SCRIPT, "utf8")
    .digest("base64");
  assert.equal(csp.SCROLL_RESTORATION_SHA256, `'sha256-${digest}'`);
  const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /__html: SCROLL_RESTORATION_SCRIPT,/);
  // The layout's only other <script> elements are JSON-LD data, which no CSP blocks.
  const scripts = [...layout.matchAll(/<script\b([^>]*?)(?:\/>|>)/gs)].map((m) => m[1]);
  const executable = scripts.filter((attrs) => !/type="application\/ld\+json"/.test(attrs));
  assert.equal(executable.length, 1, "one executable inline script: the scroll script");
});

/* ── the proxy: dashboard and admin ───────────────────────────── */

const run = (path) => proxy(new NextRequest(new URL(path, "https://remotiv.work")));

// Negative control: stop setting the REQUEST header in src/proxy.ts and this
// fails: Next would have no nonce to stamp, and every script would be reported.
test("dashboard and admin: Report-Only on the response, the same policy (same nonce) on the request for Next", () => {
  for (const path of ["/ai-dashboard/applicants", "/admin/jobs"]) {
    const res = run(path);
    const sent = res.headers.get("content-security-policy-report-only");
    assert.ok(sent, `${path}: Report-Only header sent`);
    assert.equal(
      res.headers.get("x-middleware-request-content-security-policy-report-only"),
      sent,
      `${path}: the request carries the same policy, so Next stamps the same nonce`,
    );
    assert.match(directive(sent, "script-src"), /'nonce-[A-Za-z0-9+/]{22}=='/);
    assert.equal(
      res.headers.get("content-security-policy"),
      null,
      "the proxy never touches the enforced policy",
    );
    assert.equal(
      res.headers.get("x-middleware-request-x-pathname"),
      path,
      "the existing tags still go",
    );
  }
});

test("a fresh nonce per request", () => {
  const nonces = new Set();
  for (let i = 0; i < 50; i++) {
    const sent = run("/ai-dashboard").headers.get("content-security-policy-report-only");
    nonces.add(directive(sent, "script-src").match(/'nonce-([^']+)'/)[1]);
  }
  assert.equal(nonces.size, 50);
});

test("route groups: the proxy runs on the dashboard and admin only; marketing and interview pages get no Report-Only", () => {
  assert.deepEqual(proxyConfig.matcher, ["/admin/:path*", "/ai-dashboard/:path*"]);
});

/* ── next.config.ts: enforced headers per group, Permissions-Policy ── */

// Negative control: put interest-cohort=() back in either Permissions-Policy
// and this fails.
test("next.config headers: the enforced CSP per group is unchanged, no Report-Only there, interest-cohort gone", async () => {
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${HOST}`;
  const { default: config } = await import("../../../next.config.ts");
  const groups = await config.headers();
  const of = (source, key) =>
    groups.find((g) => g.source === source)?.headers.find((h) => h.key === key)?.value;
  assert.equal(of("/(.*)", "Content-Security-Policy"), csp.toCsp(csp.baseDirectives(prod)));
  assert.equal(
    of("/ai-dashboard/:path*", "Content-Security-Policy"),
    csp.toCsp(csp.mediaDirectives(prod)),
  );
  assert.equal(
    of("/interview/:path*", "Content-Security-Policy"),
    csp.toCsp(csp.mediaDirectives(prod)),
  );
  assert.equal(of("/(.*)", "Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(
    of("/interview/:path*", "Permissions-Policy"),
    "camera=(self), microphone=(self), geolocation=()",
  );
  for (const g of groups) {
    for (const h of g.headers) {
      assert.doesNotMatch(h.value, /interest-cohort/, `${g.source} ${h.key}`);
      assert.notEqual(
        h.key.toLowerCase(),
        "content-security-policy-report-only",
        "Report-Only is the proxy's, per request",
      );
    }
  }
});

/* ── the report endpoint's log lines ──────────────────────────── */

// Negative control: log the document URL as it is (not pageOf) and this fails.
test("a violation report becomes one line with no URL path, query, token or script sample", () => {
  const secret = "tok_9f8e7d6c5b4a";
  const legacy = {
    "csp-report": {
      "document-uri": `https://remotiv.work/ai-dashboard/applicants/${secret}?q=ayesha%40example.test`,
      "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem 'self'",
      "blocked-uri": "inline",
      "script-sample": 'self.__next_f.push([1,"Ayesha Khan, ayesha@example.test"])',
    },
  };
  const api = [
    {
      type: "csp-violation",
      body: {
        documentURL: `https://remotiv.work/interview/${secret}`,
        effectiveDirective: "script-src-elem",
        blockedURL: `https://evil.example/x.js?t=${secret}`,
        sample: "alert(1)",
      },
    },
    { type: "deprecation", body: { id: "x" } },
  ];
  const lines = [...reportLines(legacy), ...reportLines(api)];
  assert.deepEqual(lines, [
    "[csp-report] directive=script-src-elem blocked=inline page=/ai-dashboard",
    "[csp-report] directive=script-src-elem blocked=https://evil.example page=/interview",
  ]);
  for (const l of lines) {
    for (const leak of [secret, "ayesha", "Ayesha", "__next_f", "alert", "?"]) {
      assert.ok(!l.includes(leak), `"${leak}" in a log line`);
    }
  }
  assert.deepEqual(reportLines("not a report"), []);
  assert.deepEqual(reportLines({ other: 1 }), []);
  assert.equal(
    reportLines(Array.from({ length: 50 }, () => api[0])).length,
    10,
    "at most 10 per body",
  );
});
