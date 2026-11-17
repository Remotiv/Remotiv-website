/**
 * #44 and #45: the hero's manual/automatic split, "Messages sent", the Failed
 * chip, and what happens to a status nobody listed.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/split-and-failed.test.ts"
 *
 * #44: the hero divided "every status except queued" by "status = sent". Those
 * are two different populations, so 'read' rows from the WhatsApp webhook, and
 * failed and skipped rows, pushed the share past 100%. Every count now names
 * its statuses (message-status.ts), and the shares are shares of one counted
 * population.
 *
 * #45: a failed message had a red Failed pill and no Failed chip to find it by.
 *
 * Runs the real fetchMessageAggregates and fetchMessages against a small
 * evaluator that applies the filters they send, with SQL's NULL semantics
 * (NULL fails eq, neq, in and not.in). aggregates-scope.test.ts and
 * list-scope.test.ts carry the scope and join proofs; this file proves which
 * statuses and events land in which number.
 */
// @ts-nocheck - same reason as aggregates-scope.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig. Nothing ships from this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchMessageAggregates, fetchMessages } = await import("./actions.ts");
const { failedCaption, sentStatusLabel, splitPercents } = await import("./message-status.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const JOB_1 = "a0000000-0000-0000-0000-000000000001";
const JOB_2 = "a0000000-0000-0000-0000-000000000002";

const APPLICATIONS = [
  { id: "app-1", job_id: JOB_1, company_id_snapshot: CO, first_name: "Test", last_name: "One" },
  { id: "app-2", job_id: JOB_2, company_id_snapshot: CO, first_name: "Test", last_name: "Two" },
];

let seq = 0;
const log = (id, event, status, extra = {}) => {
  seq += 1;
  return {
    id,
    company_id: CO,
    application_id: "app-1",
    event,
    status,
    to_address: null,
    subject: `subject ${id}`,
    body: "",
    scheduled_for: null,
    sent_at: status === "queued" ? null : "2026-11-01T12:00:00.000Z",
    sent_by_name: null,
    created_at: `2026-11-01T12:00:${String(seq).padStart(2, "0")}.000Z`,
    ...extra,
  };
};

/**
 * Every status the split covers, on each side of it, plus the NULL event, plus
 * one row each that must be in NO count: queued (only in All and Scheduled),
 * cancelled, a status nobody listed, a NULL status, and an orphaned failure.
 */
const MIXED = [
  log("M-sent", "manual", "sent"),
  log("M-delivered", "manual", "delivered"),
  log("M-failed", "manual", "failed"),
  log("M-skipped", "manual", "skipped"),
  log("A-sent", "rejected", "sent"),
  log("A-delivered", "booking_link", "delivered"),
  log("A-read", "interview_reminder", "read"),
  log("A-failed", "rejected", "failed"),
  log("A-skipped", "rejected", "skipped"),
  log("N-sent", null, "sent"),
  log("N-failed", null, "failed"),
  // On JOB_2: in the owner's counts, outside a JOB_1 recruiter's.
  log("F-job2", "rejected", "failed", { application_id: "app-2" }),
  log("Q-queued", "manual", "queued"),
  log("C-cancelled", "rejected", "cancelled"),
  log("U-bounced", "rejected", "bounced"),
  log("U-null", "rejected", null),
  // #71: application_id NULL, so canSeeApplication cannot gate it. Excluded.
  log("O-failed", "rejected", "failed", { application_id: null }),
];

/* ── evaluator ───────────────────────────────────────────────── */

function splitTerms(expression) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of expression) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const listOf = (val) =>
  val
    .replace(/^\(|\)$/g, "")
    .split(",")
    .filter(Boolean);

function orTerm(raw) {
  const m = /^(\w+)\.(not\.in|in|is|neq|eq|ilike)\.(.*)$/.exec(raw.trim());
  if (!m) throw new Error(`test: evaluator does not model or() term ${raw}`);
  const [, col, op, val] = m;
  if (op === "is" && val === "null") return { op: "isnull", col };
  if (op === "in") return { op: "in", col, val: listOf(val) };
  if (op === "not.in") return { op: "notin", col, val: listOf(val) };
  return { op, col, val };
}

function toFilter(method, args) {
  if (method === "or") return { op: "or", col: "", terms: splitTerms(String(args[0])).map(orTerm) };
  if (method === "not" && args[1] === "is" && args[2] === null)
    return { op: "notnull", col: args[0] };
  if (["eq", "neq", "in", "gte", "ilike"].includes(method)) {
    return { op: method, col: args[0], val: args[1] };
  }
  throw new Error(`test: evaluator does not model .${method}()`);
}

