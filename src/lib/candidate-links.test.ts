/**
 * The candidate link builders and the redactor that scrubs their tokens from
 * communication_logs.body.
 *
 *   node --test src/lib/candidate-links.test.ts
 *
 * The redaction cases are fed from the builders THEMSELVES, not from copied
 * strings: a builder whose output survives redaction is a token that would be
 * stored raw, and this file is where that fails.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  bookingUrl,
  CANDIDATE_LINK_BUILDERS,
  interviewUrl,
  REDACTED_LINK,
  redactCandidateLinks,
} from "./candidate-links.ts";

/** Same shape the real minting functions produce: randomBytes(32) base64url. */
const token = () => randomBytes(32).toString("base64url");

test("builders put the raw token in the path under their own prefix", () => {
  const t = token();
  assert.equal(interviewUrl(t), `https://remotiv.work/interview/${t}`);
  assert.equal(bookingUrl(t), `https://remotiv.work/book/${t}`);
});

test("every builder's output is redacted, as an href and as bare text", () => {
  for (const [name, build] of Object.entries(CANDIDATE_LINK_BUILDERS)) {
    const t = token();
    const url = build(t);
    const html = `<p><a href="${url}" style="color:#7E47FF">Start</a></p><p>${url}</p>`;
    const out = redactCandidateLinks(html);
    assert.ok(!out.includes(t), `${name}: token survived redaction`);
    assert.equal(
      (out.match(new RegExp(REDACTED_LINK.replace(/[[\]]/g, "\\$&"), "g")) ?? []).length,
      2,
      `${name}: both occurrences replaced`,
    );
    // The rest of the markup, including the link text, is untouched.
    assert.ok(out.includes('style="color:#7E47FF">Start</a>'), `${name}: markup kept`);
  }
});

test("redaction is idempotent", () => {
  const once = redactCandidateLinks(`<a href="${interviewUrl(token())}">x</a>`);
  assert.equal(redactCandidateLinks(once), once);
});

test("redaction leaves everything that is not a candidate token alone", () => {
  const untouched = [
    // The unsubscribe footer: an HMAC claim, deliberately kept (see the redactor).
    `<a href="https://remotiv.work/api/unsubscribe?token=${token()}">Unsubscribe</a>`,
    // A job slug long enough to look like a token, under a path that is not one.
    `<a href="https://remotiv.work/jobs/senior-backend-engineer-remote-europe-2026">Role</a>`,
    // The words on their own.
    "<p>Book your interview. Start your interview.</p>",
    // A short id under a token path: too short to be a token, left as is.
    '<a href="https://remotiv.work/interview/abc123">x</a>',
  ];
  for (const html of untouched) {
    assert.equal(redactCandidateLinks(html), html, html);
  }
});

test("a body with several links loses every token and nothing else", () => {
  const a = token();
  const b = token();
  const html = `<a href="${interviewUrl(a)}">one</a> then <a href="${bookingUrl(b)}">two</a>`;
  const out = redactCandidateLinks(html);
  assert.ok(!out.includes(a) && !out.includes(b));
  assert.equal(
    out,
    `<a href="https://remotiv.work/interview/${REDACTED_LINK}">one</a> then <a href="https://remotiv.work/book/${REDACTED_LINK}">two</a>`,
  );
});
