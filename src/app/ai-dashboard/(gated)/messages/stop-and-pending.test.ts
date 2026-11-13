/**
 * #85, step 1: "Send now" is withdrawn, "Cancel send" becomes a guarded
 * "Request stop", and a queued row reads as Pending, not Scheduled.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/stop-and-pending.test.ts"
 *
 * The actions run as shipped. Only the session and the database are fakes
 * (messages-test-hook.mjs). The database here is ONE communication_logs row
 * whose status the test can move between the action's read and its write, the
 * way a sender's own status write would land in production. An UPDATE is
 * applied only if every .eq() the action sent matches the row as it is NOW, so
 * a write that drops its status guard really does overwrite the row here.
 *
 * What this does NOT prove: that PostgREST applies the guard the same way.
 * That is the one thing only a real database can show.
 */
// @ts-nocheck - same reason as recipients-scope.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import ts from "typescript";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { cancelScheduledMessage, fetchApplicationMessages, sendScheduledNow } = await import(
  "./actions.ts"
);
const { MESSAGE_KIND_LABELS } = await import("./types.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-0000000000a1";
const JOB = "b0000000-0000-0000-0000-0000000000b1";
const LOG = "l0000000-0000-0000-0000-0000000000c1";

const STOP_FAILED = "Couldn't request a stop for this message. Try again in a moment.";
const ALREADY_SENT = "This message has already been sent.";
const ENDED = "This message already ended with a send error, so there is nothing to stop.";

/** A raw database message no reply may ever carry. */
const RAW_DB_TEXT =
  "duplicate key value violates unique constraint communication_logs_auto_event_uniq";

/**
 * The fake database. `row` is the one log row; `beforeUpdate` runs between
 * the action's read and its write, which is exactly where a sender's own
 * status write can land. `updateError` makes the UPDATE fail outright.
 */
function world({ status, beforeUpdate, updateError = false, rereadError = false } = {}) {
  const row = {
    id: LOG,
    company_id: CO,
    application_id: APP,
    event: "application_received",
    status,
    error: null,
    to_address: "ada@example.test",
    subject: "Thanks for applying",
    body: "Hello",
    scheduled_for: null,
    sent_at: null,
    sent_by_name: null,
    created_at: "2026-11-13T10:00:00.000Z",
  };
  const applicant = {
    id: APP,
    job_id: JOB,
    company_id_snapshot: CO,
    first_name: "Ada",
    last_name: "One",
    email: "ada@example.test",
    job_title_snapshot: "Engineer",
    jobs: { title: "Engineer" },
  };
  let reads = 0;
  const eqs = (calls) => calls.filter((c) => c[0] === "eq");
  const matches = (calls) => eqs(calls).every(([, col, val]) => row[col] === val);
  const service = fakeService((table, calls) => {
    if (table === "job_applications") {
      return call(calls, "maybeSingle")
        ? { data: applicant, error: null }
        : { data: [applicant], error: null };
    }
    if (table !== "communication_logs") throw new Error(`test: unexpected table ${table}`);

    const update = call(calls, "update");
    if (update) {
      if (beforeUpdate) beforeUpdate(row);
      if (updateError) return { data: null, error: { code: "23505", message: RAW_DB_TEXT } };
      if (!matches(calls)) return { data: call(calls, "select") ? [] : null, error: null };
      Object.assign(row, update[1]);
      return { data: call(calls, "select") ? [{ id: row.id }] : null, error: null };
    }

    reads += 1;
    if (rereadError && reads > 1)
      return { data: null, error: { code: "57014", message: RAW_DB_TEXT } };
    if (call(calls, "maybeSingle")) {
      const own = eqs(calls).every(([, col, val]) => row[col] === val);
      return { data: own ? { ...row } : null, error: null };
    }
    return { data: [{ ...row }], error: null };
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = {
    companyId: CO,
    role: "owner",
    memberId: "m-1",
    memberName: "Rae Recruiter",
    user: { id: "u-1", email: "rae@acme.test" },
    company: { id: CO, name: "Acme" },
  };
  return { row, service };
}

const updates = (service) =>
  service.queries.filter((q) => q.table === "communication_logs" && call(q.calls, "update"));

/** Console lines, captured, so a test can see exactly what a stop logged. */
function captureConsole() {
  const lines = { error: [], warn: [] };
  const saved = { error: console.error, warn: console.warn };
  console.error = (...args) => lines.error.push(args);
  console.warn = (...args) => lines.warn.push(args);
  return { lines, restore: () => Object.assign(console, saved) };
}

/** Run an action with console captured; returns its result and the lines it logged. */
async function quietly(run) {
  const { lines, restore } = captureConsole();
  try {
    return { result: await run(), lines };
  } finally {
    restore();
  }
}

/* ── 1. "Send now" is gone ───────────────────────────────────── */

test("#85 step 1: the row menu no longer offers Send now", () => {
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  const start = client.indexOf("{scheduled ? (");
  const end = client.indexOf(") : (", start);
  assert.ok(start > 0 && end > start, "the pending row's menu block was found");
  const menu = client.slice(start, end);
  assert.doesNotMatch(menu, /Send now/, "no Send now item");
  assert.doesNotMatch(menu, /handleSendNow/, "nothing in the menu calls it");
});

test("#85 step 1: the server refuses Send now and reads, writes and sends nothing", async () => {
  const { row, service } = world({ status: "queued" });
  const result = await sendScheduledNow(LOG);
  assert.deepEqual(result, {
    success: false,
    error: "Sending early isn't available. Nothing was sent or changed.",
  });
  assert.equal(service.queries.length, 0, "no table was touched");
  assert.equal(row.status, "queued", "the row is exactly as it was");
});

/* ── 2. a row that turned sent between the read and the write ── */

test("#85 step 1: Request stop refuses, and writes nothing, when the row turned sent before the write", async () => {
  const { row, service } = world({
    status: "queued",
    beforeUpdate: (r) => {
      r.status = "sent";
    },
  });
  const { result } = await quietly(() => cancelScheduledMessage(LOG));
  assert.deepEqual(result, { success: false, error: ALREADY_SENT });
  assert.equal(row.status, "sent", "the sent row was not overwritten");
  assert.equal(row.error, null, "and nothing else on it changed");
  const [update] = updates(service);
  assert.ok(update, "the guarded write was attempted");
  assert.ok(
    update.calls.some((c) => c[0] === "eq" && c[1] === "status" && c[2] === "queued"),
    "the write is conditional on the row still being queued",
  );
});

/* ── 3. an already-cancelled row ─────────────────────────────── */

test("#85 step 1: Request stop on an already-cancelled row succeeds and writes nothing", async () => {
  const { row, service } = world({ status: "cancelled" });
  row.error = "Cancelled earlier.";
  const result = await cancelScheduledMessage(LOG);
  assert.deepEqual(result, { success: true, data: undefined });
  assert.equal(updates(service).length, 0, "no write at all");
  assert.equal(row.error, "Cancelled earlier.", "the earlier mark is untouched");
});

test("#85 step 1: a row cancelled between the read and the write is a success, and is not written again", async () => {
  const { row } = world({
    status: "queued",
    beforeUpdate: (r) => {
      r.status = "cancelled";
      r.error = "Cancelled earlier.";
    },
  });
  const { result, lines } = await quietly(() => cancelScheduledMessage(LOG));
  assert.deepEqual(result, { success: true, data: undefined });
  assert.equal(row.error, "Cancelled earlier.", "the guarded write matched nothing");
  assert.deepEqual(lines.warn, [
    ["[messages] a pending message changed before it could be marked as stopped"],
  ]);
  assert.deepEqual(lines.error, [], "zero rows is not an error");
});

/* ── 4. a failed row ─────────────────────────────────────────── */

test("#85 step 1: Request stop on a failed row says it ended with an error, never that it was not delivered", async () => {
  const { row, service } = world({ status: "failed" });
  const result = await cancelScheduledMessage(LOG);
  assert.deepEqual(result, { success: false, error: ENDED });
  assert.doesNotMatch(result.error, /didn.t|not (sent|delivered)|did not go out/i);
  assert.equal(updates(service).length, 0, "no write");
  assert.equal(row.status, "failed");
});

/* ── safeguard A and B: an error is not zero rows ────────────── */

test("#85 step 1: a database error on the stop is a fixed sentence, logs only the code, and changes nothing", async () => {
  const { row } = world({ status: "queued", updateError: true });
  const { result, lines } = await quietly(() => cancelScheduledMessage(LOG));
  assert.deepEqual(result, { success: false, error: STOP_FAILED });
  assert.equal(row.status, "queued");
  assert.deepEqual(lines.error, [
    ["[messages] marking a pending message as stopped failed", { code: "23505" }],
  ]);
  assert.deepEqual(lines.warn, [], "an error is not reported as a lost row");
  assert.ok(!JSON.stringify(lines).includes(RAW_DB_TEXT), "no raw database text logged");
});

test("#85 step 1: a failed re-read after a lost stop is the fixed sentence, code only", async () => {
  world({
    status: "queued",
    rereadError: true,
    beforeUpdate: (r) => {
      r.status = "sent";
    },
  });
  const { result, lines } = await quietly(() => cancelScheduledMessage(LOG));
  assert.deepEqual(result, { success: false, error: STOP_FAILED });
  assert.deepEqual(lines.error, [
    ["[messages] re-reading a message after a lost stop failed", { code: "57014" }],
  ]);
  assert.ok(!JSON.stringify(lines).includes(RAW_DB_TEXT));
});

test("#85 step 1: a pending row is marked as stopped through the guarded write", async () => {
  const { row } = world({ status: "queued" });
  const result = await cancelScheduledMessage(LOG);
  assert.deepEqual(result, { success: true, data: undefined });
  assert.equal(row.status, "cancelled");
});

/* ── 5. a queued row reads as Pending ────────────────────────── */

test("#85 step 1: a queued row reads as Pending, and no visible copy says Scheduled", async () => {
  world({ status: "queued" });
  const read = await fetchApplicationMessages(APP);
  assert.equal(read.ok, true);
  assert.equal(read.rows.length, 1);
  assert.equal(MESSAGE_KIND_LABELS[read.rows[0].kind], "Pending");

  // Every literal a person can read, in the two files that render this page.
  // The bare key "scheduled" (tab and kind identifiers) is not copy.
  const visible = [];
  for (const file of ["./_messages-client.tsx", "./types.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const visit = (n) => {
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n) ||
        ts.isJsxText(n)
      ) {
        if (/scheduled/i.test(n.text) && n.text !== "scheduled") visible.push(`${file}: ${n.text}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.deepEqual(visible, [], "visible copy still says Scheduled");
});
