/**
 * The #85 attempt module: the decision list, the stamp contract, the error
 * classifier and the wrappers, without a database (3a-2).
 *
 *   node --test src/lib/communication-attempt.test.ts
 *
 * decide() is pure, so its branches are table rows. The wrappers run against
 * the stateful fake in test-support/fake-attempt-db.mjs, whose stamps are
 * microsecond strings compared exactly.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { APP_ID, attemptDb, COMPANY_ID, stamp } from "../test-support/fake-attempt-db.mjs";
import { fakeService } from "../test-support/fake-postgrest.mjs";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

const A = await import("./communication-attempt.ts");
const { JobYield, MAX_YIELD_DELAY_MS, TerminalJobError } = await import("./queue/failure-class.ts");

const Q = A.QUEUED_ONLY;
const S = stamp(5);
const OWNED = { id: "log-1", stamp: S };
const fresh = { rereads: 0 };
const reread = { rereads: 1 };
const precheck = (status, afterConflict = false) => ({
  from: "precheck",
  row: status ? { status } : null,
  afterConflict,
});
const claim = (result) => ({ from: "claim", result });
const transition = (outcome) => ({ from: "transition", result: { outcome } });
const again = (after, status) => ({ from: "reread", after, row: status ? { status } : null });

/* ── the sentences ────────────────────────────────────────────── */

// Negative control: change one character of any sentence and this fails.
test("the E sentences are verbatim, and none carries an em dash", () => {
  assert.deepEqual(
    [A.E1, A.E2, A.E3, A.E4, A.E9, A.E10, A.E11],
    [
      "Not re-sent: this message was first attempted more than 24 hours ago (#85).",
      "Waiting: another attempt is sending this message (#85).",
      "Could not claim the earlier log row for this message; will retry (#85).",
      "The earlier log row for this message disappeared before it could be claimed; will retry (#85).",
      "Not re-sent: scheduled messages are not retried automatically (#85).",
      "Not re-sent: this send was interrupted before attempts were timed (#85).",
      "Not sent: the application was deleted before this attempt could send (#85).",
    ],
  );
  for (const s of [A.E1, A.E2, A.E3, A.E4, A.E9, A.E10, A.E11]) {
    assert.ok(!/[–—]/.test(s), `a dash in: ${s}`);
  }
  assert.equal("E5" in A, false, "E5 has no trigger in 3a and no constant");
});

/* ── the delay ────────────────────────────────────────────────── */

// Negative controls: 61 minutes trips the ceiling; exactly 15 minutes loses the margin.
test("the send wait fits under the queue's ceiling and outlasts the claim's window", () => {
  assert.equal(A.SEND_RETRY_DELAY_MS, 16 * 60_000);
  assert.ok(A.SEND_RETRY_DELAY_MS <= MAX_YIELD_DELAY_MS, "every send wait would throw at runtime");
  assert.ok(A.SEND_RETRY_DELAY_MS > 15 * 60_000, "no margin over the claim's 15 minutes");
  assert.doesNotThrow(() => new JobYield(A.E2, A.SEND_RETRY_DELAY_MS));
});

/* ── decide(): the pre-check ──────────────────────────────────── */

test("an empty pre-check is a first attempt; after a conflict it is a counted E4, never a second insert", () => {
  assert.deepEqual(A.decide(precheck(null), fresh, Q), { kind: "first_attempt" });
  assert.deepEqual(A.decide(precheck(null, true), fresh, Q), { kind: "retry", message: A.E4 });
});

// Negative control: claim any of these, or let W5 write a reason onto them, and this fails.
test("sent, skipped and cancelled rows are terminal: done, no claim, no write", () => {
  for (const status of ["sent", "skipped", "cancelled"]) {
    const step = A.decide(precheck(status), fresh, Q);
    assert.equal(step.kind, "done", status);
  }
});

// Negative control: a policy that claims from 'failed' fails this (decision A).
test("a failed row is terminal for WhatsApp: done, never claimed", () => {
  assert.equal(A.decide(precheck("failed"), fresh, Q).kind, "done");
});

test("a queued row is claimed, from 'queued'", () => {
  assert.deepEqual(A.decide(precheck("queued"), fresh, Q), { kind: "claim" });
  assert.equal(Q.claimFrom, "queued");
});

/* ── decide(): the claim ──────────────────────────────────────── */

