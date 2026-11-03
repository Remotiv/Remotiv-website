/**
 * #24, the sidebar: a FAILED job-scope read shows no badges, where a genuinely
 * empty scope shows four zeros.
 *
 *   node --test "src/app/ai-dashboard/(gated)/scope-badges.test.ts"
 *
 * The layout used getJobScope, which turns a failed hiring-team read into
 * "assigned to no jobs", and answered that with four { count: 0, error: null }
 * badges: a confident 0 beside Jobs, Applicants, Messages and Interviews for a
 * member whose assignments could not be read. The decision now lives in
 * scopeBadges, fed by readJobScope, and is rendered by the same badgeCount the
 * layout always used.
 *
 * The first test is behavioural: the two paths render differently, and neither
 * reaches the count, which is the only place the layout can see a scope. The
 * second pins the layout to that path as source text, because a layout cannot
 * be imported here (session, redirect, Supabase). Reverting the layout to
 * getJobScope, or reading a scope outside the count, fails the second test.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { badgeCount, scopeBadges } from "./scope-badges.ts";

test("#24 FAILED scope read: no badge on any of the four; genuinely empty: four zeros", async () => {
  const counted = [];
  const count = async (scope) => {
    counted.push(scope);
    return [7, 7, 7, 7].map((n) => ({ count: n, error: null }));
  };
  const failed = await scopeBadges({ ok: false }, count);
  const empty = await scopeBadges({ ok: true, value: { scoped: true, jobIds: [] } }, count);
  assert.deepEqual(
    counted,
    [],
    "both paths are decided without counting, so no scope is handed out",
  );

  const assigned = { scoped: true, jobIds: ["j1"] };
  const real = await scopeBadges({ ok: true, value: assigned }, count);
  assert.deepEqual(counted, [assigned], "only a successful, non-empty read reaches the count");
  assert.deepEqual(real.map(badgeCount), [7, 7, 7, 7]);

  assert.deepEqual(
    failed.map(badgeCount),
    [undefined, undefined, undefined, undefined],
    "a failed scope read renders no badge, never a confident zero",
  );
  assert.deepEqual(empty.map(badgeCount), [0, 0, 0, 0], "a real empty scope still shows 0");
  assert.notDeepEqual(failed.map(badgeCount), empty.map(badgeCount));
});

test("#24 the layout reads the scope with readJobScope and decides through scopeBadges", () => {
  const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
  assert.ok(/await readJobScope\(ctx\)/.test(layout), "the layout keeps the failure");
  assert.ok(
    !/getJobScope\(|import \{[^}]*\bgetJobScope\b/.test(layout),
    "and no longer collapses it with getJobScope",
  );
  assert.ok(
    /await scopeBadges\(scopeRead, \(scope\) =>/.test(layout),
    "the four badges come from scopeBadges, and the scope only exists inside its count",
  );
  assert.ok(
    !/const scope\b|let scope\b|scopeRead\.value/.test(layout),
    "no scope value is derived from the read outside that count",
  );
});