function parse(calls) {
  const out = { parent: [], embedded: [], range: null, select: null };
  for (const [method, ...args] of calls) {
    if (method === "select") {
      out.select = args;
      continue;
    }
    if (method === "order" || method === "limit") continue;
    if (method === "range") {
      out.range = { from: args[0], to: args[1] };
      continue;
    }
    const f = toFilter(method, args);
    if (f.col.startsWith("job_applications.")) {
      out.embedded.push({ ...f, col: f.col.slice("job_applications.".length) });
    } else out.parent.push(f);
  }
  return out;
}

function matches(row, f) {
  if (f.op === "or") return f.terms.some((t) => matches(row, t));
  const v = row[f.col];
  const isNull = v === null || v === undefined;
  if (f.op === "isnull") return isNull;
  if (f.op === "notnull") return !isNull;
  if (isNull) return false; // SQL: NULL fails every comparison below.
  if (f.op === "eq") return v === f.val;
  if (f.op === "neq") return v !== f.val;
  if (f.op === "in") return f.val.includes(v);
  if (f.op === "notin") return !f.val.includes(v);
  if (f.op === "gte") return String(v) >= String(f.val);
  if (f.op === "ilike") return new RegExp(`^${String(f.val).replace(/%/g, ".*")}$`, "i").test(v);
  throw new Error(`test: unhandled op ${f.op}`);
}

function queryLogs(calls, logs) {
  const { parent, embedded, range, select } = parse(calls);
  assert.match(String(select[0]), /job_applications!inner\(/, "every read here is an inner join");
  const rows = logs
    .filter((l) => parent.every((f) => matches(l, f)))
    .filter((l) => {
      const app = APPLICATIONS.find((a) => a.id === l.application_id);
      return app ? embedded.every((f) => matches(app, f)) : false;
    })
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
  if (select[1]?.count === "exact") return { data: null, count: rows.length, error: null };
  const page = range ? rows.slice(range.from, range.to + 1) : rows;
  return { data: page, count: null, error: null };
}

async function run(fn, { role = "owner", jobs = [], logs = MIXED } = {}) {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team")
      return { data: jobs.map((job_id) => ({ job_id })), error: null };
    if (table === "communication_logs") return queryLogs(calls, logs);
    if (table === "job_applications") {
      const { parent } = parse(calls);
      return { data: APPLICATIONS.filter((a) => parent.every((f) => matches(a, f))), error: null };
    }
    throw new Error(`test: unexpected table ${table}`);
  });
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = {
    companyId: CO,
    role,
    memberId: "m-1",
    memberName: "Test Member",
    user: { id: "u-1", email: "member@example.test" },
    company: { name: "Acme" },
  };
  try {
    return await fn();
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

/** Run the aggregates and capture what they log. */
async function aggregates(opts) {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    const read = await run(() => fetchMessageAggregates(), opts);
    assert.ok(read.ok, "fetchMessageAggregates returned unavailable");
    return { agg: read.value, warned };
  } finally {
    console.warn = original;
  }
}

async function list(tab, opts) {
  const read = await run(() => fetchMessages({ tab, jobId: "", search: "", page: 0 }), opts);
  assert.ok(read.ok, `fetchMessages(${tab}) returned unavailable`);
  return read.value;
}

const idsOf = (page) => page.rows.map((r) => r.id).sort();

/* ── the split ───────────────────────────────────────────────── */

test("#44 the manual and automatic counts partition the denominator exactly", async () => {
  for (const opts of [{}, { role: "recruiter", jobs: [JOB_1] }]) {
    const { agg } = await aggregates(opts);
    assert.equal(
      agg.written + agg.automatic,
      agg.population,
      `${opts.role ?? "owner"}: manual ${agg.written} + automatic ${agg.automatic} must be the population ${agg.population}`,
    );
  }
  const { agg } = await aggregates();
  // Hand-counted: 4 manual, 5 automatic, 2 NULL-event, 1 on JOB_2. Queued,
  // cancelled, bounced, NULL status and the orphan are none of these.
  assert.deepEqual(
    { manual: agg.written, automatic: agg.automatic, population: agg.population },
    { manual: 4, automatic: 8, population: 12 },
  );
  assert.equal(
    agg.all,
    agg.written + agg.automatic + agg.scheduled,
    "and All is the split plus scheduled",
  );
});