test("claimed owns the row, with the stamp passed through untouched", () => {
  const step = A.decide(claim({ outcome: "claimed", owned: OWNED }), fresh, Q);
  assert.equal(step.kind, "owned");
  assert.equal(step.owned.stamp, S);
});

// Negative control: map too_fresh to retry, or to a zero delay, and this fails.
test("too_fresh waits, uncounted", () => {
  assert.deepEqual(A.decide(claim({ outcome: "too_fresh", id: "x", observed: S }), fresh, Q), {
    kind: "wait",
  });
});

test("too_old sends E1 with the claim's observed stamp", () => {
  assert.deepEqual(A.decide(claim({ outcome: "too_old", id: "x", observed: S }), fresh, Q), {
    kind: "transition",
    id: "x",
    observed: S,
    rule: "E1",
  });
});

test("unclocked sends E10 with a null observed stamp", () => {
  assert.deepEqual(A.decide(claim({ outcome: "unclocked", id: "x", observed: null }), fresh, Q), {
    kind: "transition",
    id: "x",
    observed: null,
    rule: "E10",
  });
});

test("scheduled sends E9, and the transition's failed ends it", () => {
  const step = A.decide(claim({ outcome: "scheduled", id: "x", observed: null }), fresh, Q);
  assert.equal(step.rule, "E9");
  assert.equal(A.decide(transition("failed"), fresh, Q).kind, "done");
});

test("missing from a claim is a counted E4, and inserts nothing", () => {
  assert.deepEqual(A.decide(claim({ outcome: "missing" }), fresh, Q), {
    kind: "retry",
    message: A.E4,
  });
});

/* ── decide(): wrong_status (decision B, corrected) ───────────── */

// Negative controls: the queued branch returning wait, or a second wrong_status
// re-reading again or waiting, each fail a row here.
test("wrong_status re-reads once, then acts on the real status", () => {
  const w = claim({ outcome: "wrong_status", id: "x", observed: null });
  assert.deepEqual(A.decide(w, fresh, Q), { kind: "reread", after: "wrong_status" });
  const rows = [
    ["sent", "done"],
    ["skipped", "done"],
    ["cancelled", "done"],
    ["failed", "done"],
    ["queued", "retry"],
    [null, "retry"],
  ];
  for (const [status, kind] of rows) {
    const step = A.decide(again("wrong_status", status), reread, Q);
    assert.equal(step.kind, kind, `re-read finds ${status}`);
  }
  assert.deepEqual(A.decide(again("wrong_status", "queued"), reread, Q), {
    kind: "retry",
    message: A.E3,
  });
  assert.deepEqual(A.decide(again("wrong_status", null), reread, Q), {
    kind: "retry",
    message: A.E4,
  });
  assert.deepEqual(A.decide(w, reread, Q), { kind: "retry", message: A.E3 }, "twice is E3");
});

/* ── decide(): the transition ─────────────────────────────────── */

test("changed re-reads once and follows the list; a second changed is E3", () => {
  assert.deepEqual(A.decide(transition("changed"), fresh, Q), { kind: "reread", after: "changed" });
  assert.equal(A.decide(again("changed", "queued"), reread, Q).kind, "claim");
  assert.equal(A.decide(again("changed", "sent"), reread, Q).kind, "done");
  assert.deepEqual(A.decide(transition("changed"), reread, Q), { kind: "retry", message: A.E3 });
});

// Negative control: map not_due to done and this fails.
test("not_due waits, and never ends the job", () => {
  assert.deepEqual(A.decide(transition("not_due"), fresh, Q), { kind: "wait" });
});

// Negative control: map bad_rule to wait or to a counted retry and this fails.
test("bad_rule stops: a programming error, never a wait or a retry", () => {
  assert.equal(A.decide(transition("bad_rule"), fresh, Q).kind, "stop");
});

test("missing from a transition is a counted E4", () => {
  assert.deepEqual(A.decide(transition("missing"), fresh, Q), { kind: "retry", message: A.E4 });
});

