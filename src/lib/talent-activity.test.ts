/**
 * The talent activity write (#61): last_active_at only.
 *
 *   node --test "src/lib/talent-activity.test.ts"
 *
 * Drives the real touchLastActive and touchLastActiveForUser against a fake
 * service client. Before #61 both updates also sent retention_warned_at and
 * retention_keep_token_hash; the second column does not exist in production,
 * so every write failed whole and last_active_at was never recorded. These
 * tests pin the update body to the one column that exists.
 *
 * TALENT_ACTIVITY_UNDER_TEST points the suite at another copy of the module
 * (the negative control runs it against the pre-#61 file).
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { call, fakeService } from "../test-support/fake-postgrest.mjs";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/fake-service-client-hook.mjs", import.meta.url));

const target = process.env.TALENT_ACTIVITY_UNDER_TEST
  ? pathToFileURL(process.env.TALENT_ACTIVITY_UNDER_TEST).href
  : "./talent-activity.ts";
const { touchLastActive, touchLastActiveForUser } = await import(target);

async function run(fn) {
  const service = fakeService(() => ({ data: null, error: null }));
  globalThis.__fakeServiceClientForTests = () => service;
  try {
    await fn();
  } finally {
    delete globalThis.__fakeServiceClientForTests;
  }
  return service;
}

function assertLastActiveOnly(service, filter) {
  assert.equal(service.queries.length, 1, "exactly one query");
  const q = service.queries[0];
  assert.equal(q.table, "talent_profiles");
  const body = call(q.calls, "update")?.[1];
  assert.ok(body, "an update was sent");
  assert.deepEqual(Object.keys(body), ["last_active_at"]);
  assert.ok(!Number.isNaN(Date.parse(body.last_active_at)), "last_active_at is a timestamp");
  for (const key of Object.keys(body)) {
    assert.ok(!key.startsWith("retention_"), `update carries ${key}`);
  }
  assert.deepEqual(call(q.calls, "eq"), filter);
}

test("a: touchLastActive updates last_active_at and no retention_* column", async () => {
  const service = await run(() => touchLastActive("profile-aaaaaa"));
  assertLastActiveOnly(service, ["eq", "id", "profile-aaaaaa"]);
});

test("b: touchLastActiveForUser updates last_active_at and no retention_* column", async () => {
  const service = await run(() => touchLastActiveForUser("user-bbbbbb"));
  assertLastActiveOnly(service, ["eq", "user_id", "user-bbbbbb"]);
});

test("c: a hire_remote_profiles profile is not touched at all (unchanged)", async () => {
  const service = await run(() => touchLastActive("profile-cccccc", "hire_remote_profiles"));
  assert.equal(service.queries.length, 0);
});
