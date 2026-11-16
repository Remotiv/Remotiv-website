/**
 * The WhatsApp dispatcher on #85's ownership rules (3a-2), end to end.
 *
 *   node --test src/lib/whatsapp/dispatch-claim.test.ts
 *
 * Drives the real handleWhatsAppMessage, the real attempt module and the real
 * send module against test-support/fake-attempt-db.mjs (a stateful
 * communication_logs whose stamps are microsecond strings compared exactly)
 * and a fake `fetch` for Meta. "Sent" means a request reached the fake Meta.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import {
  APP_ID,
  attemptDb,
  COMPANY_ID,
  logById,
  stamp,
} from "../../test-support/fake-attempt-db.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/whatsapp-dispatch-test-hook.mjs", import.meta.url));

const { handleWhatsAppMessage } = await import("./dispatch.ts");
const A = await import("../communication-attempt.ts");
const { JobYield, TerminalJobError } = await import("../queue/failure-class.ts");

const DIGITS = "923001234567";
const META_OK = () =>
  new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
const META = {
  ok: META_OK,
  terminal: () =>
    new Response(JSON.stringify({ error: { message: "Template does not exist", code: 132001 } }), {
      status: 400,
    }),
  transient: () => new Response("{}", { status: 500 }),
  noId: () => new Response("{}", { status: 200 }),
  timeout: () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  },
};

const row = (over) => ({
  id: "log-old",
  company_id: "c",
  application_id: APP_ID,
  event: "interview",
  channel: "whatsapp",
  status: "queued",
  sent_by_name: null,
  error: null,
  attempt_started_at: stamp(1),
  ...over,
});

/** Run one send. Answers what happened: Meta calls, the outcome, the logs. */
async function run(world, { meta = "ok", sentByName, onMeta, payloadExtra = {} } = {}) {
  const { service, db } = world;
  const metaCalls = [];
  const saved = {
    fetch: globalThis.fetch,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const logs = [];
  globalThis.__whatsappDispatchServiceForTests = () => service;
  globalThis.fetch = async (_url, init) => {
    metaCalls.push(init?.body);
    onMeta?.(db);
    return META[meta]();
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  for (const k of ["log", "warn", "error"])
    console[k] = (...a) => logs.push(a.map(String).join(" "));
  let outcome = { kind: "resolved" };
  try {
    await handleWhatsAppMessage({
      id: "job-1",
      payload: {
        applicationId: APP_ID,
        event: "interview",
        channel: "whatsapp",
        ...(sentByName ? { sentByName } : {}),
        ...payloadExtra,
      },
    });
  } catch (err) {
    outcome = { kind: "threw", err };
  } finally {
    delete globalThis.__whatsappDispatchServiceForTests;
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [
      ["WHATSAPP_ACCESS_TOKEN", saved.token],
      ["WHATSAPP_PHONE_NUMBER_ID", saved.phoneId],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
  }
  const updates = service.queries
    .filter((q) => q.table === "communication_logs")
    .map((q) => ({ calls: q.calls, patch: q.calls.find((c) => c[0] === "update")?.[1] }))
    .filter((u) => u.patch);
  const inserts = service.queries
    .filter((q) => q.table === "communication_logs")
    .map((q) => q.calls.find((c) => c[0] === "insert")?.[1])
    .filter(Boolean);
  const alerted = service.queries.some((q) => q.table === "company_members");
  return { outcome, metaCalls, db, service, updates, inserts, alerted, logs };
}

const rpcNames = (service) => service.rpcs.map((r) => r.name);
const eqOf = (calls, col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
const guardedOn = (u, s) =>
  eqOf(u.calls, "status") === "queued" && eqOf(u.calls, "attempt_started_at") === s;

/* ── a first attempt ──────────────────────────────────────────── */

// Negative control: insert the automatic queued row with writeLog and this fails.
test("a first attempt is inserted by the database, refreshed under its stamp, and sent", async () => {
  const r = await run(attemptDb());
  assert.equal(r.outcome.kind, "resolved");
  assert.deepEqual(rpcNames(r.service), ["insert_first_attempt_communication_log"]);
  assert.equal(r.inserts.length, 0, "no plain insert of the queued row");
  const row = r.db.logs[0];
  assert.equal(r.metaCalls.length, 1);
  assert.ok(r.metaCalls[0].includes(DIGITS), "addressed to the normalised number");
  assert.equal(row.status, "sent");
  const refresh = r.updates.find((u) => "body" in u.patch);
  assert.ok(guardedOn(refresh, stamp(50)), "the refresh carries the inserted stamp, exactly");
  assert.ok(refresh.calls.some((c) => c[0] === "not" && c[1] === "application_id"));
});

/* ── a claimed retry ──────────────────────────────────────────── */

// Negative control: drop the stamp filter from the refresh and the guard check fails.
test("a stale queued row is claimed, refreshed under the NEW stamp, sent, and written sent by id", async () => {
  const r = await run(attemptDb({ logs: [row({ stale: true })] }));
  assert.deepEqual(rpcNames(r.service), ["claim_communication_log"]);
  assert.equal(r.service.rpcs[0].args.p_from_status, "queued");
  const claimed = stamp(50);
  const refresh = r.updates.find((u) => "body" in u.patch);
  assert.ok(guardedOn(refresh, claimed));
  assert.equal(r.metaCalls.length, 1);
  const sent = r.updates.find((u) => u.patch.status === "sent");
  assert.deepEqual(
    sent.calls.filter((c) => c[0] === "eq"),
    [["eq", "id", "log-old"]],
    "success stays by id",
  );
  assert.equal(logById(r.db, "log-old").status, "sent");
});

// Negative control: insert the skip instead and the fake answers 23505.
test("a claimed row that turns out opted out is skipped by a guarded update, not an insert", async () => {
  const r = await run(attemptDb({ logs: [row({ stale: true })], optedOut: true }));
  assert.equal(r.metaCalls.length, 0);
  assert.equal(r.inserts.length, 0);
  const skip = r.updates.find((u) => u.patch.status === "skipped");
  assert.ok(guardedOn(skip, stamp(50)));
  assert.equal(logById(r.db, "log-old").status, "skipped");
  assert.equal(r.outcome.kind, "resolved");
});

// Negative control: send anyway after a refresh that matched nothing and this fails.
test("a stop that lands between the claim and the send is honoured: nothing sent, the row stays cancelled", async () => {
  const world = attemptDb({
    logs: [row({ stale: true })],
    beforeWrite: (db, patch) => {
      if ("body" in patch) logById(db, "log-old").status = "cancelled";
    },
  });
  const r = await run(world);
  assert.equal(r.metaCalls.length, 0);
  assert.equal(logById(r.db, "log-old").status, "cancelled");
  assert.equal(logById(r.db, "log-old").error, null, "the finalise did not touch a stopped row");
});

// Negative control: guard the success write and the cancelled row is left cancelled.
test("a send that happened is recorded sent, even if the row was cancelled meanwhile", async () => {
  const r = await run(attemptDb({ logs: [row({ stale: true })] }), {
    onMeta: (db) => {
      logById(db, "log-old").status = "cancelled";
    },
  });
  assert.equal(logById(r.db, "log-old").status, "sent");
});

/* ── failures ─────────────────────────────────────────────────── */

for (const meta of ["terminal", "transient"]) {
  // Negative control: drop the stamp filter, or throw on transient, and this fails.
  test(`a ${meta} Meta refusal after a claim is a guarded failed write, a bell, and a completed job`, async () => {
    const r = await run(attemptDb({ logs: [row({ stale: true })] }), { meta });
    assert.equal(
      r.outcome.kind,
      "resolved",
      "an automatic send never throws after a recorded failure",
    );
    const failed = r.updates.find((u) => u.patch.status === "failed");
    assert.ok(guardedOn(failed, stamp(50)));
    assert.equal(logById(r.db, "log-old").status, "failed");
    assert.ok(r.alerted, "the bell is the signal");
  });
}

test("a failed write that matches nothing (re-claimed elsewhere) rings no bell and changes nothing", async () => {
  const r = await run(attemptDb({ logs: [row({ stale: true })] }), {
    meta: "terminal",
    onMeta: (db) => {
      logById(db, "log-old").attempt_started_at = stamp(77);
    },
  });
  assert.equal(r.outcome.kind, "resolved");
  assert.equal(logById(r.db, "log-old").status, "queued");
  assert.equal(r.alerted, false);
});

// Decision A: uncertain answers are recorded failed, never sent, never resent.
for (const meta of ["timeout", "noId"]) {
  test(`an uncertain Meta answer (${meta}) is recorded failed and never resent`, async () => {
    const world = attemptDb();
    const first = await run(world, { meta });
    assert.equal(first.outcome.kind, "resolved");
    assert.equal(world.db.logs[0].status, "failed");
    const second = await run(world);
    assert.equal(second.metaCalls.length, 0, "a failed row is not claimed again");
    assert.deepEqual(rpcNames(second.service), ["insert_first_attempt_communication_log"]);
    assert.equal(second.service.rpcs.filter((x) => x.name === "claim_communication_log").length, 0);
  });
}

/* ── terminal rows at the pre-check (W5 is gone) ──────────────── */

// Negative control: reinstate W5 and the zero-writes assertion fails.
for (const status of ["sent", "skipped", "cancelled", "failed"]) {
  test(`a ${status} row at the pre-check: no claim, no send, no write of any kind`, async () => {
    const r = await run(attemptDb({ logs: [row({ status })] }));
    assert.equal(r.outcome.kind, "resolved");
    assert.deepEqual(rpcNames(r.service), []);
    assert.equal(r.metaCalls.length, 0);
    assert.deepEqual(r.updates, []);
    assert.deepEqual(r.inserts, []);
  });
}

/* ── waits, retries and stops ─────────────────────────────────── */

test("too_fresh waits 16 minutes, uncounted, with E2", async () => {
  const r = await run(attemptDb({ logs: [row()] }));
  assert.equal(r.outcome.kind, "threw");
  assert.ok(r.outcome.err instanceof JobYield);
  assert.equal(r.outcome.err.message, A.E2);
  assert.equal(r.outcome.err.delayMs, A.SEND_RETRY_DELAY_MS);
  assert.equal(r.metaCalls.length, 0);
});

// Negative control: pass the observed stamp through a Date and the transition answers changed.
test("too_old ends the row with E1, passing the observed stamp back exactly", async () => {
  const r = await run(attemptDb({ logs: [row({ old: true })] }));
  assert.equal(r.outcome.kind, "resolved");
  const t = r.service.rpcs.find((x) => x.name === "fail_observed_communication_log");
  assert.equal(t.args.p_observed_stamp, stamp(1));
  assert.equal(t.args.p_rule, "E1");
  assert.equal(logById(r.db, "log-old").error, A.E1);
  assert.equal(r.metaCalls.length, 0);
});

test("unclocked ends the row with E10, sending an explicit null stamp", async () => {
  const r = await run(attemptDb({ logs: [row({ attempt_started_at: null })] }));
  const t = r.service.rpcs.find((x) => x.name === "fail_observed_communication_log");
  assert.ok("p_observed_stamp" in t.args);
  assert.equal(t.args.p_observed_stamp, null);
  assert.equal(logById(r.db, "log-old").status, "failed");
  assert.equal(logById(r.db, "log-old").error, A.E10);
  assert.equal(r.metaCalls.length, 0);
});

test("bad_rule stops the job with TerminalJobError", async () => {
  const r = await run(
    attemptDb({
      logs: [row({ old: true })],
      transition: (args) => ({
        data: [{ out_id: args.p_id, out_outcome: "bad_rule" }],
        error: null,
        status: 200,
      }),
    }),
  );
  assert.ok(r.outcome.err instanceof TerminalJobError);
});

// Negative control: swap the two classes and both rows fail.
test("a transient claim error is a counted E3; PGRST202 (059 missing) is TerminalJobError", async () => {
  const failing = (code, status) =>
    attemptDb({
      logs: [row({ stale: true })],
      claim: () => ({ data: null, error: { code, message: "raw database text" }, status }),
    });
  const t = await run(failing("", 503));
  assert.ok(!(t.outcome.err instanceof JobYield) && !(t.outcome.err instanceof TerminalJobError));
  assert.ok(t.outcome.err.message.startsWith(A.E3));
  const p = await run(failing("PGRST202", 404));
  assert.ok(p.outcome.err instanceof TerminalJobError);
});

/* ── recruiter sends ──────────────────────────────────────────── */

// Negative control: route a recruiter send through the insert function and sent_by_name is lost.
test("a recruiter's send claims nothing and keeps its plain insert with the name", async () => {
  const r = await run(attemptDb({ logs: [row({ status: "sent" })] }), { sentByName: "Rae" });
  assert.deepEqual(rpcNames(r.service), []);
  assert.equal(r.inserts.length, 1);
  assert.equal(r.inserts[0].sent_by_name, "Rae");
  assert.equal(r.metaCalls.length, 1);
});

/* ── conflicts ────────────────────────────────────────────────── */

test("a first-attempt insert that collides re-reads once and waits behind the other attempt", async () => {
  const world = attemptDb({
    insert: (_args, db) => {
      db.logs.push(row({ id: "log-theirs", attempt_started_at: stamp(9) }));
      return { data: null, error: { code: "23505", message: "duplicate key" }, status: 409 };
    },
  });
  const r = await run(world);
  assert.ok(r.outcome.err instanceof JobYield);
  assert.equal(r.metaCalls.length, 0);
  assert.equal(world.db.logs.length, 1, "no second automatic row");
});

test("a first-attempt skipped insert that collides takes the conflict path, never a second row", async () => {
  const world = attemptDb({ optedOut: true });
  const realFrom = world.service.from.bind(world.service);
  world.service.from = (table) => {
    const q = realFrom(table);
    if (table !== "communication_logs") return q;
    return new Proxy(q, {
      get(target, prop) {
        if (prop !== "insert") return target[prop];
        // Another attempt writes its row just before ours lands.
        return (...a) => {
          world.db.logs.push(row({ id: "log-theirs", attempt_started_at: stamp(9) }));
          return target.insert(...a);
        };
      },
    });
  };
  const r = await run(world);
  assert.ok(r.outcome.err instanceof JobYield, "waits behind the other attempt");
  assert.equal(world.db.logs.length, 1);
});

/* ── a deleted application (correction 3) ─────────────────────── */

// O1. Negative control: claim before loading the application and the claim RPC appears.
test("O1: an application gone at load: no claim, no write, the job is skipped", async () => {
  const r = await run(attemptDb({ app: null, logs: [row({ stale: true })] }));
  assert.equal(r.outcome.kind, "resolved");
  assert.deepEqual(rpcNames(r.service), []);
  assert.deepEqual(r.updates, []);
  assert.ok(r.logs.some((l) => l.includes("[job-skip]")));
});

/*
 * O2. Deleted after the load and before the claim: the claim answers missing,
 * the run retries (counted E4), and the row is LEFT BEHIND, queued, with a
 * NULL application_id. No pre-check or claim can reach it again. This is the
 * one residual: a queued row whose application is deleted while no live
 * worker owns it stays queued; 056's manual sweep clears its personal data
 * after 30 days, never its status.
 */
test("O2: deleted between the load and the claim: counted E4, and the row is left orphaned and queued", async () => {
  const world = attemptDb({
    logs: [row({ stale: true })],
    claim: (_args, db) => {
      logById(db, "log-old").application_id = null;
      return {
        data: [{ out_id: null, out_attempt_started_at: null, out_outcome: "missing" }],
        error: null,
        status: 200,
      };
    },
  });
  const r = await run(world);
  assert.equal(r.outcome.err.message, A.E4);
  assert.ok(!(r.outcome.err instanceof JobYield));
  const left = logById(world.db, "log-old");
  assert.equal(left.status, "queued", "nothing finalises it");
  assert.equal(left.application_id, null);
  assert.equal(r.metaCalls.length, 0);
});

// O3. Negative control: call every 23503 gone without the read and the second row fails.
test("O3: the insert's 23503 is settled by one read: gone skips, still there stops", async () => {
  const gone = attemptDb();
  const realFrom = gone.service.from.bind(gone.service);
  gone.service.from = (table) => {
    if (table === "companies") gone.db.app = null; // deleted after the load
    return realFrom(table);
  };
  const g = await run(gone);
  assert.equal(g.outcome.kind, "resolved");
  assert.equal(g.metaCalls.length, 0);
  assert.ok(g.logs.some((l) => l.includes("[job-skip]")));

  const there = attemptDb({
    insert: () => ({
      data: null,
      error: {
        code: "23503",
        message: 'violates foreign key constraint "communication_logs_application_id_fkey"',
      },
      status: 409,
    }),
  });
  const t = await run(there);
  assert.ok(t.outcome.err instanceof TerminalJobError);
  assert.equal(t.metaCalls.length, 0);
});

test("O3: the same 23503 rule on the plain skipped insert", async () => {
  const gone = attemptDb({ optedOut: true });
  const realFrom = gone.service.from.bind(gone.service);
  gone.service.from = (table) => {
    if (table === "whatsapp_opt_outs") gone.db.app = null;
    return realFrom(table);
  };
  const g = await run(gone);
  assert.equal(g.outcome.kind, "resolved");
  assert.ok(g.logs.some((l) => l.includes("[job-skip]")));

  const there = attemptDb({ optedOut: true });
  const realThere = there.service.from.bind(there.service);
  there.service.from = (table) => {
    const q = realThere(table);
    if (table !== "communication_logs") return q;
    return new Proxy(q, {
      get(target, prop) {
        if (prop !== "insert") return target[prop];
        return (...a) => {
          target.insert(...a);
          return {
            select: () => ({
              single: async () => ({
                data: null,
                error: { code: "23503", message: "violates foreign key constraint" },
                status: 409,
              }),
            }),
          };
        };
      },
    });
  };
  const t = await run(there);
  assert.ok(t.outcome.err instanceof TerminalJobError, "an application still there is permanent");
});

// O4 and O5. Negative control: drop `application_id is not null` from the refresh and Meta is called.
test("O4: owned, then orphaned before the send: not sent, finalised skipped with E11, and only status and error written", async () => {
  const world = attemptDb({
    logs: [row({ stale: true })],
    beforeWrite: (db, patch) => {
      if ("body" in patch) logById(db, "log-old").application_id = null;
    },
  });
  const r = await run(world);
  assert.equal(r.outcome.kind, "resolved");
  assert.equal(r.metaCalls.length, 0);
  const left = logById(world.db, "log-old");
  assert.equal(left.status, "skipped");
  assert.equal(left.error, A.E11);
  assert.equal(left.application_id, null, "never restored");
  const fin = r.updates.find((u) => u.patch.error === A.E11);
  assert.deepEqual(Object.keys(fin.patch).sort(), ["error", "status"]);
  assert.ok(fin.calls.some((c) => c[0] === "is" && c[1] === "application_id" && c[2] === null));
  assert.ok(guardedOn(fin, stamp(50)));
});

/* ── tenancy: the company comes from the application, never the payload ── */

/*
 * A forged payload names another company. Every company id the attempt path
 * uses must still be the application's own: the insert's p_company_id, the
 * plain skipped insert's company_id, and the company filter on the 23503
 * re-read. Negative control: bind companyId from payload.companyId in the
 * dispatcher and every assertion here fails.
 */
const FORGED = { companyId: "f0000000-0000-4000-8000-0000000000f0", company_id: "f-forged" };

test("a company id in the job payload never reaches the insert RPC or the 23503 re-read", async () => {
  const sent = await run(attemptDb(), { payloadExtra: FORGED });
  const insert = sent.service.rpcs.find((x) => x.name === "insert_first_attempt_communication_log");
  assert.equal(insert.args.p_company_id, COMPANY_ID);

  const fk = attemptDb({
    insert: () => ({ data: null, error: { code: "23503", message: "fk" }, status: 409 }),
  });
  await run(fk, { payloadExtra: FORGED });
  const reread = fk.service.queries.filter((q) => q.table === "job_applications").at(-1);
  assert.equal(
    reread.calls.find((c) => c[0] === "eq" && c[1] === "company_id_snapshot")?.[2],
    COMPANY_ID,
  );

  const skipped = await run(attemptDb({ optedOut: true }), { payloadExtra: FORGED });
  assert.equal(skipped.inserts[0].company_id, COMPANY_ID);
});

/* ── the application read gates everything: an error is not "gone" ── */

/*
 * A transient failure on the first read must retry, counted, and never skip:
 * a skip would drop the message and leave nothing to retry it. Negative
 * control: ignore the read's error (read it as no row) and the job is skipped,
 * resolved, and both of these fail.
 */
test("a transient error on the application read is a counted retry, never a skip", async () => {
  const r = await run(
    attemptDb({ logs: [row({ stale: true })], appRead: { error: { code: "" }, status: 503 } }),
  );
  assert.equal(r.outcome.kind, "threw");
  assert.ok(!(r.outcome.err instanceof JobYield) && !(r.outcome.err instanceof TerminalJobError));
  assert.ok(r.outcome.err.message.startsWith(A.E3));
  assert.ok(!r.logs.some((l) => l.includes("[job-skip]")), "the job was skipped");
  assert.deepEqual(rpcNames(r.service), [], "nothing is claimed before the application is known");
  assert.deepEqual(r.updates, []);
});

test("a permanent error on the application read stops the job loudly, never a skip", async () => {
  const r = await run(attemptDb({ appRead: { error: { code: "42501" }, status: 403 } }));
  assert.ok(r.outcome.err instanceof TerminalJobError);
  assert.ok(!r.logs.some((l) => l.includes("[job-skip]")));
});

// Negative control: treat an empty read as an error and this throws instead of skipping.
test("a read that succeeds and finds no application still skips the job", async () => {
  const r = await run(attemptDb({ app: null }));
  assert.equal(r.outcome.kind, "resolved");
  assert.ok(r.logs.some((l) => l.includes("[job-skip]") && l.includes("no longer exists")));
  assert.deepEqual(rpcNames(r.service), []);
});

/*
 * The tenant-isolation record for this handler names the line where tenancy is
 * derived. Prose cannot be checked by reading it, so this checks it. Negative
 * control: move the binding by a line and this fails until the prose follows.
 */
test("the tenant record's line for the companyId derivation points at the binding", () => {
  const tenant = readFileSync(new URL("../tenant-isolation.test.ts", import.meta.url), "utf8");
  const entry = tenant.slice(tenant.indexOf('file: "lib/whatsapp/dispatch.ts"'));
  const cited = Number(/app\.company_id_snapshot` at (\d+)/.exec(entry)?.[1]);
  const lines = readFileSync(new URL("./dispatch.ts", import.meta.url), "utf8").split("\n");
  assert.equal(lines[cited - 1]?.trim(), "const companyId = app.company_id_snapshot;");

  // The confirmApplicationGone record cites its callers, the binding and the read.
  const site = tenant.slice(tenant.indexOf('fn: "confirmApplicationGone"'));
  const at = (re) => Number(re.exec(site)?.[1]);
  const line = (n) => lines[n - 1] ?? "";
  assert.match(line(at(/dispatch\.ts:(\d+) and/)), /confirmApplicationGone\(/);
  assert.match(line(at(/dispatch\.ts:\d+ and :(\d+)/)), /confirmApplicationGone\(/);
  assert.match(line(at(/the insert at :(\d+)/)), /insertFirstAttemptCommunicationLog\(/);
  assert.match(line(at(/bound at (\d+)/)), /const companyId = app\.company_id_snapshot;/);
  assert.match(line(at(/read at (\d+)-/)), /^\s*const \{$/);
  assert.match(line(at(/read at \d+-(\d+)/)), /\.maybeSingle\(\);/);
  assert.match(
    line(at(/payload\.applicationId \((\d+)\)/)),
    /const applicationId = payload\?\.applicationId;/,
  );
});