// The rule the uncounted wait rests on: only two inputs may ever produce it.
test("only too_fresh and not_due produce an uncounted wait", () => {
  const inputs = [
    precheck(null),
    precheck(null, true),
    ...["queued", "sent", "failed", "skipped", "cancelled"].map((s) => precheck(s)),
    ...["queued", "sent", "failed", "skipped", "cancelled", null].flatMap((s) => [
      again("wrong_status", s),
      again("changed", s),
    ]),
    claim({ outcome: "claimed", owned: OWNED }),
    claim({ outcome: "too_old", id: "x", observed: S }),
    claim({ outcome: "unclocked", id: "x", observed: null }),
    claim({ outcome: "scheduled", id: "x", observed: S }),
    claim({ outcome: "wrong_status", id: "x", observed: S }),
    claim({ outcome: "missing" }),
    ...["failed", "changed", "bad_rule", "missing"].map(transition),
  ];
  for (const input of inputs) {
    for (const state of [fresh, reread]) {
      assert.notEqual(A.decide(input, state, Q).kind, "wait", JSON.stringify(input));
    }
  }
});

/* ── the stamp contract (N1 to N4) ────────────────────────────── */

const row = (outcome, id, at) => [{ out_id: id, out_attempt_started_at: at, out_outcome: outcome }];
const isContractBreak = (err) =>
  err instanceof TerminalJobError && err.failureClass === "deterministic";

// N1. Negative control: parse claimed with toObservedStamp and this fails.
test("N1: a claim answering claimed with a null stamp is a contract break", () => {
  assert.throws(() => A.parseClaimRows(row("claimed", "log-1", null)), isContractBreak);
  assert.equal(A.parseClaimRows(row("claimed", "log-1", S)).owned.stamp, S);
});

// N2. Negative control: let a null stamp through on the insert and this fails.
test("N2: a successful first-attempt insert with a null stamp is a contract break", async () => {
  const service = fakeService(() => ({
    data: [{ out_id: "log-1", out_attempt_started_at: null }],
    error: null,
    status: 200,
  }));
  await assert.rejects(
    A.insertFirstAttemptCommunicationLog(service, {
      applicationId: APP_ID,
      companyId: COMPANY_ID,
      event: "interview",
      channel: "whatsapp",
      toAddress: "923001234567",
      subject: null,
      body: "x",
    }),
    isContractBreak,
  );
});

test("N3 and N4: unclocked with a stamp, and too_old or too_fresh without one, break the contract", () => {
  assert.throws(() => A.parseClaimRows(row("unclocked", "x", S)), isContractBreak);
  assert.throws(() => A.parseClaimRows(row("too_old", "x", null)), isContractBreak);
  assert.throws(() => A.parseClaimRows(row("too_fresh", "x", null)), isContractBreak);
  assert.equal(A.parseClaimRows(row("unclocked", "x", null)).observed, null);
});

test("every other malformed answer is a contract break, never a wait", () => {
  for (const data of [
    [],
    [row("claimed", "x", S)[0], row("claimed", "y", S)[0]],
    null,
    row("teleported", "x", S),
    row("claimed", "x", 1763287205),
    row("missing", "x", null),
  ]) {
    assert.throws(() => A.parseClaimRows(data), isContractBreak, JSON.stringify(data));
  }
  assert.throws(
    () => A.parseTransitionRows([{ out_id: "x", out_outcome: "done" }]),
    isContractBreak,
  );
});

test("the type-check file still holds every directive", () => {
  const text = readFileSync(
    new URL("./communication-attempt.type-check.ts", import.meta.url),
    "utf8",
  );
  assert.equal(text.match(/^\/\/ @ts-expect-error /gm)?.length, 3);
});

/* ── the classifier ───────────────────────────────────────────── */

// Negative control: default an unknown code to transient and this fails.
test("database errors: transient only when listed, permanent otherwise", () => {
  const transient = [
    [{ code: "" }, 0],
    [{ code: "PGRST000" }, 503],
    [{ code: "PGRST003" }, 504],
    [{}, 502],
    [{}, 429],
    [{}, 520],
    [{ code: "08006" }, 500],
    [{ code: "40001" }, 500],
    [{ code: "40P01" }, 500],
    [{ code: "53300" }, 500],
    [{ code: "55P03" }, 500],
    [{ code: "57014" }, 500],
    [{ code: "57P01" }, 500],
  ];
  const permanent = [
    [{ code: "PGRST202" }, 404],
    [{ code: "PGRST203" }, 300],
    [{ code: "42883" }, 404],
    [{ code: "42501" }, 403],
    [{ code: "PGRST301" }, 401],
    [{ code: "22P02" }, 400],
    [{ code: "23514" }, 400],
    [{ code: "XX000" }, 500],
    [{}, 500],
    [null, 418],
  ];
  for (const [e, s] of transient)
    assert.equal(A.classifyDbError(e, s), "transient", `${e?.code} ${s}`);
  for (const [e, s] of permanent)
    assert.equal(A.classifyDbError(e, s), "permanent", `${e?.code} ${s}`);
});

