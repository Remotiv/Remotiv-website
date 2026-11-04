/**
 * No database text reaches a user from the AI Video Interview send, and none
 * reaches a log (Fix 1). A refused or failed session insert answers with the
 * app's own words: migration 055's restart guard, matched by its full message
 * and never by SQLSTATE 23514 alone, is the neutral C6a refusal (live_restarted,
 * "A restart decision was made..."); anything else, and any failed async
 * insert, is "Couldn't send - please try again.". The server logs one
 * line: a fixed label and the error's code, never its message, details, hint
 * or stack, never the application.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/live-send-db-errors.test.ts"
 *
 * sendLiveInterviewInvite is the shipped code; the company context, email and
 * queue are interview-invite-test-hook.mjs's fakes; the database is
 * fake-live-db.mjs, with this file's own error injected into the session
 * insert. The last test reads the four files of the send, restart and delete
 * paths with TypeScript's parser. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(new URL("../../../../test-support/interview-invite-test-hook.mjs", import.meta.url));

const { sendInterviewInvite, sendLiveInterviewInvite } = await import("./interview-actions.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");
const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");

const CO = "c0000000-0000-4000-8000-0000000000f1";
const APP = "a0000000-0000-4000-8000-0000000000f1";
const JOB = "b0000000-0000-4000-8000-0000000000f1";
const EMAIL = "candidate.f1@example.test";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// The guard covers a restart and a decision alike, so the neutral C6a wording.
const DECIDED = {
  success: false,
  error: "A restart decision was made for this interview - manage it from the interview page.",
  code: "live_restarted",
};
const SEND_FAILED = { success: false, error: "Couldn't send - please try again." };

/** Migration 055's raise, as the database words it for this application. */
const GUARD = (applicationId = APP) => ({
  code: "23514",
  message: `interview_sessions: application ${applicationId} has a restarted or decided AI Video Interview; it is managed from its interview page, not sent again`,
  details: null,
  hint: null,
});

const RAW_PAYLOAD = {
  message: "RAW-SQL-MESSAGE null value in column violates not-null constraint",
  details: `RAW-SQL-DETAILS Failing row contains (${APP}, ${EMAIL}).`,
  hint: "RAW-SQL-HINT",
};

function world() {
  const w = fakeLiveDb({
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Test",
        last_name: "Candidate",
        email: EMAIL,
        job_id: JOB,
        job_title_snapshot: "Test role",
      },
    ],
    jobs: [{ id: JOB, company_id: CO, title: "Test role", avatar_interview_enabled: true }],
    interview_questions: [
      {
        id: "q1",
        job_id: JOB,
        company_id: CO,
        position: 1,
        question: "Describe a project you worked on.",
        prep_seconds: 30,
        answer_seconds: 120,
        required: true,
      },
    ],
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: null }],
  });
  w.emails = [];
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails.push(input.event);
    return { ok: true, logId: "log-1", providerId: "re_1" };
  };
  globalThis.__inviteEnqueueForTests = () => ({ ok: true });
  globalThis.__inviteLiveGateForTests = { ok: true, settings: { interviewer_name: "Ava" } };
  return w;
}

/**
 * The session insert answers `{ data: null, error }`, as supabase-js reports a
 * refused write; every other query runs on the fake database as usual.
 */
function failSessionInsert(w, error) {
  const from = w.service.from.bind(w.service);
  w.service.from = (table) => {
    const query = from(table);
    if (table !== "interview_sessions") return query;
    const { calls } = w.service.queries.at(-1);
    const wrapped = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve, reject) =>
              (calls.some((c) => c[0] === "insert")
                ? Promise.resolve({ data: null, error })
                : query
              ).then(resolve, reject);
          }
          return (...args) => {
            query[prop](...args);
            return wrapped;
          };
        },
      },
    );
    return wrapped;
  };
}

