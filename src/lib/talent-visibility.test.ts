/**
 * The visibility rule, and the two places it is written.
 *
 * The rule exists twice on purpose: once in TypeScript (publicTalent) and once
 * in SQL (migration 034's new-unlock gate), because a Postgres function cannot
 * import a module. Nothing but this file stops the two drifting apart.
 *
 * ── Why this is not "assert both files mention approved_at" ──
 *
 * A test that reads both files and checks each contains the expected strings
 * passes even after someone edits one of them, because it never compares them
 * to EACH OTHER. So the tests below EXTRACT the condition list from each source
 * and require set equality. Then, because a parser that silently matches
 * nothing would make every such test vacuously green, each extraction asserts
 * its own arity before any comparison happens. That guard is the point: three
 * times this session a check passed only because its inputs were empty.
 *
 *   node --test src/lib/talent-visibility.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isRemotePublic,
  isTalentPublic,
  PUBLIC_REMOTE_STATUSES,
} from "./talent-visibility.ts";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const helper = src("./talent-visibility.ts");
const migration = src("./supabase/migrations/034_unlock_requires_public_profile.sql");

/* ── extraction ─────────────────────────────────────────────── */

/**
 * Pull the conditions out of a TypeScript filter chain and canonicalise them
 * into SQL-shaped strings. Exported shape: ["approved_at is not null", ...].
 */
export function conditionsFromTs(source, fnName) {
  const start = source.indexOf(`export function ${fnName}<T>(query: T): T {`);
  if (start === -1) throw new Error(`${fnName} not found`);
  const end = source.indexOf("\n}", start);
  if (end === -1) throw new Error(`${fnName} body not terminated`);
  const body = source.slice(start, end);
  const out = [];
  for (const m of body.matchAll(/\.not\(\s*"([a-z_]+)"\s*,\s*"is"\s*,\s*null\s*\)/g)) {
    out.push(`${m[1]} is not null`);
  }
  for (const m of body.matchAll(/\.eq\(\s*"([a-z_]+)"\s*,\s*(true|false)\s*\)/g)) {
    out.push(`${m[1]} = ${m[2]}`);
  }
  return out.sort();
}

/**
 * Pull the conditions out of the migration's step-3b `not exists (...)` block.
 * Anchored on the numbered comment so a later edit that moves the gate is a
 * loud failure rather than a silent miss.
 */
export function conditionsFromSql(source) {
  const start = source.indexOf("-- 3b.");
  if (start === -1) throw new Error("step 3b marker not found in migration");
  const end = source.indexOf("-- 4.", start);
  if (end === -1) throw new Error("step 4 marker not found after 3b");
  const block = source.slice(start, end);
  const where = block.slice(block.indexOf("where id = p_candidate_id"));
  const out = [];
  for (const line of where.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("and ")) continue;
    out.push(t.slice(4).replace(/\s+/g, " ").trim());
  }
  return out.sort();
}

/* ── the guard that makes the comparison meaningful ─────────── */

test("the extractors find what they claim to find (guards against a vacuous pass)", () => {
  const ts = conditionsFromTs(helper, "publicTalent");
  const sql = conditionsFromSql(migration);
  assert.equal(ts.length, 3, `extracted ${ts.length} TS conditions, expected 3: ${ts}`);
  assert.equal(sql.length, 3, `extracted ${sql.length} SQL conditions, expected 3: ${sql}`);
  // And that they are the conditions we think, not three of something else.
  assert.deepEqual(ts, ["approved_at is not null", "is_archived = false", "is_paused = false"]);
});

test("the TypeScript and SQL talent predicates are the same rule", () => {
  assert.deepEqual(conditionsFromTs(helper, "publicTalent"), conditionsFromSql(migration));
});

test("the comparison detects divergence (control: flip one condition in a copy)", () => {
  // Same extractor, same comparison, one condition changed. If this passes, the
  // test above proves nothing.
  const tampered = migration.replace("and is_paused = false", "and is_paused = true");
  assert.notEqual(tampered, migration, "the control edit did not apply");
  assert.throws(
    () =>
      assert.deepEqual(conditionsFromTs(helper, "publicTalent"), conditionsFromSql(tampered)),
    /is_paused/,
  );
  // And a DROPPED condition is caught too, not just a changed one.
  const dropped = migration.replace("      and is_archived = false\n", "");
  assert.equal(conditionsFromSql(dropped).length, 2);
  assert.throws(() =>
    assert.deepEqual(conditionsFromTs(helper, "publicTalent"), conditionsFromSql(dropped)),
  );
});

