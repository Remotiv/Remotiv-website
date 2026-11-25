/**
 * #67: WhatsApp is strictly opt-in. No tick on the apply form, no WhatsApp,
 * on every send path; a STOP still wins over a tick; the email never depends
 * on it; and nothing sends WhatsApp outside the one guard.
 *
 *   node --test src/lib/whatsapp/opt-in.test.ts
 *
 * The real dispatcher and queueManualWhatsApp against test-support's
 * fake-attempt-db and a fake Meta, as dispatch-manual.test.ts runs them. "Sent"
 * means a request reached the fake Meta; no real network. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  APP_ID,
  attemptDb,
  COMPANY_ID,
  DEFAULT_APP,
  logById,
} from "../../test-support/fake-attempt-db.mjs";
import { blockNetwork } from "../../test-support/no-network.mjs";

const guard = blockNetwork();
register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/whatsapp-dispatch-test-hook.mjs", import.meta.url));

const { handleWhatsAppMessage, queueManualWhatsApp, OPTED_OUT_REASON } = await import(
  "./dispatch.ts"
);
const { hasWhatsAppOptIn, NO_OPT_IN_REASON, optInColumns, WHATSAPP_OPT_IN_LABEL } = await import(
  "./consent.ts"
);

const TICKED_AT = "2026-11-25T09:00:00.000Z";

/** The shapes an application can be in. `before079` has no consent columns at all. */
const APPS = {
  optedIn: { ...DEFAULT_APP, whatsapp_opt_in: true, whatsapp_opt_in_at: TICKED_AT },
  notTicked: { ...DEFAULT_APP, whatsapp_opt_in: false, whatsapp_opt_in_at: null },
  existing: { ...DEFAULT_APP, whatsapp_opt_in: null, whatsapp_opt_in_at: null },
  before079: (({ whatsapp_opt_in, whatsapp_opt_in_at, ...rest }) => rest)(DEFAULT_APP),
  tickWithoutTime: { ...DEFAULT_APP, whatsapp_opt_in: true, whatsapp_opt_in_at: null },
};
const REFUSED = ["notTicked", "existing", "before079", "tickWithoutTime"];