/** The action's answer and every log line it wrote. */
async function send() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log =
    console.warn =
    console.error =
      (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    return { result: await sendLiveInterviewInvite(APP), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** Nothing the database said, and nothing about the candidate, in the answer or the logs. */
function assertClean({ result, lines }, raw, name) {
  const answer = JSON.stringify(result);
  const logs = lines.join("\n");
  for (const [where, text] of [
    ["answer", answer],
    ["logs", logs],
  ]) {
    assert.doesNotMatch(text, UUID, `${name}: no id in the ${where}`);
    assert.ok(!text.includes("interview_sessions:"), `${name}: no trigger text in the ${where}`);
    assert.ok(!text.includes(EMAIL), `${name}: no candidate email in the ${where}`);
    for (const piece of [raw.message, raw.details, raw.hint].filter(Boolean)) {
      assert.ok(!text.includes(piece), `${name}: no database text in the ${where}`);
    }
  }
}

test("a: the 055 restart guard on a live send is the neutral C6a refusal; nothing of the database's text", async () => {
  const w = world();
  failSessionInsert(w, GUARD());
  const out = await send();
  assert.deepEqual(out.result, DECIDED);
  assertClean(out, GUARD(), "guard");
  assert.deepEqual(
    out.lines.filter((l) => l.startsWith("[interview] live send")),
    ["[interview] live send: refused by the restart guard (23514)"],
  );
  assert.deepEqual(w.emails, [], "no email");
  // Any application's id: the same guard.
  const other = world();
  failSessionInsert(other, GUARD("ffffffff-0000-4000-8000-00000000abcd"));
  assert.deepEqual((await send()).result, DECIDED);
});

test("b: any other refused or failed insert is 'Couldn't send', whatever the database said", async () => {
  const cases = [
    [
      "an unrelated check violation (23514)",
      {
        code: "23514",
        message:
          'new row for relation "interview_sessions" violates check constraint "interview_sessions_status_check"',
        details: `Failing row contains (${APP}, ${EMAIL}, invited).`,
        hint: null,
      },
    ],
    [
      "the guard's words with something after them",
      { ...GUARD(), message: `${GUARD().message} (retry)` },
    ],
    [
      "the guard's words with something before them",
      { ...GUARD(), message: `ERROR: ${GUARD().message}` },
    ],
    ["the guard's words under another SQLSTATE", { ...GUARD(), code: "23505" }],
    [
      "053's attempt rules",
      {
        code: "23514",
        message: `interview_sessions: session ${APP} is abandoned and cannot change status (to invited)`,
        details: null,
        hint: null,
      },
    ],
    [
      "raw details and hint",
      {
        code: "XX000",
        message: "RAW-SQL-MESSAGE internal error",
        details: `RAW-SQL-DETAILS Key (application_id)=(${APP}) is still referenced`,
        hint: "RAW-SQL-HINT check the trigger interview_sessions_no_first_attempt_after_restart",
      },
    ],
    [
      "a PostgREST error",
      {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: "The result contains 0 rows",
        hint: null,
      },
    ],
    [
      "a code that is not a code",
      { code: `23514'; ${EMAIL}`, message: "RAW-SQL-MESSAGE", details: null, hint: null },
    ],
    ["no error and no row", null],
  ];
  for (const [name, error] of cases) {
    const w = world();
    failSessionInsert(w, error);
    const out = await send();
    assert.deepEqual(out.result, SEND_FAILED, name);
    assertClean(out, error ?? {}, name);
    const logged = out.lines.filter((l) => l.startsWith("[interview] live send"));
    assert.equal(logged.length, 1, `${name}: one line`);
    assert.match(
      logged[0],
      /^\[interview\] live send: session insert failed \(([0-9A-Z]{5}|PGRST\d{3}|unknown)\)$/,
      `${name}: a fixed label and a code`,
    );
    assert.deepEqual(w.emails, [], `${name}: no email`);
  }
});

test("c: a live send that succeeds is unchanged", async () => {
  const w = world();
  const { result } = await send();
  assert.equal(result.success, true);
  assert.deepEqual(Object.keys(result.data), ["expiresAt"]);
  assert.deepEqual(w.emails, ["interview"]);
  const [row] = w.tables.interview_sessions;
  assert.deepEqual([row.kind, row.attempt, row.status], ["live", 1, "invited"]);
});

// ── async: the same rule for the async send's insert ────────

/** One async send whose session insert answers `error`; its answer, logs and timeline. */
async function sendAsync(error) {
  const timeline = [];
  const ok = (data) => ({ data, error: null });
  const service = fakeService((table, calls) => {
    const verb =
      ["insert", "update", "upsert", "delete"].find((v) => calls.some((c) => c[0] === v)) ??
      "select";
    timeline.push(table.startsWith("rpc:") ? table : `${table}:${verb}`);
    switch (table) {
      case "rpc:consume_allowance":
        return ok([{ allowed: true, usage_id: "use-1" }]);
      case "rpc:release_allowance":
        return ok(true);
      case "job_applications":
        return ok({
          id: APP,
          first_name: "Test",
          last_name: "Candidate",
          email: EMAIL,
          job_id: JOB,
          job_title_snapshot: "Test role",
          jobs: { title: "Test role" },
        });
      case "jobs":
        return ok({ allow_rerecord: true, async_interview_enabled: true });
      case "interview_questions":
        return ok([
          {
            id: "q1",
            position: 1,
            question: "Tell us about a project.",
            prep_seconds: 30,
            answer_seconds: 120,
            required: true,
          },
        ]);
      case "interview_sessions":
        if (verb === "insert") {
          return error ? { data: null, error } : ok({ id: call(calls, "insert")[1].id });
        }
        return ok([]);
      case "companies":
        return ok({ name: "Test Co", candidate_reply_email: null });
      default:
        return ok(null);
    }
  });
  globalThis.__inviteServiceForTests = () => service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = () => {
    timeline.push("email");
    return { ok: true, logId: "log-1", providerId: "re_1" };
  };
  globalThis.__inviteEnqueueForTests = () => ({ ok: true });
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log =
    console.warn =
    console.error =
      (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    return { result: await sendInterviewInvite(APP), lines, timeline };
  } finally {
    Object.assign(console, saved);
  }
}

test("async: a failed session insert is 'Couldn't send', the credit goes back, nothing of the database's text", async () => {
  for (const [name, error] of [
    ["raw message, details and hint", { code: "23502", ...RAW_PAYLOAD }],
    ["the 055 guard's words", GUARD()],
    [
      "a PostgREST error",
      { code: "PGRST204", message: "RAW-SQL-MESSAGE column", details: null, hint: null },
    ],
  ]) {
    const out = await sendAsync(error);
    assert.deepEqual(out.result, SEND_FAILED, name);
    assertClean(out, error, name);
    assert.deepEqual(
      out.lines.filter((l) => l.startsWith("[interview] async send")),
      [`[interview] async send: session insert failed (${error.code})`],
      name,
    );
    assert.ok(!out.timeline.includes("email"), `${name}: no email`);
    assert.ok(
      out.timeline.indexOf("rpc:release_allowance") >
        out.timeline.indexOf("interview_sessions:insert"),
      `${name}: the credit given back after the failed insert`,
    );
  }
  const sent = await sendAsync(null);
  assert.equal(sent.result.success, true, "an async send that succeeds is unchanged");
  assert.ok(sent.timeline.includes("email"));
  assert.ok(!sent.timeline.includes("rpc:release_allowance"));
});

// ── d: the source cannot pass database text through ─────────

/** Every node of a source file, with TypeScript's own parser. */
async function nodesOf(path, functions) {
  const ts = (await import("typescript")).default;
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  const file = ts.createSourceFile(
    path,
    src,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const roots = [];
  const find = (node) => {
    if (
      functions &&
      ts.isFunctionDeclaration(node) &&
      node.name &&
      functions.includes(node.name.text)
    ) {
      roots.push(node);
    }
    ts.forEachChild(node, find);
  };
  if (functions) find(file);
  else roots.push(file);
  if (functions) assert.equal(roots.length, functions.length, `${path}: ${functions.join(", ")}`);
  const out = [];
  const walk = (node) => {
    out.push(node);
    ts.forEachChild(node, walk);
  };
  for (const root of roots) walk(root);
  return { ts, file, nodes: out };
}

// [file, functions (null: the whole file), whether its log calls are checked too].
// The async send's own logs are not: its WhatsApp enqueue still logs the raw
// queue error (listed, not part of this fix).
const SCOPE = [
  [
    "./interview-actions.ts",
    ["sendLiveInterviewInvite", "supersedeOpenSession", "liveRestartOf"],
    true,
  ],
  ["./interview-actions.ts", ["sendInterviewInvite"], false],
  ["../interviews/actions.ts", ["deleteInterview", "restartChain", "deleteRestartChain"], true],
  ["../interviews/live-actions.ts", null, true],
  ["../../../../lib/interviews/live-restart-flow.ts", null, true],
];
const ERROR_NAME = /^(e|err|error|[a-z]+Err|[a-z]+Error)$/;

test("d: no audited path reads a database error's message, details, hint or stack, or logs the error itself", async () => {
  let checked = 0;
  for (const [path, functions, logs] of SCOPE) {
    const { ts, file, nodes } = await nodesOf(path, functions);
    const at = (n) => `${path}:${file.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    for (const n of nodes) {
      checked += 1;
      if (
        ts.isPropertyAccessExpression(n) &&
        ["message", "details", "hint", "stack"].includes(n.name.text)
      ) {
        assert.fail(`${at(n)}: reads .${n.name.text} (${n.getText()})`);
      }
      const isConsole =
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.expression.getText() === "console";
      if (logs && isConsole) {
        for (const arg of n.arguments) {
          if (ts.isIdentifier(arg) && ERROR_NAME.test(arg.text)) {
            assert.fail(`${at(n)}: logs the error object ${arg.text}`);
          }
        }
      }
    }
  }
  assert.ok(checked > 1000, `nodes checked: ${checked}`);
});

// ── e: the guard's signature is 055's own words, and only 055's guard has them ──

/** Every `raise exception '...'` format in a migration, as written. */
function raisesOf(name) {
  const sql = readFileSync(
    new URL(`../../../../lib/supabase/migrations/${name}`, import.meta.url),
    "utf8",
  );
  return [...sql.matchAll(/raise exception '((?:[^']|'')*)'/g)].map((m) =>
    m[1].replaceAll("''", "'"),
  );
}

test("e: the restart guard is matched by 055's exact message; no other 053 or 055 refusal matches", async () => {
  const guard = raisesOf("055_live_restart_link_events.sql").filter((f) =>
    f.includes("has a restarted or decided AI Video Interview"),
  );
  assert.equal(guard.length, 1, "one guard raise in 055");
  assert.equal(guard[0].replace("%", APP), GUARD().message, "the test's message is 055's");

  const others = [
    ...raisesOf("053_live_restart_decision.sql"),
    ...raisesOf("055_live_restart_link_events.sql"),
  ].filter((f) => f !== guard[0]);
  assert.ok(others.length > 30, `other raises: ${others.length}`);
  for (const format of others) {
    const w = world();
    const message = format.replaceAll("%", APP);
    failSessionInsert(w, { code: "23514", message, details: null, hint: null });
    const out = await send();
    assert.deepEqual(out.result, SEND_FAILED, format);
    assertClean(out, { message }, format);
  }
});