/* ── the in-memory predicates ───────────────────────────────── */

test("isTalentPublic fails closed on every hidden shape, including nulls", () => {
  assert.equal(isTalentPublic({ approved_at: "2026-01-01", is_paused: false, is_archived: false }), true);
  assert.equal(isTalentPublic({ approved_at: null, is_paused: false, is_archived: false }), false);
  assert.equal(isTalentPublic({ approved_at: "x", is_paused: true, is_archived: false }), false);
  assert.equal(isTalentPublic({ approved_at: "x", is_paused: false, is_archived: true }), false);
  // A null flag is not false. Treating it as visible would be the fail-open bug.
  assert.equal(isTalentPublic({ approved_at: "x", is_paused: null, is_archived: false }), false);
  assert.equal(isTalentPublic({ approved_at: "x", is_paused: false, is_archived: null }), false);
  assert.equal(isTalentPublic(null), false);
  assert.equal(isTalentPublic(undefined), false);
});

test("isRemotePublic is a whitelist, so an unknown status is hidden", () => {
  for (const status of PUBLIC_REMOTE_STATUSES) {
    assert.equal(isRemotePublic({ approved_at: "2026-01-01", status }), true, status);
  }
  for (const status of ["paused", "archived", "pending", "", "APPROVED", "something_new"]) {
    assert.equal(isRemotePublic({ approved_at: "2026-01-01", status }), false, status);
  }
  assert.equal(isRemotePublic({ approved_at: null, status: "approved" }), false);
  assert.equal(isRemotePublic({ approved_at: "x", status: null }), false);
  assert.equal(isRemotePublic(null), false);
});