test("a transient failure is a counted E3 Error; a permanent one is TerminalJobError", () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const t = A.dbFailure("claim", { code: "57014", message: "raw text" }, 500);
    assert.ok(!(t instanceof TerminalJobError) && !(t instanceof JobYield));
    assert.ok(t.message.startsWith(A.E3));
    assert.ok(!t.message.includes("raw text"), "never the database's own text");
    assert.ok(isContractBreak(A.dbFailure("claim", { code: "PGRST202" }, 404)));
  } finally {
    console.error = quiet;
  }
});

/* ── the wrappers ─────────────────────────────────────────────── */

const insertInput = {
  applicationId: APP_ID,
  companyId: COMPANY_ID,
  event: "interview",
  channel: "whatsapp",
  toAddress: "923001234567",
  subject: null,
};

// Negative control: send the raw body and this fails.
test("the first-attempt insert sends a redacted body and no time of any kind", async () => {
  const { service } = attemptDb();
  const token = "a".repeat(43);
  const r = await A.insertFirstAttemptCommunicationLog(service, {
    ...insertInput,
    body: `see https://remotiv.work/interview/${token}`,
  });
  assert.equal(r.kind, "owned");
  const [call] = service.rpcs;
  assert.equal(call.name, "insert_first_attempt_communication_log");
  assert.ok(!call.args.p_body.includes(token), "the token reached p_body");
  assert.deepEqual(Object.keys(call.args).sort(), [
    "p_application_id",
    "p_body",
    "p_channel",
    "p_company_id",
    "p_event",
    "p_subject",
    "p_to_address",
  ]);
});

// Negative control: classify 23505 as permanent and this fails.
test("23505 from the insert is a conflict, not an error", async () => {
  const { service } = attemptDb({
    logs: [
      {
        id: "log-x",
        application_id: APP_ID,
        event: "interview",
        channel: "whatsapp",
        status: "queued",
        sent_by_name: null,
        attempt_started_at: stamp(1),
      },
    ],
  });
  assert.deepEqual(
    await A.insertFirstAttemptCommunicationLog(service, { ...insertInput, body: "x" }),
    {
      kind: "conflict",
    },
  );
});

/*
 * 23503 is settled by a read of the application, never by the message. The
 * wrapper hands it back; settleForeignKeyViolation decides on the read alone.
 * Each message below names the OTHER key from the one the outcome needs, so a
 * decision read off the message gets both wrong. Negative control: branch on
 * the message and both of the last two rows fail.
 */
const APP_FK = 'violates foreign key constraint "communication_logs_application_id_fkey"';
const COMPANY_FK = 'violates foreign key constraint "communication_logs_company_id_fkey"';

async function quietly(run) {
  const saved = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    Object.assign(console, saved);
  }
}

test("23503 from the insert goes back to the caller, unread and undecided", async () => {
  const error = { code: "23503", message: APP_FK };
  const { service } = attemptDb({ insert: () => ({ data: null, error, status: 409 }) });
  const r = await A.insertFirstAttemptCommunicationLog(service, { ...insertInput, body: "x" });
  assert.deepEqual(r, { kind: "foreign_key", error });
  assert.equal(
    service.queries.filter((q) => q.table === "job_applications").length,
    0,
    "the wrapper reads nothing; the dispatcher reads on its justified query",
  );
});

test("an application gone settles 23503 as gone, whatever the message names", async () => {
  const r = await quietly(() =>
    A.settleForeignKeyViolation({ code: "23503", message: COMPANY_FK }, false),
  );
  assert.equal(r, "gone");
});

test("an application still there makes 23503 permanent, whatever the message names", async () => {
  await assert.rejects(
    quietly(async () => A.settleForeignKeyViolation({ code: "23503", message: APP_FK }, true)),
    isContractBreak,
  );
});