/** Run one send_message[whatsapp] job; answers how many requests reached Meta. */
async function run(world, payload) {
  const metaCalls = [];
  const saved = {
    fetch: globalThis.fetch,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  globalThis.__whatsappDispatchServiceForTests = () => world.service;
  globalThis.fetch = async (_url, init) => {
    metaCalls.push(init?.body);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  for (const k of ["log", "warn", "error"]) console[k] = () => {};
  let threw = null;
  try {
    await handleWhatsAppMessage({
      id: "job-1",
      attempts: 0,
      payload: { applicationId: APP_ID, channel: "whatsapp", ...payload },
    });
  } catch (err) {
    threw = err;
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
  return { metaCalls, threw };
}

async function queue(world) {
  globalThis.__whatsappDispatchServiceForTests = () => world.service;
  try {
    return await queueManualWhatsApp(world.service, {
      applicationId: APP_ID,
      companyId: COMPANY_ID,
      event: "interview",
      sentByName: "Rae",
      deadline: "30 Nov 2026",
    });
  } finally {
    delete globalThis.__whatsappDispatchServiceForTests;
  }
}

/** A recruiter's row as queue_manual_whatsapp leaves it: queued, unclaimed. */
const queuedRow = () => ({
  id: "log-q",
  company_id: COMPANY_ID,
  application_id: APP_ID,
  event: "interview",
  channel: "whatsapp",
  status: "queued",
  sent_by_name: "Rae",
  error: null,
  attempt_started_at: null,
});

// ── The consent rule itself ─────────────────────────────────

test("consent is a tick AND its time; anything else is no consent", () => {
  assert.equal(hasWhatsAppOptIn(APPS.optedIn), true);
  for (const shape of REFUSED) assert.equal(hasWhatsAppOptIn(APPS[shape]), false, shape);
  assert.equal(hasWhatsAppOptIn({ whatsapp_opt_in: "true", whatsapp_opt_in_at: TICKED_AT }), false);
  assert.equal(hasWhatsAppOptIn({ whatsapp_opt_in: true, whatsapp_opt_in_at: "" }), false);
  assert.equal(hasWhatsAppOptIn(null), false);
  assert.equal(hasWhatsAppOptIn(undefined), false);
});

test("the apply form's tick is stored with the server's time; nothing else is a tick", () => {
  const now = new Date("2026-11-25T10:11:12.345Z");
  assert.deepEqual(optInColumns("yes", "job_application", now), {
    whatsapp_opt_in: true,
    whatsapp_opt_in_at: "2026-11-25T10:11:12.345Z",
  });
  const none = { whatsapp_opt_in: false, whatsapp_opt_in_at: null };
  for (const posted of [null, undefined, "", "on", "true", "YES", "1", "no", new Blob(["yes"])]) {
    assert.deepEqual(optInColumns(posted, "job_application", now), none, String(posted));
  }
  // An admin's bulk upload can never consent for a candidate.
  assert.deepEqual(optInColumns("yes", "manual_upload", now), none);
});

test("the checkbox label is the decided wording, with no dash", () => {
  assert.equal(
    WHATSAPP_OPT_IN_LABEL,
    "Send me updates about this application on WhatsApp. Reply STOP at any time to stop.",
  );
  assert.doesNotMatch(WHATSAPP_OPT_IN_LABEL, /[‒-―]/);
});

// ── Automatic sends: the invitation and the reminder ────────

for (const event of ["interview", "interview_reminder"]) {
  for (const shape of REFUSED) {
    test(`automatic ${event}, ${shape}: nothing reaches Meta, a skipped row says why`, async () => {
      const world = attemptDb({ app: APPS[shape] });
      const r = await run(world, { event });
      assert.equal(r.threw, null, "a decision, not a failure: never retried");
      assert.equal(r.metaCalls.length, 0);
      assert.equal(world.db.logs.length, 1);
      const row = world.db.logs[0];
      assert.equal(row.channel, "whatsapp");
      assert.equal(row.event, event);
      assert.equal(row.status, "skipped");
      assert.equal(row.error, NO_OPT_IN_REASON);
      assert.equal(row.sent_by_name, null);
    });
  }

  // The positive control: the same world with a tick sends, so the refusals
  // above are the rule and not a broken fake.
  test(`automatic ${event}, opted in: sent`, async () => {
    const world = attemptDb({ app: APPS.optedIn });
    const r = await run(world, { event });
    assert.equal(r.threw, null);
    assert.equal(r.metaCalls.length, 1);
    assert.equal(world.db.logs[0].status, "sent");
  });

  test(`automatic ${event}, opted in but STOP received: STOP wins`, async () => {
    const world = attemptDb({ app: APPS.optedIn, optedOut: true });
    const r = await run(world, { event });
    assert.equal(r.metaCalls.length, 0);
    assert.equal(world.db.logs[0].status, "skipped");
    assert.equal(world.db.logs[0].error, OPTED_OUT_REASON);
  });
}

// ── A recruiter's send from the drawer ──────────────────────

for (const shape of REFUSED) {
  test(`recruiter's invite, ${shape}: not queued, a skipped row with the name and the reason`, async () => {
    const world = attemptDb({ app: APPS[shape] });
    const r = await queue(world);
    assert.deepEqual(r, { kind: "skipped", reason: NO_OPT_IN_REASON });
    assert.equal(world.service.rpcs.filter((c) => c.name === "queue_manual_whatsapp").length, 0);
    assert.equal(world.db.jobs.length, 0, "no job, so no worker can ever send it");
    assert.equal(world.db.logs.length, 1);
    assert.equal(world.db.logs[0].status, "skipped");
    assert.equal(world.db.logs[0].error, NO_OPT_IN_REASON);
    assert.equal(world.db.logs[0].sent_by_name, "Rae");
  });
}

test("recruiter's invite, opted in: queued (the control)", async () => {
  const world = attemptDb({ app: APPS.optedIn });
  const r = await queue(world);
  assert.equal(r.kind, "queued");
  assert.equal(world.db.jobs.length, 1);
});

test("recruiter's invite, opted in but STOP received: STOP wins", async () => {
  const world = attemptDb({ app: APPS.optedIn, optedOut: true });
  const r = await queue(world);
  assert.deepEqual(r, { kind: "skipped", reason: OPTED_OUT_REASON });
  assert.equal(world.db.jobs.length, 0);
});

test("a recruiter's row queued before this shipped, for a candidate who never ticked: skipped at the claim", async () => {
  const world = attemptDb({ app: APPS.existing, logs: [queuedRow()] });
  const r = await run(world, { event: "interview", sentByName: "Rae", logId: "log-q" });
  assert.equal(r.threw, null);
  assert.equal(r.metaCalls.length, 0);
  assert.equal(logById(world.db, "log-q").status, "skipped");
  assert.equal(logById(world.db, "log-q").error, NO_OPT_IN_REASON);
});

test("a recruiter's job from before 064 (no row id), never ticked: nothing sent", async () => {
  const world = attemptDb({ app: APPS.existing });
  const r = await run(world, { event: "interview", sentByName: "Rae" });
  assert.equal(r.metaCalls.length, 0);
  assert.equal(world.db.logs[0].status, "skipped");
  assert.equal(world.db.logs[0].error, NO_OPT_IN_REASON);
});

// ── The email never depends on WhatsApp ─────────────────────

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the email goes first and alone: the invitation and the reminder send it before WhatsApp is asked", () => {
  const invite = code(read("app/ai-dashboard/(gated)/applicants/interview-actions.ts"));
  const fn = invite.slice(invite.indexOf("export async function sendInterviewInvite("));
  const body = fn.slice(0, fn.indexOf("\nexport async function "));
  assert.ok(body.indexOf("deliverInvite(") > 0);
  assert.ok(body.indexOf("deliverInvite(") < body.indexOf("queueManualWhatsApp("));
  // The WhatsApp step sits in its own try, so no answer from it can undo the invitation.
  const tail = body.slice(body.lastIndexOf("try {", body.indexOf("queueManualWhatsApp(")));
  assert.ok(tail.indexOf("queueManualWhatsApp(") < tail.indexOf("} catch"));

  const reminder = code(read("lib/interviews/reminder.ts"));
  assert.ok(reminder.indexOf("deliverEmail(") > 0);
  assert.ok(reminder.indexOf("deliverEmail(") < reminder.indexOf('channel: "whatsapp"'));
});

test("no email path reads the WhatsApp opt-in", () => {
  const files = [
    "lib/interviews/invite-delivery.ts",
    "lib/interviews/reminder.ts",
    ...walk(join(SRC, "lib/email")).map((f) => relative(SRC, f)),
  ];
  assert.ok(files.length > 5, "not vacuous");
  for (const f of files) {
    assert.doesNotMatch(read(f), /whatsapp_opt_in|hasWhatsAppOptIn/, f);
  }
});

// ── Tripwire: no WhatsApp send outside the guard ────────────

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// Application code only, comments stripped: a mention in a comment is neither a
// send nor a caller, and test-support's fakes are not the application.
const SOURCES = walk(SRC)
  .map((p) => ({ rel: relative(SRC, p), text: code(readFileSync(p, "utf8")) }))
  .filter((f) => !f.rel.startsWith("test-support/"));

test("only send.ts talks to Meta, and only dispatch.ts calls it", () => {
  assert.ok(SOURCES.length > 300, `not vacuous: ${SOURCES.length} files`);
  const meta = SOURCES.filter((f) => f.text.includes("graph.facebook.com")).map((f) => f.rel);
  assert.deepEqual(meta, ["lib/whatsapp/send.ts"]);
  const callers = SOURCES.filter((f) => /\bsendTemplateMessage\b/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(callers.sort(), ["lib/whatsapp/dispatch.ts", "lib/whatsapp/send.ts"]);
  const queuers = SOURCES.filter((f) => f.text.includes("queue_manual_whatsapp")).map((f) => f.rel);
  assert.deepEqual(
    queuers.filter((f) => !f.startsWith("lib/supabase/migrations/")),
    ["lib/whatsapp/dispatch.ts"],
  );
});

/** Every function in dispatch.ts, with the calls it makes, in source order. */
function functionsOf(rel) {
  const text = read(rel);
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const fns = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const calls = [];
      const find = (n) => {
        if (ts.isCallExpression(n)) {
          const callee = n.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : null;
          const arg0 = n.arguments[0];
          calls.push({
            name,
            arg: arg0 && ts.isStringLiteral(arg0) ? arg0.text : null,
            at: n.getStart(),
          });
        }
        ts.forEachChild(n, find);
      };
      find(node.body);
      fns.push({ name: node.name.text, calls, body: node.body.getText() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fns;
}

const DISPATCH = functionsOf("lib/whatsapp/dispatch.ts");
const first = (fn, pred) => fn.calls.find(pred)?.at ?? -1;

test("every function in dispatch.ts that sends or queues WhatsApp asks sendTarget first", () => {
  const senders = DISPATCH.filter((fn) =>
    fn.calls.some(
      (c) =>
        c.name === "sendTemplateMessage" || (c.name === "rpc" && c.arg === "queue_manual_whatsapp"),
    ),
  );
  assert.deepEqual(senders.map((f) => f.name).sort(), [
    "handleWhatsAppMessage",
    "queueManualWhatsApp",
    "sendQueuedManual",
  ]);
  for (const fn of senders) {
    const guarded = first(fn, (c) => c.name === "sendTarget");
    assert.ok(guarded >= 0, `${fn.name} never asks sendTarget`);
    for (const send of fn.calls.filter(
      (c) =>
        c.name === "sendTemplateMessage" || (c.name === "rpc" && c.arg === "queue_manual_whatsapp"),
    )) {
      assert.ok(guarded < send.at, `${fn.name}: a send before the guard`);
    }
    // And the answer is obeyed: a refusal returns before anything is sent.
    assert.match(fn.body, /if \(!target\.send\) \{/, `${fn.name} ignores the guard's answer`);
  }
});

test("the guard asks consent before anything else, and STOP after it, never instead of it", () => {
  const target = DISPATCH.find((f) => f.name === "sendTarget");
  const consent = first(target, (c) => c.name === "hasWhatsAppOptIn");
  const stop = first(target, (c) => c.name === "isWhatsAppOptedOut");
  assert.ok(consent >= 0, "consent is not asked");
  assert.ok(stop > consent, "STOP must still be checked for a candidate who opted in");
  const body = target.body;
  assert.ok(body.indexOf("hasWhatsAppOptIn(") < body.indexOf("send: true"));
  assert.ok(body.indexOf("isWhatsAppOptedOut(") < body.indexOf("send: true"));
  // The only answer that sends is the last line; every earlier return refuses.
  assert.equal(body.match(/send: true/g)?.length, 1);
});

test("every application read the guard is handed carries the consent columns", () => {
  const text = code(read("lib/whatsapp/dispatch.ts"));
  const reads = [...text.matchAll(/\.from\("job_applications"\)\s*\.select\(\s*"([^"]+)"/g)];
  assert.equal(reads.length, 2, "handleWhatsAppMessage and queueManualWhatsApp");
  for (const [, cols] of reads) {
    assert.match(cols, /\bwhatsapp_opt_in\b/);
    assert.match(cols, /\bwhatsapp_opt_in_at\b/);
  }
});

test("WhatsApp jobs reach only the guarded handler", () => {
  const queue = code(read("lib/jobs-queue.ts"));
  assert.match(queue, /if \(channel === "whatsapp"\) \{\s*await handleWhatsAppMessage\(job\);/);
  const handlers = SOURCES.filter((f) => /\bhandleWhatsAppMessage\(/.test(f.text)).map(
    (f) => f.rel,
  );
  assert.deepEqual(handlers.sort(), ["lib/jobs-queue.ts", "lib/whatsapp/dispatch.ts"]);
});

// ── Tripwire: no click-to-chat link outside the gated one ───

const CHAT_LINK = /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//;

test("no wa.me or api.whatsapp.com link is built anywhere but chat-link.ts", () => {
  const builders = SOURCES.filter((f) => CHAT_LINK.test(f.text)).map((f) => f.rel);
  assert.deepEqual(builders, ["lib/whatsapp/chat-link.ts"]);
  // Only the admin action hands it out, and the drawer only opens what that action answers.
  const users = SOURCES.filter((f) => /from "@\/lib\/whatsapp\/chat-link"/.test(f.text)).map(
    (f) => f.rel,
  );
  assert.deepEqual(users, ["app/admin/applications/actions.ts"]);
  const drawer = read("app/admin/_components/applications-dashboard.tsx");
  assert.match(drawer, /requestWhatsAppLink\(getApplicationWhatsAppLink, app\.id, setWaLink\)/);
  assert.match(drawer, /window\.open\(waLink\.href,/);
  assert.doesNotMatch(drawer, /toWhatsAppDigits/);
});

test("the one link is built only after consent and STOP both said yes", () => {
  const fn = functionsOf("lib/whatsapp/chat-link.ts").find((f) => f.name === "whatsAppChatLink");
  const body = fn.body;
  const built = body.indexOf("https://wa.me/");
  assert.ok(built > 0);
  assert.equal(body.match(/https:\/\/wa\.me\//g)?.length, 1);
  const consent = body.indexOf("if (!hasWhatsAppOptIn(app)) return { ok: false");
  const stopped = body.indexOf('if (optOut.status === "opted_out") return { ok: false');
  const unknown = body.indexOf('if (optOut.status !== "clear") return { ok: false');
  assert.ok(consent >= 0, "the consent gate");
  assert.ok(stopped > consent, "the STOP gate, after consent");
  assert.ok(unknown > consent, "a failed STOP lookup refuses");
  assert.ok(built > stopped && built > unknown, "the link comes after every gate");
});

test("no network was reached", () => {
  guard.assertNoNetwork();
});