test("#44 rounding: a 12.5/87.5 split shows 13% and 87%, never 101 in total", async () => {
  const logs = [
    log("R-manual", "manual", "sent"),
    ...Array.from({ length: 7 }, (_, i) => log(`R-auto-${i}`, "rejected", "sent")),
  ];
  const { agg } = await aggregates({ logs });
  assert.deepEqual([agg.written, agg.population], [1, 8]);
  // The fixture discriminates: rounding each half on its own gives 101.
  const independent =
    Math.round((agg.written / agg.population) * 100) +
    Math.round((agg.automatic / agg.population) * 100);
  assert.equal(independent, 101);

  const split = splitPercents(agg.written, agg.population);
  assert.deepEqual(split, { manual: 13, automatic: 87 });

  // The hero renders exactly these two numbers, for the caption and the bar.
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(client, /const split = splitPercents\(agg\.written, agg\.population\);/);
  assert.match(client, /width=\{split\.manual\}\s+caption=\{`\$\{split\.manual\}%`\}/);
  assert.match(client, /width=\{split\.automatic\}\s+caption=\{`\$\{split\.automatic\}%`\}/);
  // The caption is the percentage alone: no denominator sentence to be wrong.
  assert.doesNotMatch(client, /% of /);
});

test("#44 a zero denominator shows 0% and 0%, not NaN", async () => {
  const { agg } = await aggregates({ logs: [log("Z-queued", "manual", "queued")] });
  assert.equal(agg.population, 0);
  assert.deepEqual(splitPercents(agg.written, agg.population), { manual: 0, automatic: 0 });
});

test("#44 Messages sent counts sent, delivered and read only", async () => {
  const { agg } = await aggregates();
  // M-sent, M-delivered, A-sent, A-delivered, A-read, N-sent. Not the four
  // failed, two skipped, queued, cancelled, bounced or NULL-status rows.
  assert.equal(agg.sent, 6);
  for (const [status, excluded] of [
    ["failed", true],
    ["skipped", true],
    ["queued", true],
    ["cancelled", true],
    ["sent", false],
    ["delivered", false],
    ["read", false],
  ]) {
    const { agg: one } = await aggregates({ logs: [log(`S-${status}`, "rejected", status)] });
    assert.equal(
      one.sent,
      excluded ? 0 : 1,
      `a ${status} row ${excluded ? "is not" : "is"} a sent message`,
    );
  }
});

test("#44 a NULL-event row is Automatic in the aggregate AND the list, and they agree", async () => {
  const { agg } = await aggregates();
  const automatic = await list("automatic");
  const written = await list("written");
  const all = await list("all");

  assert.ok(idsOf(automatic).includes("N-sent"), "the Automatic tab lists the NULL-event row");
  assert.ok(!idsOf(written).includes("N-sent"), "the Written tab does not");
  const nullRow = all.rows.find((r) => r.id === "N-sent");
  assert.equal(nullRow.kind, "automatic", "and its pill says Automatic");
  // The stored value is carried through as stored. "automatic" is a kind, not
  // an event, and defaulting NULL to "manual" is the relabelling asEvent warns of.
  assert.equal(nullRow.event, null, "the NULL event stays NULL on the row");
  assert.equal(all.rows.find((r) => r.id === "A-read").event, "interview_reminder");
  assert.equal(all.rows.find((r) => r.id === "M-sent").event, "manual");

  assert.equal(automatic.matching, agg.automatic, "the Automatic chip counts what its tab lists");
  assert.equal(written.matching, agg.written, "the Written chip counts what its tab lists");
  assert.equal(all.matching, agg.all, "the All chip counts what its tab lists");
});

/* ── #45 ─────────────────────────────────────────────────────── */

test("#45 the Failed chip counts and lists the failed rows that pass scope, never an orphan", async () => {
  const owner = await aggregates();
  const ownerList = await list("failed");
  assert.deepEqual(idsOf(ownerList), ["A-failed", "F-job2", "M-failed", "N-failed"]);
  assert.equal(owner.agg.failed, 4);
  assert.equal(ownerList.matching, owner.agg.failed, "the chip counts what its tab lists");
  assert.ok(ownerList.rows.every((r) => r.kind === "failed"));

  const scoped = { role: "recruiter", jobs: [JOB_1] };
  const recruiter = await aggregates(scoped);
  const recruiterList = await list("failed", scoped);
  assert.deepEqual(
    idsOf(recruiterList),
    ["A-failed", "M-failed", "N-failed"],
    "JOB_2's failure is out of scope",
  );
  assert.equal(recruiter.agg.failed, 3);

  for (const ids of [idsOf(ownerList), idsOf(recruiterList)]) {
    assert.ok(
      !ids.includes("O-failed"),
      "an orphaned failure has no applicant to gate it on (#71)",
    );
  }
});

