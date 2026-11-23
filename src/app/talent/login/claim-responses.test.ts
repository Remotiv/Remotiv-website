/**
 * #57 follow-up: a rate-limit refusal on the talent login page (429 over the
 * limit, 503 the limit store could not answer) never reads as a sent code or
 * a bad link; the admin CV extraction callers say to wait on a 503.
 *
 *   node --test "src/app/talent/login/claim-responses.test.ts"
 *
 * claim-responses.ts runs as shipped: it is the page's whole decision. The
 * page (login-client.tsx) and the admin dashboard run their fetches inside
 * React handlers and effects, which this repo cannot run without a DOM, so
 * their wiring to these decisions is pinned in source. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { verifyOutcome, initiateOutcome, REASON_BANNER } = await import("./claim-responses.ts");
const { TRY_AGAIN_SOON, TOO_MANY_ATTEMPTS, refusalMessage } = await import(
  "../../../lib/rate-limit-copy.ts"
);

const CALM_429 = "Too many attempts. Please try again in a minute.";
const CALM_503 = "Please try again in a minute.";
// What the routes send on a refusal (claim/* since #57 slice 3).
const BODY_429 = { error: "Too many requests" };
const BODY_503 = { error: CALM_503 };

test("the two sentences, and which status gets which", () => {
  assert.equal(TOO_MANY_ATTEMPTS, CALM_429);
  assert.equal(TRY_AGAIN_SOON, CALM_503);
  assert.equal(refusalMessage(429), CALM_429);
  assert.equal(refusalMessage(503), CALM_503);
  for (const s of [200, 400, 403, 404, 500, 502]) assert.equal(refusalMessage(s), null, String(s));
  assert.doesNotMatch(`${CALM_429} ${CALM_503}`, /[–—]/);
});

// Negative control: drop the refusal check from verifyOutcome and a 429
// lands on the "We couldn't recognise that invite link" banner.
test("claim/verify refused: the calm sentence, never the invalid-link banner", () => {
  assert.deepEqual(verifyOutcome(429, BODY_429), { kind: "refused", message: CALM_429 });
  assert.deepEqual(verifyOutcome(503, BODY_503), { kind: "refused", message: CALM_503 });
  for (const banner of Object.values(REASON_BANNER)) {
    assert.notEqual(verifyOutcome(429, BODY_429).message, banner);
  }
  // The other answers are as before.
  assert.deepEqual(verifyOutcome(200, { ok: true, email: "a@example.test" }), {
    kind: "verified",
    email: "a@example.test",
  });
  assert.deepEqual(verifyOutcome(200, { ok: false, reason: "expired" }), {
    kind: "recoverable",
    banner: REASON_BANNER.expired,
  });
  assert.deepEqual(verifyOutcome(200, { ok: false }), {
    kind: "recoverable",
    banner: REASON_BANNER.invalid,
  });
  assert.deepEqual(verifyOutcome(200, { ok: false, reason: "already_claimed" }), {
    kind: "terminal",
    reason: "already_claimed",
  });
});

test("claim/initiate: only an ok answer is a sent code; a refusal is said as one", () => {
  assert.deepEqual(initiateOutcome(429, BODY_429), { kind: "refused", message: CALM_429 });
  assert.deepEqual(initiateOutcome(503, BODY_503), { kind: "refused", message: CALM_503 });
  assert.deepEqual(initiateOutcome(200, { ok: true, message: "Check your email." }), {
    kind: "sent",
    message: "Check your email.",
  });
  assert.deepEqual(initiateOutcome(200, { ok: true }), { kind: "sent", message: null });
  assert.deepEqual(initiateOutcome(200, { ok: false, reason: "email_conflict" }), {
    kind: "conflict",
  });
  assert.deepEqual(initiateOutcome(500, {}), { kind: "failed" });
  assert.deepEqual(initiateOutcome(400, { ok: false }), { kind: "failed" });
});

const login = readFileSync(new URL("./login-client.tsx", import.meta.url), "utf8");
const code = login.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// Negative control: put back the old token path (code shown unless the
// answer was email_conflict) and the first assertion fails.
test("login page: 'We sent a 6-digit code' only on a sent answer, on every path", () => {
  assert.match(
    code,
    /\} else if \(sent\.kind === "sent"\) \{\s*setStep\(\{ kind: "code", email: verified\.email \}\);\s*setMessage\(`We sent a 6-digit code to \$\{verified\.email\}\.`\);/,
    "the invite-link path",
  );
  assert.equal((code.match(/We sent a 6-digit code/g) ?? []).length, 1);
  assert.match(code, /setMessage\(`We sent a new 6-digit code to \$\{targetEmail\}\.`\)/);
  // Every call site decides through initiateOutcome and verifyOutcome.
  assert.equal((code.match(/initiateOutcome\(/g) ?? []).length, 3);
  assert.equal((code.match(/verifyOutcome\(/g) ?? []).length, 1);
  assert.doesNotMatch(code, /status === 429/, "no ad hoc status checks left");
  // A refused code send on the invite-link path stays on the email step, email filled in.
  assert.match(
    code,
    /setStep\(\{ kind: "email" \}\);\s*setEmail\(verified\.email\);\s*setError\(\s*sent\.kind === "refused" \? sent\.message : "Something went wrong\. Please try again\.",?\s*\);/,
  );
});

test("login page: a refused link check shows the sentence and a retry, no banner", () => {
  assert.match(
    code,
    /if \(verified\.kind === "refused"\) \{\s*setStep\(\{ kind: "email" \}\);\s*setError\(verified\.message\);\s*setCanRetryLink\(true\);\s*return;/,
  );
  assert.match(code, /setNotice\(verified\.banner\)/, "the banner only from a recoverable answer");
  assert.equal((code.match(/setNotice\(/g) ?? []).length, 1);
  assert.match(code, /\}, \[token, verifyRun\]\);/, "the retry re-runs the check");
  assert.match(code, /onClick=\{\(\) => setVerifyRun\(\(n\) => n \+ 1\)\}/);
});

const dash = readFileSync(
  new URL("../../admin/_components/applications-dashboard.tsx", import.meta.url),
  "utf8",
);

test("admin Move to Talent (extract-cv): a 503 toasts the sentence; a 429 is as before", () => {
  assert.match(dash, /unavailable = res\.status === 503;/);
  assert.match(
    dash,
    /if \(unavailable\) \{\s*setToast\(TRY_AGAIN_SOON\);\s*\} else if \(serverReturnedEmpty\) \{\s*setToast\(prefillFailureMessage\(emptyReason\)\);/,
  );
  assert.match(dash, /import \{ TRY_AGAIN_SOON \} from "@\/lib\/rate-limit-copy";/);
});

test("admin bulk upload (extract-cv-basic): a 503 marks the batch and the review screen says to wait", () => {
  assert.match(
    dash,
    /if \(!res\.ok\) return \{ fields: null, unavailable: res\.status === 503 \};/,
  );
  assert.match(dash, /if \(reply\.unavailable\) aiUnavailable = true;/);
  assert.match(dash, /setAiExtractUnavailable\(aiUnavailable\);\s*setStage\("review"\);/);
  assert.match(
    dash,
    /\{aiExtractUnavailable && \(\s*<p[^>]*data-ai-extract-unavailable[^>]*>\s*\{TRY_AGAIN_SOON\}\s*<\/p>/,
  );
});
