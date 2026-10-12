/**
 * Recording step 2, from the source: the job types match migration 040, the
 * hooks sit where the brief put them, and the safety rules hold in the code
 * that ships. Each pin names the line that carries a rule.
 *
 *   node --test src/lib/final-interviews/bots-wiring.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
/** Code only: comments may name a rule in the words a pin would otherwise match. */
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

const BOTS = "src/lib/final-interviews/bots.ts";
const CLIENT = "src/lib/recall/client.ts";
const IMPORT = "src/lib/final-interviews/import.ts";
const QUEUE = "src/lib/jobs-queue.ts";
const ROUTE = "src/app/api/book/[token]/route.ts";
const ACTIONS = "src/app/ai-dashboard/(gated)/applicants/final-interview-actions.ts";
const MIGRATION = "src/lib/supabase/migrations/040_final_interview_bots.sql";

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
const SOURCES = walk(join(ROOT, "src")).map((p) => ({
  rel: relative(ROOT, p),
  text: code(readFileSync(p, "utf8")),
}));

/** The body of one top-level function, up to the next top-level declaration. */
function body(text, signature) {
  const from = text.indexOf(signature);
  assert.ok(from >= 0, `cannot find ${signature}`);
  const rest = text.slice(from + signature.length);
  const next = rest.search(/\n(export )?(async )?function |\nexport const |\nconst [A-Z_]+ =/);
  return text.slice(from, next >= 0 ? from + signature.length + next : undefined);
}

/* ── migration 040 and the queue agree ───────────────────────── */

