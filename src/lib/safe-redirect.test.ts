/**
 * The redirect-target filter shared by /auth/callback, the dashboard's
 * recover handler (via safeNext), and the signin/signup clients.
 *
 *   node --test src/lib/safe-redirect.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNext, safeRelativePath } from "./safe-redirect.ts";

const FALLBACK = "/browse-talent";

test("safeRelativePath keeps a same-origin path, query included", () => {
  assert.equal(safeRelativePath("/account", FALLBACK), "/account");
  assert.equal(
    safeRelativePath("/browse-talent?confirmed=true", FALLBACK),
    "/browse-talent?confirmed=true",
  );
});

test("safeRelativePath collapses every shape that changes the host", () => {
  // Each of these, appended to an origin, lands on a host the attacker owns.
  for (const bad of ["@evil.com", ":443@evil.com", ".evil.com", "-evil.com", "https://evil.com"]) {
    assert.equal(safeRelativePath(bad, FALLBACK), FALLBACK, `for ${JSON.stringify(bad)}`);
  }
});

test("safeRelativePath collapses the shapes a relative redirect would follow off-origin", () => {
  for (const bad of ["//evil.com", "/\\evil.com", "/x\r\nSet-Cookie: a=b", "/x\nfoo"]) {
    assert.equal(safeRelativePath(bad, FALLBACK), FALLBACK, `for ${JSON.stringify(bad)}`);
  }
});

test("safeRelativePath returns the caller's fallback for nothing at all", () => {
  assert.equal(safeRelativePath(null, FALLBACK), FALLBACK);
  assert.equal(safeRelativePath(undefined, FALLBACK), FALLBACK);
  assert.equal(safeRelativePath("", FALLBACK), FALLBACK);
  assert.equal(safeRelativePath("", "/ai-dashboard"), "/ai-dashboard");
});

// Moved verbatim from session-cookie.test.ts when safeNext moved here.
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
