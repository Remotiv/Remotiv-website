/**
 * A stateful communication_logs for the #85 attempt tests: rows that change
 * as the code writes them, migration 059's three functions, and the filters
 * the guarded writes rely on, APPLIED rather than merely recorded.
 *
 * ── Stamps are strings, compared exactly ─────────────────────
 *
 * Every attempt_started_at here is a literal string with microseconds, made
 * by stamp(n), never by a Date. A filter `.eq("attempt_started_at", s)` and
 * the transition's p_observed_stamp match only when `s` is IDENTICAL to the
 * stored string. That is stricter than Postgres, which would also accept the
 * same instant written another way, and it is meant to be: the rule is that a
 * stamp is never reformatted at all. A stamp that went through a Date comes
 * back as ".123Z" and matches nothing here, exactly as it matches nothing in
 * production after losing its microseconds.
 *
 * ── The claim, without a clock ───────────────────────────────
 *
 * No ages are computed. A row says what the database would conclude about it:
 * `stale: true` (claimable), `old: true` (past 24 hours), `scheduled: true`.
 * A queued row with neither is too_fresh. Any function can be scripted
 * instead by passing `claim`, `transition` or `insert`.
 *
 * Test-only. Nothing in the application imports this.
 */
import { fakeService } from "./fake-postgrest.mjs";

/** A database-shaped stamp: microseconds, an explicit offset, never from a Date. */
export function stamp(n) {
  return `2026-11-16T10:00:${String(n).padStart(2, "0")}.123456+00:00`;
}

export const APP_ID = "a0000000-0000-4000-8000-0000000000a1";
export const COMPANY_ID = "c0000000-0000-4000-8000-0000000000c1";

export const DEFAULT_APP = {
  id: APP_ID,
  first_name: "Test",
  phone: "0300 1234567",
  job_id: "job-1",
  job_title_snapshot: "Engineer",
  company_id_snapshot: COMPANY_ID,
};

/** A filter call applied to one row. Unknown filters fail loudly. */
function passes(row, [op, col, a, b]) {
  if (op === "eq") return row[col] === a;
  if (op === "is") return a === null ? row[col] === null || row[col] === undefined : row[col] === a;
  if (op === "not" && a === "is" && b === null) {
    return row[col] !== null && row[col] !== undefined;
  }
  throw new Error(`fake-attempt-db: unsupported filter ${op}(${col})`);
}

const FILTERS = new Set(["eq", "is", "not"]);
const matching = (rows, calls) =>
  rows.filter((r) => calls.filter((c) => FILTERS.has(c[0])).every((c) => passes(r, c)));

const one = (row) => ({ data: [row], error: null, status: 200 });

/**
 * `logs`: the starting communication_logs rows. `app`: the application, or
 * null for one that does not exist. `beforeWrite(db, kind, patch)` runs before
 * every communication_logs update, so a test can land a stop or a deletion
 * between two of the code's own steps. `appRead`, when set, is how every
 * job_applications read answers: `{ error, status }` for a failed read.
 */