test("the whitelist is exactly the three visible states", () => {
  assert.deepEqual([...PUBLIC_REMOTE_STATUSES], ["approved", "shortlisted", "placed"]);
  // The blacklist the marketplace and the page used to disagree over is gone.
  assert.doesNotMatch(helper, /not\(\s*"status"\s*,\s*"in"/);
});

/* ── migration 034: order of operations and credit safety ───── */

test("034: visibility is checked before anything is spent", () => {
  const gate = migration.indexOf("-- 3b.");
  const decrement = migration.indexOf("update subscriptions");
  const insert = migration.indexOf("insert into unlock_events");
  assert.ok(gate > 0, "gate present");
  assert.ok(decrement > 0 && insert > 0, "both writes present");
  assert.ok(gate < decrement, "gate must precede the credit decrement");
  assert.ok(gate < insert, "gate must precede the unlock insert");
  // Exactly two writes in the whole function, so nothing else can run earlier.
  assert.equal((migration.match(/^\s*update subscriptions$/gm) ?? []).length, 1);
  assert.equal((migration.match(/insert into unlock_events/g) ?? []).length, 1);
  // The gate's own branch returns instead of falling through.
  const branch = migration.slice(gate, migration.indexOf("-- 4.", gate));
  assert.match(branch, /return json_build_object\('success', false, 'error', 'candidate_not_found'\)/);
  assert.doesNotMatch(branch, /update |insert |delete /);
});

test("034: an existing unlock is answered before the visibility gate", () => {
  const existing = migration.indexOf("if found then");
  const gate = migration.indexOf("-- 3b.");
  assert.ok(existing > 0 && gate > 0);
  assert.ok(
    existing < gate,
    "the already-unlocked branch must return first, or a pause would revoke access someone paid for",
  );
  const branch = migration.slice(existing, gate);
  assert.match(branch, /'already_unlocked', true/);
  assert.doesNotMatch(branch, /update |insert |delete /, "the free re-click spends nothing");
});

test("034: the refusal says nothing about why", () => {
  // The same error code as a missing row, so hidden/paused/archived/nonexistent
  // are indistinguishable to the caller.
  assert.equal((migration.match(/'candidate_not_found'/g) ?? []).length, 2);
  for (const leak of [/'paused'/, /'archived'/, /'hidden'/, /'not_public'/, /'not_visible'/]) {
    assert.doesNotMatch(migration, leak, `migration leaks the reason: ${leak}`);
  }
  // And the recruiter-facing wording does not assert non-existence.
  const actions = src("../app/browse-talent/actions.ts");
  assert.match(actions, /candidate_not_found: "This profile is not available\."/);
  assert.doesNotMatch(actions, /candidate_not_found: "Candidate not found\."/);
});

test("034: signature, return shape and grants are unchanged from 002", () => {
  const original = src("./supabase/migrations/002_unlock_events.sql");
  for (const contract of [
    /create or replace function unlock_candidate\(p_candidate_id uuid\)\nreturns json/,
    /security definer/,
    /set search_path = public/,
    /'not_authenticated'/,
    /'not_subscribed'/,
    /'no_credits'/,
    /for update/,
    /grant execute on function unlock_candidate\(uuid\) to authenticated/,
  ]) {
    assert.match(original, contract, `002 baseline missing ${contract}`);
    assert.match(migration, contract, `034 dropped ${contract}`);
  }
  // 034 must not revoke or delete anything that already exists.
  assert.doesNotMatch(migration, /delete from unlock_events|drop table|truncate/i);
});

/* ── every public read path goes through the helper ─────────── */

const GATED_PATHS = [
  ["../app/api/ai-matching/route.ts", "publicTalent"],
  ["../app/talent/[id]/opengraph-image.tsx", "publicTalent"],
  ["../app/talent/[id]/opengraph-image.tsx", "publicRemote"],
  ["../app/api/hire-remote/candidates/route.ts", "publicRemote"],
  ["../app/browse-talent/page.tsx", "publicTalent"],
  ["./ai-matching.ts", "publicTalent"],
  ["../app/browse-talent/actions.ts", "isTalentPublic"],
  ["../app/talent/[id]/page.tsx", "isTalentPublic"],
  ["../app/talent/[id]/page.tsx", "isRemotePublic"],
];

test("every public profile read path calls the shared predicate", () => {
  for (const [rel, symbol] of GATED_PATHS) {
    const s = src(rel);
    assert.match(s, new RegExp(`\\b${symbol}\\(`), `${rel} does not call ${symbol}()`);
    assert.match(s, /from "@\/lib\/talent-visibility"/, `${rel} does not import the helper`);
  }
});

test("no public path still writes the visibility rule by hand", () => {
  for (const rel of [
    "../app/api/ai-matching/route.ts",
    "../app/talent/[id]/opengraph-image.tsx",
    "../app/api/hire-remote/candidates/route.ts",
    "../app/browse-talent/page.tsx",
    "./ai-matching.ts",
    "../app/talent/[id]/page.tsx",
  ]) {
    const s = src(rel);
    assert.doesNotMatch(s, /\.eq\("is_paused", false\)/, `${rel}: ad-hoc is_paused filter`);
    assert.doesNotMatch(s, /\.eq\("is_archived", false\)/, `${rel}: ad-hoc is_archived filter`);
    assert.doesNotMatch(s, /\.eq\("status", "approved"\)/, `${rel}: ad-hoc status filter`);
    assert.doesNotMatch(s, /"\(paused,archived\)"/, `${rel}: ad-hoc status blacklist`);
  }
});

test("the cache rehydration is filtered, and orphaned entries are dropped", () => {
  const route = src("../app/api/ai-matching/route.ts");
  // The rehydration query goes through the helper.
  assert.match(route, /publicTalent\(\s*supabase\.from\("talent_profiles"\)/);
  // No bare approved_at-only rehydration remains.
  assert.doesNotMatch(route, /\.in\("id", ids\)\s*\n\s*\.not\("approved_at", "is", null\)/);
  // A cached id that no longer hydrates is skipped rather than rendered empty.
  assert.match(route, /const c = byId\.get\(m\.candidate_id\);\s*\n\s*if \(!c\) continue;/);
  // And no per-profile invalidation was added.
  assert.doesNotMatch(route, /delete\(\)[\s\S]{0,60}ai_match_cache/);
});

/* ── the owner-gated unavailable state ──────────────────────── */

test("hidden profile: 404 for a stranger, the notice only for the owner", () => {
  const page = src("../app/talent/[id]/page.tsx");
  // Three outcomes exist.
  assert.match(page, /kind: "public"/);
  assert.match(page, /kind: "hidden"/);
  assert.match(page, /kind: "missing"/);
  // Missing is a 404.
  assert.match(page, /if \(state\.kind === "missing"\) \{\s*\n\s*notFound\(\);/);
  // Hidden is a 404 unless the viewer owns it.
  assert.match(
    page,
    /if \(!\(await viewerOwnsHiddenProfile\(state\.ownerUserId\)\)\) \{\s*\n\s*notFound\(\);/,
  );
  // Ownership compares the session user to the row's user_id and nothing else.
  assert.match(page, /return !!user && user\.id === ownerUserId;/);
  assert.match(page, /if \(!ownerUserId\) return false;/);
  // The notice renders only after that check.
  const guard = page.indexOf("viewerOwnsHiddenProfile(state.ownerUserId)");
  const render = page.indexOf("<ProfileNotListed />");
  assert.ok(guard > 0 && render > guard, "the notice must come after the ownership check");
});

test("the unavailable notice carries no profile data and no reason", () => {
  const page = src("../app/talent/[id]/page.tsx");
  const start = page.indexOf("function ProfileNotListed()");
  const end = page.indexOf("export async function generateMetadata");
  assert.ok(start > 0 && end > start);
  const body = page.slice(start, end);
  assert.match(body, /This profile isn&apos;t currently listed\./);
  assert.match(body, /It may be listed again later\. Nothing else is shown at this address\./);
  for (const field of [
    "fullName",
    "first_name",
    "photo",
    "roleLabel",
    "bio",
    "skills",
    "profile.",
  ]) {
    assert.ok(!body.includes(field), `the notice references profile data: ${field}`);
  }
  for (const reason of ["paused", "privacy", "review", "archived", "hidden"]) {
    assert.ok(!body.toLowerCase().includes(reason), `the notice explains why: ${reason}`);
  }
});

test("hidden and missing are indistinguishable in metadata", () => {
  const page = src("../app/talent/[id]/page.tsx");
  assert.match(page, /if \(state\.kind !== "public"\) \{/);
  const start = page.indexOf('if (state.kind !== "public") {');
  const block = page.slice(start, page.indexOf("const profile = state.profile;", start));
  assert.match(block, /title: "Profile not found — Remotiv"/);
  assert.match(block, /robots: \{ index: false, follow: false \}/);
});

/* ── indexing: public profiles are indexed, hidden ones never ── */

test("public profile pages invite indexing; the non-public branch stays noindex", () => {
  const page = src("../app/talent/[id]/page.tsx");
  // Exactly one of each: noindex for hidden and missing alike, index for public.
  assert.equal((page.match(/robots: \{ index: false, follow: false \}/g) ?? []).length, 1);
  assert.equal((page.match(/robots: \{ index: true, follow: true \}/g) ?? []).length, 1);
  // The indexable directive sits after the non-public early return, so only a
  // profile that passed the predicate can carry it.
  const guard = page.indexOf('if (state.kind !== "public") {');
  const noindex = page.indexOf("robots: { index: false, follow: false }");
  const index = page.indexOf("robots: { index: true, follow: true }");
  assert.ok(
    guard > 0 && guard < noindex && noindex < index,
    "index must come after the non-public return",
  );
});

test("the sitemap advertises public profiles only, through the shared predicate, paged", () => {
  const sitemap = src("../app/sitemap.ts");
  assert.match(
    sitemap,
    /import \{ publicRemote, publicTalent \} from "@\/lib\/talent-visibility";/,
  );
  assert.match(sitemap, /publicTalent\(\s*supabase\.from\("talent_profiles"\)/);
  assert.match(sitemap, /publicRemote\(\s*supabase\.from\("hire_remote_profiles"\)/);
  // Every read of a profile table goes through the predicate: no bare from().
  const bare = sitemap.match(
    /(?<!publicTalent\(\s*|publicRemote\(\s*)supabase\.from\("(talent_profiles|hire_remote_profiles)"\)/g,
  );
  assert.equal(bare, null, "a profile table is read without the visibility predicate");
  // Paged past the 1,000-row cap. sitemap.test.ts proves it on 1,500 rows.
  assert.match(sitemap, /pageAll<ProfileRow>/);
  assert.match(sitemap, /\.range\(from, to\)/);
  assert.match(sitemap, /url: `\$\{BASE_URL\}\/talent\/\$\{r\.id\}`/);
  // The jobs block and the static pages are untouched.
  assert.match(sitemap, /jobEntries = rows\.map/);
  assert.match(sitemap, /listedOnRemotiv/);
  assert.match(sitemap, /\.\.\.jobEntries,/);
  assert.match(sitemap, /export const revalidate = 3600;/);
});

test("robots.txt does not disallow /talent/, so crawlers can see the noindex", () => {
  const robots = src("../app/robots.ts");
  assert.doesNotMatch(robots, /\/talent\//);
  assert.match(robots, /disallow/i);
});
