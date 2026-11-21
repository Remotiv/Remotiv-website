/**
 * #19, bookings and calendar: a raw provider or database error never reaches
 * a person. It is replaced by a plain sentence, and the server log keeps a
 * code (the error's kind, name or SQLSTATE), never the provider's words.
 *
 *   node --test src/lib/calendar/user-errors.test.ts
 *
 * The helpers run as shipped; the wiring of every surface that could show one
 * (the booking link and final-interview link sends, the settings calendar
 * card, the candidate's cancel response, the notices' problem codes) is pinned
 * from source. Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/applicants-test-hook.mjs", import.meta.url));

const { BOOKING_EMAIL_NOT_SENT, bookingSendFailure } = await import("./send-failure.ts");
const { CONNECTION_PROBLEM, connectionProblem } = await import("./connections.ts");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Code only: comments may quote what the code must not do. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const NO_DASHES = /[–—]|\s-\s/;
const RAW = "550 5.1.1 mailbox unavailable for host@example.invalid (re_key_abc)";

const capture = (fn) => {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    return { out: fn(), lines };
  } finally {
    console.error = real;
  }
};

test("E1. a provider refusal becomes the plain sentence; the log carries the kind, not the provider's words", () => {
  const { out, lines } = capture(() =>
    bookingSendFailure(
      { ok: false, kind: "provider", message: RAW, logId: "log-1" },
      "booking link",
    ),
  );
  assert.equal(out, BOOKING_EMAIL_NOT_SENT);
  assert.deepEqual(lines, ["[booking] booking link: not sent (provider)"]);
  assert.ok(!lines.join(" ").includes("mailbox"), "the raw text is nowhere in the log");
});

test("E2. our own refusals keep their sentences (written for the sender): cap, not configured, duplicate, log, deleting", () => {
  for (const kind of ["cap", "not_configured", "duplicate", "log", "deleting"]) {
    const message = `Our sentence for ${kind}.`;
    const { out } = capture(() =>
      bookingSendFailure({ ok: false, kind, message, logId: null }, "x"),
    );
    assert.equal(out, message, kind);
  }
});

test("E3. the calendar card shows only our sentences: a stored provider message is replaced by its status's plain one", () => {
  for (const s of Object.values(CONNECTION_PROBLEM)) {
    assert.equal(connectionProblem("error", s), s, "a known sentence shows as written");
  }
  assert.equal(
    connectionProblem("error", "invalid_client: The OAuth client was not found."),
    CONNECTION_PROBLEM.generic,
  );
  assert.equal(connectionProblem("error", null), CONNECTION_PROBLEM.generic);
  assert.equal(
    connectionProblem("revoked", "Token has been expired or revoked."),
    CONNECTION_PROBLEM.revoked,
  );
  assert.equal(connectionProblem("active", "anything"), null);
});

test("E4. every sentence a person can see here has no dashes", () => {
  for (const s of [BOOKING_EMAIL_NOT_SENT, ...Object.values(CONNECTION_PROBLEM)]) {
    assert.doesNotMatch(s, NO_DASHES, s);
  }
});

test("E5. only our sentences can be stored as a connection's problem; a refresh failure stores none of Google's words", () => {
  const src = code(read("./connections.ts"));
  // Typed: markConnectionProblem takes one of CONNECTION_PROBLEM's values.
  assert.match(src, /message: \(typeof CONNECTION_PROBLEM\)\[keyof typeof CONNECTION_PROBLEM\],/);
  const calls = [...src.matchAll(/await markConnectionProblem\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.match(c, /CONNECTION_PROBLEM\.[a-zA-Z]+\s*,?\s*$/, c.trim());
    assert.doesNotMatch(c, /\bmessage\b/, "never the thrown message");
  }
  // The view never passes last_error through as it is.
  assert.match(src, /problem: connectionProblem\(row\.status, row\.last_error\),/);
  assert.doesNotMatch(src, /\(row\.last_error \?\? ""\)\.slice/);
  // The logs here carry codes.
  assert.match(
    src,
    /token refresh failed: \$\{revoked \? "invalid_grant" : err instanceof Error \? err\.name : "error"\}/,
  );
  assert.match(src, /storeTokens failed: \$\{error\.code \?\? "error"\}/);
  assert.match(src, /return \{ ok: false, error: error\.code \?\? "error" \};/);
});

test("E6. the booking link and the final-interview link return the plain sentence on a provider refusal", () => {
  const actions = code(read("../../app/ai-dashboard/(gated)/applicants/booking-actions.ts"));
  assert.match(
    actions,
    /return \{ success: false, error: bookingSendFailure\(outcome, "booking link"\) \};/,
  );
  assert.doesNotMatch(actions, /error: outcome\.message/);
  const notify = code(read("./notify.ts"));
  assert.match(
    notify,
    /if \(!outcome\.ok\) return \{ ok: false, message: bookingSendFailure\(outcome, "final link"\) \};/,
  );
  assert.doesNotMatch(notify, /message: outcome\.message/);
});

test("E7. the notices' problems are codes: no provider text, no thrown message, ever", () => {
  const notify = code(read("./notify.ts"));
  const problems = [...notify.matchAll(/const problem = ([^;]+);/g)].map((m) => m[1]);
  assert.equal(problems.length, 4);
  for (const p of problems) {
    assert.doesNotMatch(p, /\.message|sent\.error|String\(err\)/, p);
  }
});

test("E8. the candidate's cancel response says only whether each email went: no problems, no log id", () => {
  const route = code(read("../../app/api/book/[token]/route.ts"));
  assert.match(
    route,
    /\{ state: "cancelled", notices: \{ candidate: notices\.candidate, host: notices\.host \} \}/,
  );
  assert.doesNotMatch(route, /\{ state: "cancelled", notices \}/);
  // Every other failure the candidate can get is a fixed code the page words (_error-copy.ts).
  const fails = [...route.matchAll(/(?<!function )fail\(\s*[^,]+,\s*([^)]+)\)/g)].map((m) =>
    m[1].trim(),
  );
  assert.ok(fails.length >= 20, `${fails.length} failure replies found`);
  for (const f of fails) {
    assert.match(f, /^"[a-z_]+"$|^claim\.reason$|^moved\.reason$|^cancelled\.reason$/, f);
  }
});
