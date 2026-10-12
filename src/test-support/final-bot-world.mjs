/**
 * A database for the recording-bot tests, on fake-postgrest. It behaves like
 * migration 040 where the bot logic depends on it:
 *
 *   final_interview_bots   one live row per booking (superseded_at null) and
 *                          one row per provider_bot_id, each a 23505; the
 *                          tenant trigger (booking must belong to the row's
 *                          company and final interview), a 42501
 *   background_jobs        one queued-or-running final_bot_sync per booking
 *                          (action not 'delete') and one per providerBotId
 *                          (action 'delete'), each a 23505
 *
 * Filters honoured: eq (including payload->>key), neq, in, is, not(col, 'is',
 * null), lt, lte, gt, gte, order, limit, maybeSingle, single. Rows handed back
 * are copies, so code under test cannot change the database by accident.
 *
 * Fault injection: `world.failNext(table, op)` makes the next matching query
 * return an error; `world.hang(table)` makes every query to it never settle.
 *
 * Test-only. Nothing in the application imports this.
 */
import { randomUUID } from "node:crypto";
import { fakeService } from "./fake-postgrest.mjs";

export const CO = "c0000000-0000-4000-8000-000000000001";
export const OTHER_CO = "c0000000-0000-4000-8000-000000000002";
export const JOB = "e0000000-0000-4000-8000-000000000001";
export const APP = "a0000000-0000-4000-8000-000000000001";
export const FI = "f0000000-0000-4000-8000-000000000001";
export const BOOKING = "b0000000-0000-4000-8000-000000000001";
export const MEET = "https://meet.google.com/abc-defg-hij";
export const HOST = "d0000000-0000-4000-8000-000000000001";
export const OTHER_MEMBER = "d0000000-0000-4000-8000-000000000002";

/** A booked final round starting `startMs`, its active interview, nothing else. */
export function makeBotDb(startMs) {
  return {
    interview_bookings: [
      {
        id: BOOKING,
        company_id: CO,
        application_id: APP,
        job_id: JOB,
        status: "booked",
        purpose: "final",
        final_interview_id: FI,
        scheduled_start: new Date(startMs).toISOString(),
        meeting_url: MEET,
        host_member_id: HOST,
        booked_at: new Date(startMs - 3 * 86_400_000).toISOString(),
      },
    ],
    final_interviews: [
      {
        id: FI,
        company_id: CO,
        job_id: JOB,
        application_id: APP,
        status: "active",
        host_member_id: HOST,
        interview_type: "cto",
        custom_label: null,
      },
    ],
    final_interview_bots: [],
    background_jobs: [],
    company_members: [
      { id: HOST, company_id: CO, status: "active", email: "host@acme.test", user_id: "u-host" },
      {
        id: OTHER_MEMBER,
        company_id: CO,
        status: "active",
        email: "other@acme.test",
        user_id: "u-o",
      },
    ],
    job_applications: [{ id: APP, company_id_snapshot: CO, first_name: "Sam" }],
    notifications_company: [],
    auth_users: { "u-host": "host-signin@acme.test" },
  };
}

const FILTERS = new Set(["eq", "neq", "in", "is", "not", "or", "lt", "lte", "gt", "gte"]);

/** PostgREST list literal ("a","b") or (a,b) to values. */
const parseList = (text) =>
  text
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((v) => v.trim().replace(/^"|"$/g, ""));

/** One or-term, "col.op.value", as a filter call. Supports is.null, eq, lt, gt. */
function orTerm(term) {
  const first = term.indexOf(".");
  const second = term.indexOf(".", first + 1);
  const col = term.slice(0, first);
  const op = term.slice(first + 1, second);
  const raw = term.slice(second + 1).replace(/^"|"$/g, "");
  if (op === "is") return ["is", col, raw === "null" ? null : raw];
  if (["eq", "lt", "gt", "lte", "gte"].includes(op)) return [op, col, raw];
  throw new Error(`world: unsupported or-term ${term}`);
}

