/**
 * #16: the applicant delete's marker and its two database steps (migration
 * 071, lib/applicant-deletion.ts).
 *
 *   node --test src/lib/applicant-deletion.test.ts
 *
 * The helpers run as shipped against a fake PostgREST. 071 has not been run
 * on any database; its SQL is pinned here statement by statement (what each
 * function closes, refuses and deletes, on which company), and its behaviour
 * is exercised through the delete's own tests (delete-bells.test.ts), the
 * booking step's (delete-bookings.test.ts) and the senders' (resend-once,
 * dispatch-claim, dispatch-manual). Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));

const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const D = await import("./applicant-deletion.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-000000000001";

const SQL = readFileSync(
  new URL("./supabase/migrations/071_application_deletion.sql", import.meta.url),
  "utf8",
);
/** The SQL with comments removed, so a pin can never be met by prose. */
const CODE = SQL.replace(/--[^\n]*/g, "");
const fn = (name) => {
  const start = CODE.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} defined`);
  return CODE.slice(start, CODE.indexOf("$$;", start) + 3);
};
const GUARD = fn("application_deletion_guard");
const CLOSE = fn("close_application_for_deletion");
const FINISH = fn("finish_application_deletion");

/* ── the marker read, just before a provider call ─────────────── */

function markerWorld(answer) {
  const seen = [];
  const service = fakeService((table, calls) => {
    seen.push({ table, calls });
    return answer;
  });
  return { service, seen };
}

test("M1. the marker: clear, deleting, gone (deleting), unknown on a failed read; read on this company", async () => {
  const cases = [
    [{ data: { id: APP, deletion_started_at: null }, error: null }, "clear"],
    [{ data: { id: APP, deletion_started_at: "2026-11-20T10:00:00Z" }, error: null }, "deleting"],
    [{ data: null, error: null }, "deleting"],
    [{ data: null, error: { code: "57014" } }, "unknown"],
    // Before 071 the column does not exist: nothing can be marked.
    [{ data: null, error: { code: "42703" } }, "clear"],
  ];
  const real = console.error;
  console.error = () => {};
  try {
    for (const [answer, want] of cases) {
      const w = markerWorld(answer);
      assert.equal(
        await D.deletionStartedFor(w.service, { applicationId: APP, companyId: CO }),
        want,
      );
      const calls = w.seen[0].calls;
      assert.equal(w.seen[0].table, "job_applications");
      assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "id" && c[2] === APP));
      assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot" && c[2] === CO));
    }
  } finally {
    console.error = real;
  }
});

test("M2. the first calendar failure is recorded once, only on a marked row, and a repeat still reads as recorded", async () => {
  const writes = [];
  const service = fakeService((_table, calls) => {
    if (calls.some((c) => c[0] === "update")) {
      writes.push(calls);
      return { data: [{ id: APP }], error: null };
    }
    return { data: null, error: null };
  });
  assert.equal(await D.recordCalendarFailure(service, CO, APP), true);
  const w = writes[0];
  assert.ok(w.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot" && c[2] === CO));
  assert.ok(
    w.some((c) => c[0] === "not" && c[1] === "deletion_started_at"),
    "only once closed",
  );
  assert.ok(
    w.some((c) => c[0] === "is" && c[1] === "deletion_calendar_failed_at"),
    "only once",
  );
  // Already recorded by an earlier attempt: the update matches nothing, the read finds it.
  const again = fakeService((_table, calls) =>
    calls.some((c) => c[0] === "update")
      ? { data: [], error: null }
      : { data: { id: APP, deletion_calendar_failed_at: "2026-11-20T10:00:00Z" }, error: null },
  );
  assert.equal(await D.recordCalendarFailure(again, CO, APP), true);
  // The write fails: not recorded, so Delete anyway stays unavailable.
  const failing = fakeService(() => ({ data: null, error: { code: "57014" } }));
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal(await D.recordCalendarFailure(failing, CO, APP), false);
  } finally {
    console.error = real;
  }
});

test("M3. Close and Finish: their answers read strictly; anything else is an error, never a success", async () => {
  const rpc = (data, error = null) => {
    const s = fakeService(() => ({ data: null, error: null }));
    s.rpc = async () => ({ data, error });
    return s;
  };
  assert.deepEqual(
    await D.closeApplicationForDeletion(
      rpc({ outcome: "closed", first: true, session_ids: ["s1"], final_booking_ids: ["f1"] }),
      CO,
      APP,
    ),
    { outcome: "closed", first: true, sessionIds: ["s1"], finalBookingIds: ["f1"] },
  );
  assert.deepEqual(await D.closeApplicationForDeletion(rpc({ outcome: "not_found" }), CO, APP), {
    outcome: "not_found",
  });
  assert.equal(
    (await D.closeApplicationForDeletion(rpc({ outcome: "?" }), CO, APP)).outcome,
    "error",
  );
  assert.equal(
    (await D.closeApplicationForDeletion(rpc(null, { code: "RD071" }), CO, APP)).outcome,
    "error",
  );
  for (const outcome of ["deleted", "not_found", "not_closed"]) {
    assert.deepEqual(await D.finishApplicationDeletion(rpc({ outcome }), CO, APP, []), { outcome });
  }
  assert.equal((await D.finishApplicationDeletion(rpc({}), CO, APP, [])).outcome, "error");
});

/* ── 071, the guard ───────────────────────────────────────────── */

test("G1. the guard: on inserts of sessions, bookings and final interviews, and on messages becoming queued", () => {
  for (const table of ["interview_sessions", "interview_bookings", "final_interviews"]) {
    assert.match(
      CODE,
      new RegExp(
        `create trigger application_deletion_guard\\s+before insert on public\\.${table}\\s+for each row execute function public\\.application_deletion_guard\\(\\);`,
      ),
      table,
    );
  }
  assert.match(
    CODE,
    /create trigger application_deletion_guard\s+before insert or update on public\.communication_logs\s+for each row/,
  );
});

test("G2. the guard reads the applicant FOR SHARE (it waits for a Close in flight) and refuses with RD071", () => {
  assert.match(
    GUARD,
    /from public\.job_applications a\s+where a\.id = new\.application_id\s+for share;/,
  );
  assert.match(
    GUARD,
    /if marked is not null then\s+raise exception 'application_deletion_in_progress'\s+using errcode = 'RD071'/,
  );
  assert.match(GUARD, /set search_path = ''/);
  assert.equal(D.DELETION_IN_PROGRESS, "RD071");
});

test("G3. on messages, only a row BECOMING queued is checked: a claim, a re-claim (new stamp), a first attempt", () => {
  assert.match(GUARD, /if new\.status is distinct from 'queued' then\s+return new;/);
  assert.match(
    GUARD,
    /if tg_op = 'UPDATE'\s+and old\.status = 'queued'\s+and old\.attempt_started_at is not distinct from new\.attempt_started_at then\s+return new;/,
  );
});

/* ── 071, Close ───────────────────────────────────────────────── */

test("C1. Close locks the applicant on this company, marks it once, never clears it", () => {
  assert.match(
    CLOSE,
    /from public\.job_applications a\s+where a\.id = p_application_id\s+and a\.company_id_snapshot = p_company_id\s+for update;/,
  );
  assert.match(
    CLOSE,
    /set deletion_started_at = pg_catalog\.now\(\)[\s\S]*?and a\.deletion_started_at is null;/,
  );
  assert.doesNotMatch(CODE, /deletion_started_at = null/);
});

test("C2. Close closes every session of this applicant on this company: past retention, invited or started cancelled", () => {
  assert.match(
    CLOSE,
    /from public\.interview_sessions s\s+where s\.company_id = p_company_id\s+and s\.application_id = p_application_id;/,
  );
  assert.match(
    CLOSE,
    /set delete_after = pg_catalog\.now\(\)\s+where s\.company_id = p_company_id/,
  );
  assert.match(
    CLOSE,
    /set status = 'cancelled'\s+where s\.company_id = p_company_id\s+and s\.id = any \(sessions\)\s+and s\.status in \('invited', 'started'\);/,
  );
});

test("C3. Close fails the queued jobs: transcription and scorecards by session or answer, and this applicant's messages", () => {
  assert.match(
    CLOSE,
    /j\.type in \('transcribe', 'ai_scorecard'\)\s+and j\.payload->>'sessionId' = any \(sessions::text\[\]\)/,
  );
  assert.match(CLOSE, /j\.type = 'transcribe'\s+and j\.payload->>'answerId' in \(/);
  assert.match(
    CLOSE,
    /and j\.type in \('send_message', 'ai_cv_score'\)\s+and j\.payload->>'applicationId' = p_application_id::text;/,
  );
  assert.equal((CLOSE.match(/where j\.status = 'queued'/g) ?? []).length, 2, "only queued jobs");
});

test("C4. Close cancels every open booking of EVERY purpose, keeps its event id, and cancels active final interviews", () => {
  const cancel = CLOSE.slice(CLOSE.indexOf("update public.interview_bookings b"));
  const stmt = cancel.slice(0, cancel.indexOf(";") + 1);
  assert.match(
    stmt,
    /where b\.company_id = p_company_id\s+and b\.application_id = p_application_id/,
  );
  assert.match(
    stmt,
    /b\.status = 'invited'\s+or \(b\.status = 'booked' and b\.scheduled_start > pg_catalog\.now\(\)\)/,
  );
  assert.doesNotMatch(stmt, /purpose/, "every purpose: final rounds too");
  assert.doesNotMatch(stmt, /provider_event_id/, "the event id is kept for Google");
  assert.match(stmt, /cancelled_by = 'company'/);
  assert.match(
    CLOSE,
    /update public\.final_interviews f\s+set status = 'cancelled',\s+cancelled_at = pg_catalog\.now\(\)\s+where f\.company_id = p_company_id\s+and f\.application_id = p_application_id\s+and f\.status = 'active';/,
  );
});

/* ── 071, Finish ──────────────────────────────────────────────── */

test("F1. Finish refuses an applicant not found on this company or not closed, before deleting anything", () => {
  const firstDelete = FINISH.indexOf("delete from");
  const notFound = FINISH.search(
    /if not found then\s+return jsonb_build_object\('outcome', 'not_found'\);/,
  );
  const notClosed = FINISH.search(
    /if app\.deletion_started_at is null then\s+return jsonb_build_object\('outcome', 'not_closed'\);/,
  );
  assert.ok(notFound > 0 && notFound < firstDelete, "not found: refused first");
  assert.ok(notClosed > 0 && notClosed < firstDelete, "not closed: refused before any delete");
  assert.match(FINISH, /and a\.company_id_snapshot = p_company_id\s+for update;/);
});

test("F2. Finish: sessions, then bells, then the row, then the cleanups' activation, each on this company", () => {
  const at = (re) => FINISH.search(re);
  const sessions = at(
    /delete from public\.interview_sessions s\s+where s\.company_id = p_company_id\s+and s\.application_id = p_application_id;/,
  );
  const bells = at(
    /delete from public\.notifications_company n\s+where n\.company_id = p_company_id\s+and \(n\.application_id = p_application_id\s+or \(n\.application_id is null and n\.href = any \(coalesce\(p_hrefs, '\{\}'\)\)\)\);/,
  );
  const row = at(
    /delete from public\.job_applications a\s+where a\.id = p_application_id\s+and a\.company_id_snapshot = p_company_id;/,
  );
  const activate = at(
    /update public\.calendar_cleanups c\s+set status = 'open',\s+activated_at = pg_catalog\.now\(\)\s+where c\.company_id = p_company_id\s+and c\.status = 'pending'\s+and c\.pending_application_id is null;/,
  );
  assert.ok(
    sessions > 0 && bells > sessions && row > bells && activate > row,
    [sessions, bells, row, activate].join(","),
  );
});

/* ── 071, who may run it ──────────────────────────────────────── */

test("P1. Close and Finish: invoker rights, empty search_path, EXECUTE for service_role only", () => {
  for (const [name, sig, body] of [
    ["close_application_for_deletion", "uuid, uuid", CLOSE],
    ["finish_application_deletion", "uuid, uuid, text\\[\\]", FINISH],
  ]) {
    assert.match(body, /security invoker/, name);
    assert.doesNotMatch(body, /security definer/i, name);
    assert.match(body, /set search_path = ''/, name);
    assert.match(
      CODE,
      new RegExp(`revoke all on function public\\.${name}\\(${sig}\\) from public;`),
    );
    assert.match(
      CODE,
      new RegExp(`revoke all on function public\\.${name}\\(${sig}\\) from anon, authenticated;`),
    );
    const grants = [
      ...CODE.matchAll(
        new RegExp(`grant execute on function public\\.${name}\\(${sig}\\) to ([^;]+);`, "g"),
      ),
    ].map((m) => m[1]);
    assert.deepEqual(grants, ["service_role"], name);
  }
  // The guard runs as its owner (see its comment) and is executable by no one.
  assert.match(GUARD, /security definer/);
  assert.doesNotMatch(CODE, /grant execute on function public\.application_deletion_guard/);
  assert.match(
    CODE,
    /revoke all on function public\.application_deletion_guard\(\) from anon, authenticated;/,
  );
});

test("P2. 071 is one transaction, comes after 070 (it activates calendar_cleanups), and was never run", () => {
  assert.match(CODE, /^\s*begin;/m);
  assert.match(CODE, /commit;\s*$/);
  assert.match(SQL, /NOT RUN anywhere/);
  assert.match(SQL, /Apply AFTER 070/);
});

/* ── the SECURITY DEFINER guard, audited ──────────────────────── */

test("G4. the DEFINER guard: fixed empty search_path, every table schema-qualified, no dynamic SQL, no writes", () => {
  assert.match(GUARD, /security definer\s+set search_path = ''/);
  // Every relation it touches is named with its schema.
  const relations = [...GUARD.matchAll(/\b(?:from|join|update|into|table)\s+([a-z_][a-z_0-9.]*)/gi)]
    .map((m) => m[1])
    // `is not distinct from new.x` reads like a FROM; the row variables are not relations.
    .filter((r) => r !== "marked" && !/^(new|old)\./.test(r));
  assert.deepEqual(relations, ["public.job_applications"]);
  assert.doesNotMatch(GUARD, /\bexecute\b/i, "no dynamic SQL");
  assert.doesNotMatch(GUARD, /\b(insert|update|delete)\b\s+(into\s+)?public\./i, "reads only");
  assert.match(GUARD, /return new;\s*end;\s*\$\$;$/, "hands the row back unchanged");
  // The table check names the schema too, not the bare table name.
  assert.match(GUARD, /tg_table_schema = 'public' and tg_table_name = 'communication_logs'/);
});

test("G5. every table in 071 is schema-qualified, in every function and statement", () => {
  const refs = [
    ...CODE.matchAll(
      /\b(?:from|join|update|delete from|insert into|alter table|on|references)\s+(?!only\b)([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)/gi,
    ),
  ].map((m) => m[1]);
  const tables = refs.filter(
    (r) =>
      !/^(function|table|column|on|conflict|delete|update|insert|public|anon|authenticated|service_role|sessions|marked|app|new|old)$/i.test(
        r,
      ) &&
      !/^(a|b|c|f|j|n|s|l)$/.test(r) &&
      !/^(new|old)\./.test(r),
  );
  const bare = tables.filter((t) => !t.includes("."));
  assert.deepEqual(bare, [], `unqualified: ${bare.join(", ")}`);
  assert.ok(tables.length >= 15, `the scan found ${tables.length} table references`);
});

/* ── the actions' refusal ─────────────────────────────────────── */

test("R1. refuseIfBeingDeleted: marked refuses; clear, missing, unlinked and pre-071 go ahead; a failed read refuses", async () => {
  const run = async (answer, applicationId = APP) => {
    const seen = [];
    const service = fakeService((table, calls) => {
      seen.push({ table, calls });
      return answer;
    });
    const out = await D.refuseIfBeingDeleted(service, { applicationId, companyId: CO });
    return { out, seen };
  };
  const real = console.error;
  console.error = () => {};
  try {
    let r = await run({
      data: { id: APP, deletion_started_at: "2026-11-20T10:00:00Z" },
      error: null,
    });
    assert.equal(r.out, D.BEING_DELETED);
    assert.ok(
      r.seen[0].calls.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot" && c[2] === CO),
    );
    r = await run({ data: { id: APP, deletion_started_at: null }, error: null });
    assert.equal(r.out, null);
    // Not on this company: the action's own checks answer that, not this one.
    r = await run({ data: null, error: null });
    assert.equal(r.out, null);
    r = await run({ data: null, error: { code: "42703" } });
    assert.equal(r.out, null, "before 071 nothing can be marked");
    r = await run({ data: null, error: { code: "57014" } });
    assert.equal(r.out, D.DELETION_UNCHECKED);
    r = await run({ data: null, error: null }, null);
    assert.equal(r.out, null);
    assert.deepEqual(r.seen, [], "no application: nothing read");
  } finally {
    console.error = real;
  }
});

test("R2. the session variant reads the session's applicant on this company first", async () => {
  const reads = [];
  const service = fakeService((table, calls) => {
    reads.push({ table, calls });
    if (table === "interview_sessions") return { data: { application_id: APP }, error: null };
    return { data: { id: APP, deletion_started_at: "2026-11-20T10:00:00Z" }, error: null };
  });
  assert.equal(
    await D.refuseIfSessionApplicantBeingDeleted(service, { sessionId: "s-1", companyId: CO }),
    D.BEING_DELETED,
  );
  assert.ok(reads[0].calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === CO));
  const failing = fakeService(() => ({ data: null, error: { code: "57014" } }));
  assert.equal(
    await D.refuseIfSessionApplicantBeingDeleted(failing, { sessionId: "s-1", companyId: CO }),
    D.DELETION_UNCHECKED,
  );
  const unlinked = fakeService(() => ({ data: { application_id: null }, error: null }));
  assert.equal(
    await D.refuseIfSessionApplicantBeingDeleted(unlinked, { sessionId: "s-1", companyId: CO }),
    null,
  );
});

test("R3. the sentences have no dashes", () => {
  for (const s of [D.BEING_DELETED, D.DELETION_UNCHECKED, D.NOT_SENT_DELETING]) {
    assert.doesNotMatch(s, /[–—]|\s-\s/, s);
  }
});