test("JOB_TYPES holds migration 040's nineteen job types in its order", () => {
  const queue = read(QUEUE);
  const block = queue.slice(queue.indexOf("export const JOB_TYPES"), queue.indexOf("} as const;"));
  const inCode = [...code(block).matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const sql = read(MIGRATION);
  const section6 = sql.slice(sql.indexOf("-- ── 6."), sql.indexOf("-- ── 7."));
  const array = section6.slice(
    section6.indexOf("v_types text[] := array["),
    section6.indexOf("];"),
  );
  const inMigration = [...array.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(inMigration.length, 19);
  assert.deepEqual(inCode, inMigration);
});

test("final_bot_sync (step 2), final_bot_lobby_check (step 3) and final_recording_import (step 4) have handlers; the other two do not", () => {
  const queue = code(read(QUEUE));
  assert.match(queue, /registerHandler\(JOB_TYPES\.FINAL_BOT_SYNC, handleFinalBotSync\);/);
  assert.match(queue, /registerHandler\(JOB_TYPES\.FINAL_BOT_LOBBY_CHECK, handleFinalBotAlert\);/);
  assert.match(
    queue,
    /registerHandler\(JOB_TYPES\.FINAL_RECORDING_IMPORT, handleFinalRecordingImport\);/,
  );
  for (const t of ["FINAL_RECORDING_IMPORT_WATCHDOG", "FINAL_RECORDING_PURGE"]) {
    assert.doesNotMatch(queue, new RegExp(`registerHandler\\(JOB_TYPES\\.${t}\\b`), t);
  }
  // Nothing outside JOB_TYPES names the two that have no handler, so nothing
  // can enqueue them.
  for (const { rel, text } of SOURCES) {
    if (rel === QUEUE) continue;
    assert.doesNotMatch(
      text,
      /["'](final_recording_import_watchdog|final_recording_purge)["']/,
      rel,
    );
  }
  assert.doesNotMatch(
    queue,
    /JOB_TYPES\.(FINAL_RECORDING_IMPORT_WATCHDOG|FINAL_RECORDING_PURGE)\b/,
  );
  // The import job's name is written once, beside JOB_TYPES' own copy.
  const importNamers = SOURCES.filter((s) => /["']final_recording_import["']/.test(s.text)).map(
    (s) => s.rel,
  );
  assert.deepEqual(importNamers.sort(), ["src/lib/final-interviews/constants.ts", QUEUE].sort());
  // The alert job's name is written once, beside JOB_TYPES' own copy.
  const namers = SOURCES.filter((s) => /["']final_bot_lobby_check["']/.test(s.text)).map(
    (s) => s.rel,
  );
  assert.deepEqual(namers.sort(), ["src/lib/final-interviews/constants.ts", QUEUE].sort());
});

test("the bot module's job-type literal is JOB_TYPES.FINAL_BOT_SYNC", () => {
  assert.match(read(BOTS), /export const FINAL_BOT_SYNC_JOB = "final_bot_sync";/);
  assert.match(read(QUEUE), /FINAL_BOT_SYNC: "final_bot_sync",/);
});

test("the bot status vocabularies match migration 040's CHECKs", () => {
  const sql = read(MIGRATION);
  const list = (anchor) => {
    const at = sql.indexOf(anchor);
    const chunk = sql.slice(at, sql.indexOf("))", at));
    return [...chunk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  };
  const constants = read("src/lib/final-interviews/constants.ts");
  const ts = (name) => {
    const at = constants.indexOf(`export const ${name} = [`);
    return [
      ...constants.slice(at, constants.indexOf("] as const", at)).matchAll(/"([a-z_]+)"/g),
    ].map((m) => m[1]);
  };
  assert.deepEqual(ts("FINAL_BOT_STATUSES"), list("check (status in ("));
  assert.deepEqual(ts("FINAL_BOT_IMPORT_STATUSES"), list("check (import_status in ("));
});

test("the orphan payload the trigger writes is the one the handler reads", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /'action', 'delete',\s*'providerBotId', old\.provider_bot_id,\s*'providerRecordingId', old\.provider_recording_id/,
  );
  const bots = code(read(BOTS));
  assert.match(
    bots,
    /if \(payload\.action === "delete"\) \{\s*const report = await runOrphanDelete\(deps, payload\);/,
  );
  assert.match(bots, /const botId = payload\.providerBotId;/);
  assert.match(bots, /isRecallId\(payload\.providerRecordingId\)/);
});

/* ── the recurring reconcile ──────────────────────────────────── */

test("the reconcile is a recurring final_bot_sync, told apart by its action and gated by its predicate", () => {
  const queue = code(read(QUEUE));
  assert.match(
    queue,
    /\{\s*type: JOB_TYPES\.FINAL_BOT_SYNC,\s*intervalMs: RECONCILE_INTERVAL_MS,\s*action: "reconcile",\s*when: \(\) => finalBotReconcileWanted\(\),\s*\}/,
  );
  const ensure = body(queue, "export async function ensureMaintenanceScheduled(");
  assert.match(ensure, /if \(when && !\(await when\(\)\.catch\(\(\) => false\)\)\) continue;/);
  assert.equal(
    (ensure.match(/\.eq\("payload->>action", action\)/g) ?? []).length,
    2,
    "live and pacing checks",
  );
  assert.match(read(BOTS), /export const RECONCILE_INTERVAL_MS = 2 \* 60_000;/);
});

/* ── where the hooks sit ──────────────────────────────────────── */

test("POST, PATCH and DELETE each call their hook once, after the booking change succeeded", () => {
  const route = code(read(ROUTE));
  const post = body(route, "export async function POST(");
  const patch = body(route, "export async function PATCH(");
  const del = body(route, "export async function DELETE(");
  const get = body(route, "export async function GET(");

  const once = (text, call) => assert.equal(text.split(call).length - 1, 1, call);
  once(post, "await onFinalBookingConfirmed(claim.row);");
  once(patch, "await onFinalBookingRescheduled(moved.row);");
  once(del, "await onFinalBookingCancelled(cancelled.row);");
  assert.doesNotMatch(get, /onFinalBooking/);

  const order = (text, before, hook, after) => {
    const i = text.indexOf(before);
    const h = text.indexOf(hook);
    const j = text.indexOf(after);
    assert.ok(i >= 0 && h > i && j > h, `${hook} must sit between ${before} and ${after}`);
  };
  order(
    post,
    'return fail(502, "calendar_failed");',
    "onFinalBookingConfirmed(",
    "sendBookingConfirmations(",
  );
  order(
    patch,
    "return fail(status, moved.reason);",
    "onFinalBookingRescheduled(",
    "sendRescheduleNotices(",
  );
  order(del, "cancelled.reason", "onFinalBookingCancelled(", "sendCancellationNotices(");
});

test("the recruiter's cancel calls the hook once, for both branches, before the interview is marked", () => {
  const actions = code(read(ACTIONS));
  const cancel = body(actions, "export async function cancelFinalInterview(");
  assert.equal(cancel.split("await onFinalBookingCancelled(live);").length - 1, 1);
  assert.match(cancel, /if \(live\) await onFinalBookingCancelled\(live\);/);
  const hook = cancel.indexOf("onFinalBookingCancelled(");
  assert.ok(hook > cancel.indexOf('.update({ status: "expired" })'), "after the invited branch");
  assert.ok(hook > cancel.indexOf("await cancelBooking({"), "after the booked branch");
  assert.ok(hook < cancel.indexOf('.from("final_interviews")'), "before the interview is marked");
  // Nowhere else in the file: scheduling and resending never create a bot.
  assert.equal(actions.split("onFinalBooking").length - 1, 2, "the import and this one call");
});

test("the screening cancel cannot reach a final round, so it needs no hook", () => {
  const bookingActions = read("src/app/ai-dashboard/(gated)/applicants/booking-actions.ts");
  const cancel = body(bookingActions, "export async function cancelBookingAsRecruiter(");
  assert.match(cancel, /\.eq\("purpose", "interview"\)/);
});

/* ── the audit checks ─────────────────────────────────────────── */

test("1. RECALL_RECORDING_ENABLED is read in one place, fail-closed", () => {
  const readers = SOURCES.filter((s) => /\.RECALL_RECORDING_ENABLED\b/.test(s.text));
  assert.deepEqual(
    readers.map((s) => s.rel),
    [BOTS],
  );
  assert.equal((code(read(BOTS)).match(/\.RECALL_RECORDING_ENABLED\b/g) ?? []).length, 1);
  assert.match(read(BOTS), /return env\.RECALL_RECORDING_ENABLED === "true";/);
});

test("2. Recall is reached only through the client, and the client only from the job", () => {
  for (const { rel, text } of SOURCES) {
    if (rel.startsWith("src/lib/recall/")) continue;
    assert.doesNotMatch(text, /recall\.ai|\/api\/v1\/bot|leave_call|delete_media/, rel);
  }
  const clientUsers = SOURCES.filter((s) =>
    /getRecallClient\(|createRecallClient\(/.test(s.text),
  ).map((s) => s.rel);
  assert.deepEqual(clientUsers.sort(), [BOTS, CLIENT, IMPORT].sort());
  // The import (step 4) builds its one client in its job handler.
  const imp = code(read(IMPORT));
  assert.equal((imp.match(/getRecallClient\(\)/g) ?? []).length, 1);
  assert.match(
    body(imp, "export async function handleFinalRecordingImport("),
    /recall: getRecallClient\(\),/,
  );
  const bots = code(read(BOTS));
  assert.equal((bots.match(/getRecallClient\(\)/g) ?? []).length, 1);
  assert.match(body(bots, "function workerDeps("), /recall: getRecallClient\(\),/);
  assert.equal(
    (bots.match(/workerDeps\(/g) ?? []).length,
    2,
    "defined once, called by the handler",
  );
  assert.match(bots, /await processFinalBotJob\(workerDeps\(ctx\), job\);/);
  // The booking request path never imports the client.
  for (const rel of [ROUTE, ACTIONS]) assert.doesNotMatch(read(rel), /@\/lib\/recall/, rel);
  // And the hooks hold no Recall client at all.
  const hooks = bots.slice(bots.indexOf("export type HookBooking"));
  assert.doesNotMatch(hooks, /recall\.|workerDeps|getRecallClient/);
});

test("4. every hook starts by checking purpose 'final'", () => {
  const bots = code(read(BOTS));
  for (const name of [
    "onFinalBookingConfirmed",
    "onFinalBookingRescheduled",
    "onFinalBookingCancelled",
  ]) {
    const fn = body(bots, `export async function ${name}(`);
    const firstStatement = fn
      .slice(fn.indexOf("{", fn.indexOf("): Promise<HookOutcome>")) + 1)
      .trim();
    assert.ok(
      firstStatement.startsWith(
        'if (booking.purpose !== "final" || !booking.final_interview_id) return "not_final";',
      ),
      name,
    );
  }
});

test("5. the API key is read once, by the client, and never logged", () => {
  const readers = SOURCES.filter((s) => /process\.env\.RECALL_API_KEY/.test(s.text)).map(
    (s) => s.rel,
  );
  assert.deepEqual(readers, [CLIENT]);
  for (const rel of [CLIENT, BOTS, "src/lib/recall/types.ts"]) {
    const logs = code(read(rel))
      .split("\n")
      .filter((l) => /console\.(log|warn|error|info)/.test(l));
    for (const line of logs) {
      assert.doesNotMatch(
        line,
        /apiKey|RECALL_API_KEY|authorization|download_url|meeting_url|meetingUrl/i,
        `${rel}: ${line.trim()}`,
      );
    }
  }
});

test("7. ordinary cancellation and rescheduling never delete media", () => {
  const bots = code(read(BOTS));
  const orphan = body(bots, "export async function runOrphanDelete(");
  const total = (bots.match(/recall\.deleteRecording\(/g) ?? []).length;
  const inOrphan = (orphan.match(/recall\.deleteRecording\(/g) ?? []).length;
  assert.ok(total >= 1);
  assert.equal(inOrphan, total, "deleteRecording is called from the orphan delete only");
  for (const { rel, text } of SOURCES)
    assert.doesNotMatch(text, /deleteBotMedia|delete_media/, rel);
  assert.doesNotMatch(body(bots, "async function retireVendorBot("), /deleteRecording/);
});

test("8. only a confirmed pre-join removal writes 'deleted'; bots.ts never marks an import ready", () => {
  const bots = code(read(BOTS));
  assert.equal((bots.match(/status: "deleted"/g) ?? []).length, 1);
  assert.match(body(bots, "async function markVendorGone("), /status: "deleted"/);
  // markVendorGone is reached from three places, all in retireVendorBot: 404
  // on retrieve, a confirmed scheduled delete, and 404 after a 405.
  assert.equal((bots.match(/await markVendorGone\(/g) ?? []).length, 3);
  assert.equal(
    (body(bots, "async function retireVendorBot(").match(/await markVendorGone\(/g) ?? []).length,
    3,
  );
  // The row type declares the column. Step 4 lets this file write 'queued'
  // (recording.done, the reconcile) and 'failed' (imports past their cap)
  // only: 'importing' and 'ready' belong to the import job alone.
  const withoutRowType = bots.replace(/export type FinalBotRow = \{[\s\S]*?\n\};/, "");
  assert.notEqual(withoutRowType, bots, "the row type was found and set aside");
  const writes = [...withoutRowType.matchAll(/import_status: "([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)].sort(), ["failed", "queued"]);
  assert.doesNotMatch(body(bots, "export function vendorView("), /"deleted"/);
});