/** Split an or() string on top-level commas, keeping quoted values whole. */
function orTerms(text) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function get(row, col) {
  if (col.includes("->>")) {
    const [base, key] = col.split("->>");
    return row[base]?.[key];
  }
  return row[col];
}

function matches(row, call) {
  const [op, col, a, b] = call;
  const v = get(row, col);
  switch (op) {
    case "eq":
      return v === a;
    case "neq":
      return v !== a;
    case "in":
      return a.includes(v);
    case "is":
      return a === null ? v === null || v === undefined : v === a;
    case "not":
      if (a === "is" && b === null) return v !== null && v !== undefined;
      if (a === "in") return !parseList(b).includes(v);
      throw new Error(`world: unsupported not(${col}, ${a})`);
    case "or":
      return orTerms(col).some((term) => matches(row, orTerm(term)));
    case "lt":
      return v !== null && v !== undefined && v < a;
    case "lte":
      return v !== null && v !== undefined && v <= a;
    case "gt":
      return v !== null && v !== undefined && v > a;
    case "gte":
      return v !== null && v !== undefined && v >= a;
    default:
      return true;
  }
}

function select(rows, calls) {
  let out = rows.filter((r) => calls.every((c) => !FILTERS.has(c[0]) || matches(r, c)));
  for (const c of calls) {
    if (c[0] === "order") {
      const desc = c[2]?.ascending === false;
      out = [...out].sort((x, y) => {
        const a = x[c[1]] ?? "";
        const b2 = y[c[1]] ?? "";
        if (a === b2) return 0;
        return (a < b2 ? -1 : 1) * (desc ? -1 : 1);
      });
    }
  }
  const limit = calls.find((c) => c[0] === "limit");
  return limit ? out.slice(0, limit[1]) : out;
}

const clone = (v) => structuredClone(v);
const dup = (name) => ({
  code: "23505",
  message: `duplicate key value violates unique constraint "${name}"`,
});

function liveSyncKey(job) {
  if (job.type !== "final_bot_sync" || !["queued", "running"].includes(job.status)) return null;
  const p = job.payload ?? {};
  if (p.action === "delete") return p.providerBotId ? `del:${p.providerBotId}` : null;
  return p.bookingId ? `sync:${p.bookingId}` : null;
}

/** The constraint a row would break among `others`, or null. */
function violation(db, table, row, others) {
  // Every table here has a uuid primary key.
  if (row.id && others.some((o) => o.id === row.id)) return dup(`${table}_pkey`);
  if (table === "final_interview_bots") {
    if (
      row.superseded_at == null &&
      others.some((o) => o.booking_id === row.booking_id && o.superseded_at == null)
    ) {
      return dup("final_interview_bots_one_live_idx");
    }
    if (row.provider_bot_id && others.some((o) => o.provider_bot_id === row.provider_bot_id)) {
      return dup("final_interview_bots_provider_bot_idx");
    }
    const booking = db.interview_bookings.find((b) => b.id === row.booking_id);
    if (!booking) return { code: "23503", message: "booking does not exist" };
    if (
      booking.company_id !== row.company_id ||
      booking.final_interview_id !== row.final_interview_id
    ) {
      return { code: "42501", message: "final_interview_bots: booking does not belong" };
    }
  }
  if (table === "background_jobs") {
    const key = liveSyncKey(row);
    if (key && others.some((o) => liveSyncKey(o) === key))
      return dup("background_jobs_final_bot_live_uniq");
  }
  return null;
}