export function attemptDb({
  logs = [],
  app = DEFAULT_APP,
  claim = null,
  transition = null,
  insert = null,
  beforeWrite = null,
  optedOut = false,
  appRead = null,
} = {}) {
  const db = { logs: logs.map((r) => ({ ...r })), app, nextStamp: 50, nextId: 1 };
  const key = (r) => `${r.application_id}|${r.event}|${r.channel}`;
  const automaticClash = (row) =>
    row.sent_by_name == null &&
    db.logs.some((r) => r.sent_by_name == null && r.application_id !== null && key(r) === key(row));

  const service = fakeService((table, calls) => {
    const args = calls[0]?.[0] === "args" ? calls[0][1] : null;
    switch (table) {
      case "rpc:claim_communication_log": {
        if (claim) return claim(args, db);
        const target = db.logs.find(
          (r) =>
            r.application_id === args.p_application_id &&
            r.event === args.p_event &&
            r.channel === args.p_channel &&
            r.sent_by_name == null,
        );
        if (!target) {
          return one({ out_id: null, out_attempt_started_at: null, out_outcome: "missing" });
        }
        const answer = (outcome) =>
          one({
            out_id: target.id,
            out_attempt_started_at: target.attempt_started_at,
            out_outcome: outcome,
          });
        if (target.status !== args.p_from_status) return answer("wrong_status");
        if (target.scheduled) return answer("scheduled");
        if (target.status === "queued" && target.attempt_started_at === null) {
          return answer("unclocked");
        }
        if (target.old) return answer("too_old");
        if (!target.stale) return answer("too_fresh");
        target.attempt_started_at = stamp(db.nextStamp++);
        target.error = null;
        target.stale = false;
        return answer("claimed");
      }
      case "rpc:fail_observed_communication_log": {
        if (transition) return transition(args, db);
        const row = db.logs.find((r) => r.id === args.p_id);
        if (!["E1", "E5", "E9", "E10"].includes(args.p_rule)) {
          return one({ out_id: args.p_id, out_outcome: "bad_rule" });
        }
        if (!row) return one({ out_id: args.p_id, out_outcome: "missing" });
        if (row.status !== "queued" || row.attempt_started_at !== args.p_observed_stamp) {
          return one({ out_id: row.id, out_outcome: "changed" });
        }
        row.status = "failed";
        row.error = args.p_error;
        return one({ out_id: row.id, out_outcome: "failed" });
      }
      case "rpc:insert_first_attempt_communication_log": {
        if (insert) return insert(args, db);
        const row = {
          id: `log-${db.nextId++}`,
          company_id: args.p_company_id,
          application_id: args.p_application_id,
          event: args.p_event,
          channel: args.p_channel,
          to_address: args.p_to_address,
          subject: args.p_subject,
          body: args.p_body,
          status: "queued",
          error: null,
          sent_by_name: null,
          attempt_started_at: stamp(db.nextStamp++),
        };
        if (!db.app) {
          return {
            data: null,
            error: { code: "23503", message: "violates foreign key constraint" },
            status: 409,
          };
        }
        if (automaticClash(row)) {
          return {
            data: null,
            error: { code: "23505", message: "duplicate key value" },
            status: 409,
          };
        }
        db.logs.push(row);
        return one({ out_id: row.id, out_attempt_started_at: row.attempt_started_at });
      }
      case "communication_logs": {
        const ins = calls.find((c) => c[0] === "insert");
        if (ins) {
          const row = { id: `log-${db.nextId++}`, attempt_started_at: null, ...ins[1] };
          if (!db.app) {
            return {
              data: null,
              error: { code: "23503", message: "violates foreign key constraint" },
              status: 409,
            };
          }
          if (automaticClash(row)) {
            return { data: null, error: { code: "23505", message: "duplicate key" }, status: 409 };
          }
          db.logs.push(row);
          return { data: { id: row.id }, error: null, status: 201 };
        }
        const upd = calls.find((c) => c[0] === "update");
        if (upd) {
          beforeWrite?.(db, upd[1]);
          const hit = matching(db.logs, calls);
          for (const r of hit) Object.assign(r, upd[1]);
          const selected = calls.some((c) => c[0] === "select");
          return {
            data: selected ? hit.map((r) => ({ id: r.id })) : null,
            error: null,
            status: 200,
          };
        }
        const rows = matching(db.logs, calls);
        if (rows.length > 1) {
          return { data: null, error: { code: "PGRST116", message: "multiple rows" }, status: 406 };
        }
        const row = rows[0];
        return { data: row ? { id: row.id, status: row.status } : null, error: null, status: 200 };
      }
      case "job_applications": {
        if (appRead) return { data: null, error: appRead.error, status: appRead.status };
        const live = db.app && matching([db.app], calls).length === 1 ? db.app : null;
        return { data: live, error: null, status: 200 };
      }
      case "companies":
        return { data: { name: "Acme" }, error: null, status: 200 };
      case "jobs":
        return { data: { title: "Engineer" }, error: null, status: 200 };
      case "whatsapp_opt_outs": {
        const rows = optedOut ? [{ phone: "923001234567", bsuid: null }] : [];
        const single = calls.some((c) => c[0] === "maybeSingle");
        return { data: single ? (rows[0] ?? null) : rows, error: null, status: 200 };
      }
      case "whatsapp_inbound":
      case "company_members":
      case "job_hiring_team":
        return { data: [], error: null, status: 200 };
      case "notifications_company":
        return { data: null, error: null, status: 201 };
      default:
        throw new Error(`fake-attempt-db: unexpected table ${table}`);
    }
  });
  return { service, db };
}

/** The row the code is working on, by id. */
export const logById = (db, id) => db.logs.find((r) => r.id === id);
