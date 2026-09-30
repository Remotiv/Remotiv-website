/**
 * Source pins for the Phase 8 operability work: the worker's heartbeat and
 * aggregated dead-job alert, the read-only health route, migration 035's
 * self-verification, the queue panel's honest error state, and the fail-closed
 * development guard at every service-role construction site.
 *
 * These are source-text assertions because the modules render React or import
 * Next runtime and cannot run under bare node:test. Each pins both the presence
 * of the new behaviour and the ABSENCE of the thing it replaced, so an ordinary
 * edit cannot quietly undo it.
 *
 *   node --test src/lib/queue/phase8-wiring.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const route = src("../../app/api/jobs/worker/route.ts");
const health = src("../../app/api/health/worker/route.ts");
const migration = src("../supabase/migrations/035_worker_heartbeat_and_alert_events.sql");
const panel = src("../../app/admin/companies/_queue-panel.tsx");
const reader = src("../queue-health.ts");
const types = src("../queue-health-types.ts");
const notifications = src("../notifications.ts");

/* ── the worker: heartbeat and dead-job aggregation ─────────── */

test("the heartbeat is written after the pool drains, on every tick, non-fatally", () => {
  const pool = route.indexOf("await Promise.all(Array.from({ length: Math.min(WORKER_CONCURRENCY");
  const beat = route.indexOf("await recordHeartbeatAndAlerts(summary, startedAt);");
  assert.ok(pool > 0 && beat > pool, "heartbeat must follow the pool, so a tick that died mid-batch leaves none");
  assert.match(route, /from\("worker_heartbeats"\)\.upsert\(/);
  assert.match(route, /last_tick_at: nowIso/);
  // Wrapped: a missing table (035 not applied) must not fail the tick.
  assert.match(route, /heartbeat write failed \(non-fatal\)/);
  assert.match(route, /heartbeat read failed \(non-fatal\)/);
});

test("dead jobs are recorded with their safe class and folded into ONE notification", () => {
  assert.match(route, /deadJobs: \[\] as DeadJobEntry\[\]/);
  assert.match(
    route,
    /failureClass: err instanceof TerminalJobError \? err\.failureClass : "retryable"/,
  );
  assert.match(route, /const dead = summariseDeadJobs\(summary\.deadJobs\);/);
  assert.match(route, /event_type: "job_dead"/);
  // The notification is built from the summary helper only. last_error, the
  // caught error, and the job payload never reach notifyAllAdmins.
  const notifyBlocks = route.split("await notifyAllAdmins(").slice(1);
  assert.equal(notifyBlocks.length, 2, "exactly two notification sites: worker_stale and job_dead");
  for (const block of notifyBlocks) {
    const body = block.slice(0, block.indexOf("});") + 3);
    assert.doesNotMatch(body, /last_error|lastError|err\.message|payload|String\(err\)/, body);
  }
  // deadJobs is internal: the tick's JSON response omits it.
  assert.match(route, /const \{ deadJobs: _internalOnly, \.\.\.publicSummary \} = summary;/);
});

test("worker_stale is retrospective, threshold-bound, and de-duplicated per gap", () => {
  assert.match(route, /staleGapNotice\(previousTickAt, now, WORKER_TICK_STALE_MS\)/);
  assert.match(route, /event_type: "worker_stale"/);
  assert.match(route, /staleNoticedAt === previousTickAt/);
  assert.match(route, /stale_noticed_at: stale \? previousTickAt : null/);
});

/* ── the health route ───────────────────────────────────────── */

test("the health route is read-only, unauthenticated, rate-limited, and exposes only ok and age", () => {
  assert.match(health, /export async function GET\(/);
  assert.doesNotMatch(health, /export async function (POST|PUT|PATCH|DELETE)\(/);
  assert.doesNotMatch(health, /\.(insert|update|upsert|delete)\(/, "the public route must never write");
  // Code forms, not words: the doc comment legitimately names CRON_SECRET to
  // explain why the stale notice is NOT sent from here.
  assert.doesNotMatch(health, /process\.env\.CRON_SECRET|notifyAllAdmins\(/);
  assert.match(health, /rateLimit\(request, \{ bucketKey: "health-worker"/);
  assert.match(health, /from\("worker_heartbeats"\)/);
  assert.match(health, /ageMs <= WORKER_TICK_STALE_MS/);
  assert.match(health, /status: ok \? 200 : 503/);
  // No heartbeat and an unreadable table both read as unhealthy to a monitor.
  assert.match(health, /reason: "no_heartbeat" \}, \{ status: 503 \}/);
  assert.match(health, /reason: "heartbeat_unreadable" \}, \{ status: 503 \}/);
  // The raw database message is logged, never returned.
  assert.match(health, /console\.error\("\[health\/worker\] heartbeat unreadable:", error\.message\)/);
  assert.doesNotMatch(health, /reason: error\.message/);
});

test("the thresholds are shared, not duplicated", () => {
  assert.match(types, /export const WORKER_TICK_WARN_MS = 5 \* 60_000;/);
  assert.match(types, /export const WORKER_TICK_STALE_MS = 10 \* 60_000;/);
  for (const [name, text] of [
    ["route", route],
    ["health", health],
    ["panel", panel],
  ]) {
    assert.match(text, /WORKER_TICK_STALE_MS/, `${name} does not use the shared constant`);
    // Word-bounded: the panel's unrelated `36 * 3_600_000` contains the
    // substring 600_000, which is not a duplicated threshold.
    assert.doesNotMatch(text, /\b10 \* 60_000\b|\b600_000\b|\b600000\b/, `${name} hard-codes the threshold`);
  }
});

/* ── migration 035 ──────────────────────────────────────────── */

test("035 verifies the live constraint before touching it and fails loudly otherwise", () => {
  assert.match(migration, /select pg_get_constraintdef\(oid\) into v_def/);
  assert.match(migration, /raise exception/);
  assert.match(migration, /Not replacing an unexpected definition/);
  assert.match(migration, /constraint % not found/);
  // Skips, rather than fails, when already applied.
  assert.match(migration, /already includes job_dead and worker_stale; skipping/);
  // Every LIVE value preserved - the ten the database allowed on 2026-10-01,
  // not the eight schema.sql listed - and exactly two added.
  for (const v of [
    "client_decision",
    "client_note",
    "stage_change",
    "candidate_added",
    "new_inquiry",
    "profile_claimed",
    "profile_approved",
    "profile_rejected",
    "shortlisted",
    "profile_paused",
  ]) {
    assert.match(migration, new RegExp(`'${v}'`), `035 drops existing value ${v}`);
  }
  assert.match(migration, /v_added text\[\] := array\['job_dead', 'worker_stale'\]/);
  // v_expected is exactly ten: it must end on profile_paused, and the
  // already-applied branch must speak of twelve.
  assert.match(migration, /'profile_rejected',\n\s*'shortlisted',\n\s*'profile_paused'\n\s*\];/);
  assert.match(migration, /constraint has twelve values but is missing/);
  // The header records the drift this verification caught, and the finding
  // about the bulk pause, so neither has to be rediscovered.
  assert.match(migration, /two values behind/);
  assert.match(migration, /It fired zero times\./);
  assert.match(migration, /shortlisted, profile_paused/);
  // The heartbeat table is single-row by construction and RLS-locked.
  assert.match(migration, /id\s+text primary key default 'worker' check \(id = 'worker'\)/);
  assert.match(migration, /alter table public\.worker_heartbeats enable row level security;/);
  // Idempotent table creation.
  assert.match(migration, /create table if not exists public\.worker_heartbeats/);
});

test("the notification union names both new events, and nothing else changed", () => {
  assert.match(notifications, /\| "job_dead"\n\s*\| "worker_stale";/);
  const union = notifications.slice(
    notifications.indexOf("export type NotificationEvent"),
    notifications.indexOf("export type NotificationInput"),
  );
  const values = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  // Twelve: the eight the repo always knew, the two setTalentFlag writes
  // directly and the live CHECK already allowed (the drift 035 caught), and
  // the two Phase 8 alerts.
  assert.deepEqual(values, [
    "client_decision",
    "client_note",
    "stage_change",
    "candidate_added",
    "new_inquiry",
    "profile_claimed",
    "profile_approved",
    "profile_rejected",
    "shortlisted",
    "profile_paused",
    "job_dead",
    "worker_stale",
  ]);
  // The direct writer and the union must agree, or the drift returns.
  const talentActions = src("../../app/admin/talent/actions.ts");
  assert.match(talentActions, /event_type: isShortlisted \? "shortlisted" : "profile_paused"/);
});

/* ── queue health: error state and the panel ────────────────── */

test("readQueueHealth carries read errors as categories and logs the raw message", () => {
  assert.match(reader, /readErrors: QueueReadError\[\]/);
  assert.match(reader, /error: error\?\.message \?\? null/, "readStatus must carry the error");
  assert.match(reader, /return \[type, count \?\? 0, error\?\.message \?\? null\] as const;/);
  assert.match(reader, /console\.error\(`\[queue-health\] read failed \(\$\{source\}\):`, error\.message\)/);
  assert.match(reader, /readErrors\.push\(\{ source \}\)/);
  assert.doesNotMatch(reader, /readErrors\.push\(\{ source, message/, "message must not cross to the client");
  assert.match(reader, /lastTickAt: tickRow\?\.last_tick_at \?\? null,/);
  assert.match(types, /export type QueueReadError = \{ source: string \};/);
});

test("the panel says health data could not be loaded, shows categories only, and never a raw message", () => {
  assert.match(panel, /Health data could not be loaded\./);
  assert.match(panel, /const degraded = health\.readErrors\.length > 0;/);
  assert.match(panel, /health\.readErrors\.map\(\(e\) => e\.source\)\.join\(", "\)/);
  assert.match(panel, /Details are in the\s+server log\./);
  // Every tile goes "unavailable" with the muted tone when degraded.
  assert.equal((panel.match(/degraded \? unavailable :/g) ?? []).length, 5, "all five tiles degrade");
  assert.equal((panel.match(/degraded \? "muted" :/g) ?? []).length, 5);
  // Idle stays distinguishable: the idle value is still rendered when not degraded.
  assert.match(panel, /"nothing queued"/);
  // No raw error field is rendered anywhere in the panel's error state.
  assert.doesNotMatch(panel, /e\.message|readErrors\[\d\]\.message/);
});

test("the liveness tile is the heartbeat; the claim tile is relabelled as throughput", () => {
  assert.match(panel, /title="Worker last ticked"/);
  assert.match(panel, /ago\(health\.lastTickAt\)/);
  assert.match(panel, /tickAgeMs > WORKER_TICK_STALE_MS\s*\n?\s*\? "bad"/);
  assert.match(panel, /title="Last job claimed"/);
  assert.doesNotMatch(panel, /title="Worker last claimed"/);
  // The old claim tile went amber on a healthy idle queue; it no longer carries a warn tone.
  assert.doesNotMatch(panel, /tone=\{health\.lastClaimAt \? "ok" : "warn"\}/);
  assert.match(panel, /tone: "ok" \| "warn" \| "bad" \| "muted";/);
});

/* ── the guard at every service-role site ───────────────────── */

test("the fail-closed guard runs before the service-role key is read, everywhere it is read", () => {
  const server = src("../supabase/server.ts");
  assert.match(server, /import \{ assertServiceClientAllowed \} from "\.\/guard";/);
  const call = server.indexOf("assertServiceClientAllowed();");
  const key = server.indexOf("process.env.SUPABASE_SERVICE_ROLE_KEY!");
  assert.ok(call > 0 && key > call, "guard must precede the key in createServiceClient");
  for (const rel of ["../company-identity.ts", "../../app/admin/clients/actions.ts"]) {
    const s = src(rel);
    const c = s.indexOf("assertServiceClientAllowed();");
    const k = s.indexOf("process.env.SUPABASE_SERVICE_ROLE_KEY");
    assert.ok(c > 0 && k > c, `${rel}: guard must precede the key`);
  }
});