export function botWorld(db) {
  const failures = [];
  const hanging = new Set();

  const service = fakeService((table, calls) => {
    if (hanging.has(table)) return new Promise(() => {});
    const rows = db[table];
    if (!rows) throw new Error(`unexpected table ${table}`);
    const op = calls.find((c) => ["insert", "update", "delete"].includes(c[0]))?.[0] ?? "select";
    const failAt = failures.findIndex((f) => f.table === table && (f.op === op || f.op === "*"));
    const failure = failAt >= 0 ? failures.splice(failAt, 1)[0] : null;
    const injected = failure && { code: failure.code ?? "08006", message: "connection reset" };
    if (failure && !failure.applied) return { data: null, error: injected };
    // applied: the write lands, and the caller is told it failed anyway.
    const result = run(table, rows, calls, op);
    return failure ? { data: null, error: result.error ?? injected } : result;
  });

  function run(table, rows, calls, op) {
    const single = calls.some((c) => c[0] === "maybeSingle" || c[0] === "single");
    const now = new Date().toISOString();

    if (op === "insert") {
      const input = calls.find((c) => c[0] === "insert")[1];
      const items = (Array.isArray(input) ? input : [input]).map((r) => ({
        id: r.id ?? randomUUID(),
        created_at: now,
        updated_at: now,
        ...(table === "final_interview_bots"
          ? {
              provider_bot_id: null,
              provider_recording_id: null,
              last_event_code: null,
              last_event_sub_code: null,
              last_event_at: null,
              import_status: "none",
              superseded_at: null,
              lobby_alert_sent_at: null,
              failure_alert_sent_at: null,
            }
          : {}),
        ...r,
      }));
      for (const item of items) {
        const err = violation(db, table, item, rows);
        if (err) return { data: null, error: err };
      }
      rows.push(...items);
      return { data: single ? clone(items[0]) : clone(items), error: null };
    }

    const targets = select(rows, calls);
    if (op === "update") {
      const patch = calls.find((c) => c[0] === "update")[1];
      for (const t of targets) {
        const next = { ...t, ...patch };
        const err = violation(
          db,
          table,
          next,
          rows.filter((o) => o !== t),
        );
        if (err) return { data: null, error: err };
      }
      for (const t of targets) Object.assign(t, patch);
      return { data: single ? clone(targets[0] ?? null) : clone(targets), error: null };
    }
    if (op === "delete") {
      for (const t of targets) rows.splice(rows.indexOf(t), 1);
      return { data: clone(targets), error: null };
    }
    return { data: single ? clone(targets[0] ?? null) : clone(targets), error: null };
  }

  /** The next matching query errors; with { applied: true } its write still lands. */
  service.failNext = (table, op = "*", code, { applied = false } = {}) =>
    failures.push({ table, op, code, applied });
  service.auth = {
    admin: {
      getUserById: async (id) => ({
        data: { user: db.auth_users?.[id] ? { email: db.auth_users[id] } : null },
        error: null,
      }),
    },
  };
  service.hang = (table) => hanging.add(table);
  return service;
}

/** The real enqueue's shape, against the world's background_jobs. */
export function makeEnqueue(service, { fail } = {}) {
  return async (input) => {
    if (fail) return fail(input);
    const { data, error } = await service
      .from("background_jobs")
      .insert({
        type: input.type,
        payload: input.payload ?? {},
        company_id: input.companyId ?? null,
        status: "queued",
        attempts: 0,
        max_attempts: input.maxAttempts ?? 3,
        ...(input.id ? { id: input.id } : {}),
        ...(input.runAfter ? { run_after: input.runAfter.toISOString() } : {}),
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message, code: error.code };
    return { ok: true, id: data.id };
  };
}

/**
 * Drain queued final_bot_sync jobs through `process` the way the worker does:
 * leased while running (so the unique index sees it), succeeded or failed
 * after. Returns each run's job, result and error.
 */
export async function drain(db, process, { max = 10 } = {}) {
  const runs = [];
  for (let i = 0; i < max; i++) {
    const job = db.background_jobs.find(
      (j) => j.type === "final_bot_sync" && j.status === "queued",
    );
    if (!job) break;
    job.status = "running";
    try {
      const result = await process(job);
      job.status = "succeeded";
      runs.push({ job, result, error: null });
    } catch (error) {
      job.status = "failed";
      job.last_error = error?.message ?? String(error);
      runs.push({ job, result: null, error });
    }
  }
  return runs;
}