test("#45 the Failed chip is on the strip", () => {
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(client, /\{ key: "failed", label: "Failed" \}/);
});

/* ── unrecognised statuses ───────────────────────────────────── */

test("an unrecognised or NULL status is in no count and no list, and is reported", async () => {
  const { agg, warned } = await aggregates();
  const all = await list("all");
  for (const id of ["U-bounced", "U-null"]) {
    assert.ok(!idsOf(all).includes(id), `${id} is not listed`);
  }
  // Each count, recomputed with the two rows removed, is unchanged.
  const known = MIXED.filter((l) => !["U-bounced", "U-null"].includes(l.id));
  const { agg: without, warned: quiet } = await aggregates({ logs: known });
  assert.deepEqual(agg, without, "the two rows move no number");

  assert.equal(warned.length, 1, "and are reported once");
  assert.match(
    warned[0],
    /^\[messages\] 2 in-scope communication_logs row\(s\) have a status outside KNOWN_STATUSES/,
  );
  assert.deepEqual(quiet, [], "with every status known, nothing is reported");
});

test("the unrecognised-status warning is labelled a log, not an alert", () => {
  // Nobody reads Vercel function logs. The comment is what stops a later
  // reader from treating this as monitoring.
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(
    actions,
    /\/\/ A LOG, not an alert\. It lands in Vercel function logs that nobody\n\s*\/\/ reads; if this ever needs to wake someone, it needs a real channel\.\n\s*console\.warn\(/,
  );
});

/* ── #86: the Failed tile's caption ──────────────────────────── */

const ZERO_FAILED = "No failed messages for current applicants";

// Negative control per state: change any one return in failedCaption and its row fails.
test("#86 the Failed caption has four states, each saying only what is counted", () => {
  const cases = [
    [{ failed: 0, sent: 0 }, "Nothing sent yet"],
    [{ failed: 0, sent: 5 }, ZERO_FAILED],
    [{ failed: 1, sent: 5 }, "1 message failed"],
    [{ failed: 3, sent: 5 }, "3 messages failed"],
    [{ failed: 2, sent: 0 }, "2 messages failed"],
  ];
  for (const [input, want] of cases) {
    const got = failedCaption(input);
    assert.equal(got, want, JSON.stringify(input));
    assert.ok(!got.includes("%"), `${got}: no percentage, none is computed`);
    assert.ok(!/deliver/i.test(got), `${got}: email delivery is never recorded`);
    assert.ok(!got.includes("—"), `${got}: no em dash`);
  }
});

test("#86 sent plus queued with nothing failed reads as zero failures, never a delivery claim", async () => {
  const logs = [
    log("S-sent", "manual", "sent"),
    log("S-delivered", "booking_link", "delivered"),
    log("S-queued", "manual", "queued"),
  ];
  const { agg } = await aggregates({ logs });
  assert.equal(agg.failed, 0);
  assert.equal(agg.sent, 2);
  assert.equal(agg.scheduled, 1, "the queued row is pending, in neither count");
  assert.equal(failedCaption(agg), ZERO_FAILED);
});

// Negative control: drop the erased-row exclusion and O-failed counts, giving "1 message failed".
test("#86 an erased applicant's failure alone still reads as zero failures", async () => {
  const erased = MIXED.find((l) => l.id === "O-failed");
  assert.equal(erased.application_id, null, "the fixture is the erased row");
  const { agg } = await aggregates({ logs: [log("E-sent", "manual", "sent"), erased] });
  assert.equal(agg.failed, 0);
  assert.equal(failedCaption(agg), ZERO_FAILED);
});

// Negative control: put the old inline ternary back and both assertions fail.
test("#86 the Failed tile renders failedCaption, and 100% delivered is gone", () => {
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(
    client,
    /label="Failed"[\s\S]{0,200}?caption=\{failedCaption\(agg\)\}\s+captionWraps\s+ok=\{agg\.failed === 0\}/,
  );
  assert.ok(!client.includes("100% delivered"));
  assert.ok(!client.includes("didn't arrive"));
});

/*
 * The zero-failure caption is 214px at 11px DM Sans against 98px of cell at
 * 360px, so it wraps. Only that tile: the other three captions stay on one line.
 * Negative controls: drop captionWraps and the first assertion fails; make
 * every caption wrap and the second does.
 */
test("#86 only the Failed caption may wrap", () => {
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  const cells = client.match(/<HeroCell\b[\s\S]*?\/>/g);
  assert.equal(cells.length, 4);
  assert.deepEqual(
    cells.map((c) => /\bcaptionWraps\b/.test(c)),
    [false, false, false, true],
    "Manual, Automatic and Pending keep one line; Failed wraps",
  );
  assert.match(client, /!captionWraps && "whitespace-nowrap"/, "nowrap is the default");
});

/* ── the drawer footer: the stored status, never upgraded ────── */

const AT = "17 Nov 2026, 14:05";

// Negative controls: make any one status return another's label and its row fails.
test("each sent-group status gives its own footer, and the time is named as the send time", () => {
  assert.equal(sentStatusLabel("sent", AT), `Sent · ${AT}`);
  assert.equal(sentStatusLabel("delivered", AT), `Delivered · sent ${AT}`);
  assert.equal(sentStatusLabel("read", AT), `Read · sent ${AT}`);
  for (const s of ["sent", "delivered", "read"]) {
    assert.ok(!/[\u2013\u2014]/.test(sentStatusLabel(s, AT)), `${s}: no en or em dash`);
  }
});

/*
 * Negative controls: give skipped its old "Delivered · {time}" and the first
 * assertion fails; make the fallback "Delivered" and the loop fails; put the
 * time back on skipped and the no-time assertion fails.
 */
test("a skipped row reads Not sent with no time, and an unknown status never claims delivery", () => {
  assert.equal(sentStatusLabel("skipped", AT), "Not sent");
  assert.ok(
    !sentStatusLabel("skipped", AT).includes(AT),
    "no time: created_at is not always the skip",
  );
  for (const other of ["bounced", "cancelled", "", "DELIVERED", "Delivered"]) {
    const label = sentStatusLabel(other, AT);
    assert.equal(label, "Status unknown", JSON.stringify(other));
    assert.ok(!/deliver|sent|read/i.test(label), `${JSON.stringify(other)} claims nothing`);
  }
});

// Negative control: label "sent" as Delivered and both rows below fail.
test("an email row Resend accepted reads Sent, never Delivered; a WhatsApp receipt reads Delivered or Read", async () => {
  const logs = [
    log("E-sent", "manual", "sent", { channel: "email" }),
    log("W-delivered", "booking_link", "delivered", { channel: "whatsapp" }),
    log("W-read", "manual", "read", { channel: "whatsapp" }),
  ];
  const page = await list("all", { logs });
  const footer = (id) => {
    const row = page.rows.find((r) => r.id === id);
    assert.ok(row, `${id} is listed`);
    return sentStatusLabel(row.status, AT);
  };
  assert.equal(footer("E-sent"), `Sent · ${AT}`);
  assert.ok(!/deliver/i.test(footer("E-sent")));
  assert.equal(footer("W-delivered"), `Delivered · sent ${AT}`);
  assert.equal(footer("W-read"), `Read · sent ${AT}`);
});

// Negative control: put back the hard-coded "Delivered · {when.exact}" (or any fallback) and this fails.
test("the drawer footer is the stored-status label alone, with no Delivered literal left", () => {
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(client, /\{sentStatusLabel\(row\.status, when\.exact\)\}/);
  assert.ok(!/Delivered/.test(client), "the client never writes Delivered itself");
});

/*
 * Through the real fetchMessages: a skipped row is listed, and its footer says
 * Not sent. Negative control: map skipped to Delivered and this fails.
 */
test("a listed skipped row's footer says Not sent, never Delivered", async () => {
  const logs = [log("K-skipped", "manual", "skipped", { channel: "email", sent_at: null })];
  const page = await list("all", { logs });
  const row = page.rows.find((r) => r.id === "K-skipped");
  assert.ok(row, "the skipped row is listed");
  const label = sentStatusLabel(row.status, AT);
  assert.equal(label, "Not sent");
  assert.ok(!/deliver/i.test(label));
});
