/**
 * The fail-closed development guard, every row of the table.
 *
 *   node --test src/lib/supabase/guard.test.ts
 *
 * The module is pure and imports nothing from Next or Supabase, so this runs
 * under bare node:test with no resolve hook.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertServiceClientAllowed,
  decideServiceClientAccess,
  OVERRIDE_NAME,
  PROJECT_ENV_NAME,
  resetGuardWarningForTests,
} from "./guard.ts";

const dev = (extra = {}) => ({ NODE_ENV: "development", ...extra });

/* ── the six rows ───────────────────────────────────────────── */

test("development + development -> allowed, no warning", () => {
  const d = decideServiceClientAccess(dev({ SUPABASE_PROJECT_ENV: "development" }));
  assert.deepEqual(d, { allowed: true, warning: null });
});

test("development + production -> blocked", () => {
  const d = decideServiceClientAccess(dev({ SUPABASE_PROJECT_ENV: "production" }));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /is "production"/);
});

test("development + missing -> blocked (missing is not permissive)", () => {
  for (const env of [dev(), dev({ SUPABASE_PROJECT_ENV: "" }), dev({ SUPABASE_PROJECT_ENV: undefined })]) {
    const d = decideServiceClientAccess(env);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /is not set/);
  }
});

test("development + unknown value -> blocked", () => {
  for (const value of ["staging", "dev", "Development", "prod", "true", "1"]) {
    const d = decideServiceClientAccess(dev({ SUPABASE_PROJECT_ENV: value }));
    assert.equal(d.allowed, false, `value ${JSON.stringify(value)} should block`);
    assert.match(d.reason, /unrecognised value/);
    // The reason names the category, never the value itself. Checked as a
    // quoted token: the guidance text legitimately contains the words
    // "development" and "production", which contain "dev" and "prod".
    assert.ok(!d.reason.includes(JSON.stringify(value)), "reason must not echo the value");
  }
});

test("development + explicit override -> allowed with a loud warning", () => {
  const d = decideServiceClientAccess(dev({ ALLOW_PRODUCTION_DB_FROM_DEV: "1" }));
  assert.equal(d.allowed, true);
  assert.match(d.warning, /may be against production/);
  assert.match(d.warning, new RegExp(OVERRIDE_NAME));
  // The override wins even when the project env says production.
  const d2 = decideServiceClientAccess(
    dev({ ALLOW_PRODUCTION_DB_FROM_DEV: "1", SUPABASE_PROJECT_ENV: "production" }),
  );
  assert.equal(d2.allowed, true);
  // Only the exact value "1" is an override; anything else is not.
  for (const v of ["true", "yes", "0", ""]) {
    assert.equal(decideServiceClientAccess(dev({ ALLOW_PRODUCTION_DB_FROM_DEV: v })).allowed, false, v);
  }
});

test("production runtime -> normal behaviour regardless of the other variables", () => {
  for (const NODE_ENV of ["production", "test", undefined, ""]) {
    for (const SUPABASE_PROJECT_ENV of [undefined, "production", "development", "garbage"]) {
      const d = decideServiceClientAccess({ NODE_ENV, SUPABASE_PROJECT_ENV });
      assert.deepEqual(d, { allowed: true, warning: null }, `${NODE_ENV}/${SUPABASE_PROJECT_ENV}`);
    }
  }
});

/* ── the impure wrapper ─────────────────────────────────────── */

test("assertServiceClientAllowed throws on a blocked decision with the reason", () => {
  assert.throws(
    () => assertServiceClientAllowed(dev({ SUPABASE_PROJECT_ENV: "production" }), () => {}),
    new RegExp(PROJECT_ENV_NAME),
  );
  assert.throws(() => assertServiceClientAllowed(dev(), () => {}), /is not set/);
});

test("assertServiceClientAllowed passes silently when allowed, and never throws in production", () => {
  const logged = [];
  assertServiceClientAllowed(dev({ SUPABASE_PROJECT_ENV: "development" }), (m) => logged.push(m));
  assertServiceClientAllowed({ NODE_ENV: "production" }, (m) => logged.push(m));
  assert.deepEqual(logged, []);
});

test("the override warning is emitted once per process, not once per client", () => {
  resetGuardWarningForTests();
  const logged = [];
  const env = dev({ ALLOW_PRODUCTION_DB_FROM_DEV: "1" });
  assertServiceClientAllowed(env, (m) => logged.push(m));
  assertServiceClientAllowed(env, (m) => logged.push(m));
  assertServiceClientAllowed(env, (m) => logged.push(m));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /against production/);
  resetGuardWarningForTests();
});

/* ── the guard is wired where the key is used ───────────────── */

test("every service-role client construction calls the guard first", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const server = src("./server.ts");
  assert.match(server, /assertServiceClientAllowed\(\)/);
  // The call sits before the client is built, not after.
  assert.ok(
    server.indexOf("assertServiceClientAllowed()") < server.indexOf("process.env.SUPABASE_SERVICE_ROLE_KEY"),
    "guard must run before the key is read",
  );
  for (const rel of ["../company-identity.ts", "../../app/admin/clients/actions.ts"]) {
    const s = src(rel);
    assert.match(s, /assertServiceClientAllowed\(\)/, `${rel} uses the key without the guard`);
  }
});