// Negative control: skip the read and call every 23503 gone; the second half fails.
test("confirmApplicationGone makes one company-filtered read and settles on it", async () => {
  const error = { code: "23503", message: APP_FK };
  const gone = attemptDb({ app: null });
  assert.equal(
    await quietly(() =>
      A.confirmApplicationGone(
        gone.service,
        { applicationId: APP_ID, companyId: COMPANY_ID },
        error,
      ),
    ),
    "gone",
  );
  const reads = gone.service.queries.filter((q) => q.table === "job_applications");
  assert.equal(reads.length, 1);
  assert.ok(reads[0].calls.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot"));
  const there = attemptDb();
  await assert.rejects(
    quietly(() =>
      A.confirmApplicationGone(
        there.service,
        { applicationId: APP_ID, companyId: COMPANY_ID },
        error,
      ),
    ),
    isContractBreak,
  );
});

/* ── the fake keeps stamps exact ──────────────────────────────── */

// If the fake ever normalised times, every stamp test would pass vacuously.
test("the fake matches a stamp only by its exact string", async () => {
  const base = {
    application_id: APP_ID,
    event: "interview",
    channel: "whatsapp",
    sent_by_name: null,
  };
  const { service, db } = attemptDb({
    logs: [{ id: "log-1", status: "queued", attempt_started_at: S, ...base }],
  });
  const owned = (s) => ({ id: "log-1", stamp: s });
  const rounded = new Date(S).toISOString();
  assert.equal(rounded, "2026-11-16T10:00:05.123Z");
  assert.equal(
    await A.markOwnedSkipped(service, owned(rounded), { error: "x", toAddress: "y" }),
    false,
  );
  assert.equal(
    await A.markOwnedSkipped(service, owned("2026-11-16T10:00:05.123456Z"), {
      error: "x",
      toAddress: "y",
    }),
    false,
    "even the same instant, reformatted",
  );
  assert.equal(db.logs[0].status, "queued");
  assert.equal(await A.markOwnedSkipped(service, owned(S), { error: "x", toAddress: "y" }), true);
});

/* ── nothing here touches a clock ─────────────────────────────── */

const DATE_API = /\bnew Date\b|\bDate\.(now|parse|UTC)\b|\.getTime\(|\.toISOString\(|\.valueOf\(/;
const DATE_APIS = new RegExp(DATE_API.source, "g");

// Negative control: reintroduce the old age check (Date.now() - new Date(...)) and this fails.
test("the module has no Date at all, and the WhatsApp dispatcher only its two sent_at writes", () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const mod = strip(readFileSync(new URL("./communication-attempt.ts", import.meta.url), "utf8"));
  assert.deepEqual(mod.match(DATE_APIS) ?? [], []);
  const wa = strip(readFileSync(new URL("./whatsapp/dispatch.ts", import.meta.url), "utf8"));
  const lines = wa.split("\n").filter((l) => DATE_API.test(l));
  assert.deepEqual(
    lines.map((l) => l.trim()),
    [
      "sent_at: new Date().toISOString(),",
      '...(row.status === "sent" ? { sent_at: new Date().toISOString() } : {}),',
    ],
  );
});

// Source (b) by construction: no read hands the code a stamp to carry back.
// Negative control: add attempt_started_at to the pre-check's select and this fails.
test("no select in the attempt path reads attempt_started_at", () => {
  for (const file of ["./communication-attempt.ts", "./whatsapp/dispatch.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const m of text.matchAll(/\.select\(\s*"([^"]*)"/g)) {
      assert.ok(!m[1].includes("attempt_started_at"), `${file}: .select("${m[1]}")`);
    }
  }
});

/*
 * The two functions that take a companyId are called from one place, whose
 * companyId is derived from the application row (tenant-isolation.test.ts,
 * SITE_FILTER_VALUES, confirmApplicationGone). A new caller, 3a-3 included,
 * must be traced the same way before it lands. Negative control: call either
 * function from another file and this fails.
 */
test("the company-taking functions have exactly one caller, the WhatsApp dispatcher", () => {
  const SRC = new URL("./", import.meta.url);
  const callers = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const url = new URL(`${e.name}${e.isDirectory() ? "/" : ""}`, dir);
      if (e.isDirectory()) walk(url);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const text = readFileSync(url, "utf8");
        if (/\b(insertFirstAttemptCommunicationLog|confirmApplicationGone)\(/.test(text)) {
          callers.push(url.pathname.slice(SRC.pathname.length));
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(callers.sort(), ["communication-attempt.ts", "whatsapp/dispatch.ts"]);
});
