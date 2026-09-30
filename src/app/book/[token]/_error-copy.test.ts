/**
 * Every code the booking route can return has candidate copy, and the copy
 * for a failure the candidate cannot fix points at the recruiter, not at
 * Remotiv (Phase 6, A6-4).
 *
 *   node --test "src/app/book/[token]/_error-copy.test.ts"
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ERROR_COPY, errorCopyFor, RECOVERY_LINE } from "./_error-copy.ts";

const route = readFileSync(new URL("../../api/book/[token]/route.ts", import.meta.url), "utf8");
const bookings = readFileSync(
  new URL("../../../lib/calendar/bookings.ts", import.meta.url),
  "utf8",
);

test("every literal code the route or the bookings library can produce is mapped", () => {
  const codes = new Set();
  for (const m of route.matchAll(/fail\(\d+, "([a-z_]+)"\)/g)) codes.add(m[1]);
  for (const m of bookings.matchAll(/reason: "([a-z_]+)"/g)) codes.add(m[1]);
  for (const m of bookings.matchAll(/reason:\s*(?:"([a-z_]+)"\s*\|\s*)+"([a-z_]+)"/g)) {
    for (const c of m[0].match(/"([a-z_]+)"/g) ?? []) codes.add(c.replace(/"/g, ""));
  }
  assert.ok(codes.size >= 8, `found ${codes.size} codes`);
  const missing = [...codes].filter((c) => !ERROR_COPY[c]);
  assert.deepEqual(missing, [], `codes without copy: ${missing.join(", ")}`);
});

test("the three codes that used to fall through say what happened and what to do", () => {
  for (const code of ["too_late", "write_failed", "bad_slot"]) {
    const copy = ERROR_COPY[code];
    assert.ok(copy, code);
    assert.doesNotMatch(copy, /check your connection/i, `${code}: not a connection problem`);
  }
  assert.match(ERROR_COPY.too_late, /can't be changed now/);
  assert.match(ERROR_COPY.too_late, /still cancel/);
  assert.match(ERROR_COPY.write_failed, /exactly as it was/);
  assert.match(ERROR_COPY.bad_slot, /Pick a time/);
});

test("recovery points at the recruiter who invited them, never at a reply to Remotiv", () => {
  assert.equal(
    RECOVERY_LINE,
    "Try again in a moment. If it still doesn't work, contact the recruiter who invited you.",
  );
  for (const [code, copy] of Object.entries(ERROR_COPY)) {
    assert.doesNotMatch(copy, /reply to (the|your|it)/i, `${code} tells the candidate to reply`);
    assert.doesNotMatch(copy, /remotiv\.work/i, code);
  }
});

test("an unknown or missing code falls back to the neutral network copy", () => {
  assert.equal(errorCopyFor("no_such_code"), ERROR_COPY.network);
  assert.equal(errorCopyFor(undefined), ERROR_COPY.network);
  assert.match(ERROR_COPY.network, /nothing was changed/);
});
