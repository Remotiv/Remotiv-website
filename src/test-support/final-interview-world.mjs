/**
 * One company's hiring team, for the Final Human Interview tests, on
 * fake-postgrest. Filters are HONOURED where the rules depend on them:
 *
 *   eq(col, v)        exact match on any column, including company_id, status,
 *                     job_id, purpose, final_interview_id and application_id
 *   in(col, [...])    membership
 *   order(col, desc)  newest first when asked
 *   limit / maybeSingle / single
 *
 * Writes are recorded, and inserts into final_interviews and interview_bookings
 * hand back a fresh id, so an action can read what it just wrote. Every query
 * is still on `service.queries`, so a test can assert exactly what was asked.
 *
 * The team (company "co", job "job-1"):
 *   m-owner    owner, no name or email on the row (as owners really are),
 *              calendar connected, not on the team
 *   m-admin    admin, no calendar, not on the team
 *   m-host     recruiter, on the team, calendar connected
 *   m-team     recruiter, on the team, NO calendar
 *   m-hm       hiring manager, on the team, no calendar
 *   m-off      recruiter, NOT on the team, calendar connected
 *   m-gone     recruiter, status removed, on the team, calendar connected
 *   o-1        another company's member, on another company's team
 *
 * Test-only. Nothing in the application imports this.
 */
import { fakeService } from "./fake-postgrest.mjs";

export const CO = "co";
export const JOB = "job-1";
export const APP = "app-1";

export function makeDb() {
  return {
    companies: [{ id: CO, name: "Acme", contact_name: "Olive Owner" }],
    company_members: [
      {
        id: "m-owner",
        company_id: CO,
        role: "owner",
        status: "active",
        name: null,
        email: null,
        user_id: "u-owner",
      },
      {
        id: "m-admin",
        company_id: CO,
        role: "admin",
        status: "active",
        name: "Ada Admin",
        email: "ada@acme.test",
        user_id: "u-admin",
      },
      {
        id: "m-host",
        company_id: CO,
        role: "recruiter",
        status: "active",
        name: "Hana Host",
        email: "hana@acme.test",
        user_id: "u-host",
      },
      {
        id: "m-team",
        company_id: CO,
        role: "recruiter",
        status: "active",
        name: "Tom Team",
        email: "tom@acme.test",
        user_id: "u-team",
      },
      {
        id: "m-hm",
        company_id: CO,
        role: "hiring_manager",
        status: "active",
        name: "Hal Manager",
        email: "hal@acme.test",
        user_id: "u-hm",
      },
      {
        id: "m-off",
        company_id: CO,
        role: "recruiter",
        status: "active",
        name: "Oscar Off",
        email: "oscar@acme.test",
        user_id: "u-off",
      },
      {
        id: "m-gone",
        company_id: CO,
        role: "recruiter",
        status: "removed",
        name: "Gina Gone",
        email: "gina@acme.test",
        user_id: "u-gone",
      },
      {
        id: "o-1",
        company_id: "other",
        role: "owner",
        status: "active",
        name: "Other Owner",
        email: "o@other.test",
        user_id: "u-o",
      },
    ],
    job_hiring_team: [
      { id: "t1", company_id: CO, job_id: JOB, member_id: "m-host" },
      { id: "t2", company_id: CO, job_id: JOB, member_id: "m-team" },
      { id: "t3", company_id: CO, job_id: JOB, member_id: "m-hm" },
      { id: "t4", company_id: CO, job_id: JOB, member_id: "m-gone" },
      { id: "t5", company_id: "other", job_id: "job-o", member_id: "o-1" },
    ],
    calendar_connections: [
      {
        id: "c1",
        company_id: CO,
        member_id: "m-host",
        status: "active",
        provider: "google",
        calendar_id: "primary",
      },
      {
        id: "c2",
        company_id: CO,
        member_id: "m-owner",
        status: "active",
        provider: "google",
        calendar_id: "primary",
      },
      {
        id: "c3",
        company_id: CO,
        member_id: "m-off",
        status: "active",
        provider: "google",
        calendar_id: "primary",
      },
      {
        id: "c4",
        company_id: CO,
        member_id: "m-gone",
        status: "active",
        provider: "google",
        calendar_id: "primary",
      },
      {
        id: "c5",
        company_id: CO,
        member_id: "m-team",
        status: "revoked",
        provider: "google",
        calendar_id: "primary",
      },
    ],
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Sam",
        last_name: "Lee",
        email: "sam@example.test",
        jobs: { title: "Engineer" },
      },
    ],
    final_interviews: [],
    final_interview_interviewers: [],
    interview_bookings: [],
  };
}

let seq = 0;
const nextId = (prefix) => `${prefix}-${++seq}`;

function applyFilters(rows, calls) {
  let out = rows;
  for (const c of calls) {
    if (c[0] === "eq") out = out.filter((r) => r[c[1]] === c[2]);
    if (c[0] === "neq") out = out.filter((r) => r[c[1]] !== c[2]);
    if (c[0] === "in") out = out.filter((r) => c[2].includes(r[c[1]]));
    if (c[0] === "order") {
      const desc = c[2]?.ascending === false;
      out = [...out].sort((a, b) =>
        (a[c[1]] ?? "") < (b[c[1]] ?? "")
          ? desc
            ? 1
            : -1
          : (a[c[1]] ?? "") > (b[c[1]] ?? "")
            ? desc
              ? -1
              : 1
            : 0,
      );
    }
    if (c[0] === "limit") out = out.slice(0, c[1]);
  }
  return out;
}

/**
 * @param {ReturnType<typeof makeDb>} db  mutable: inserts and updates land in it
 * @param {{ failing?: string }} [opts]    a table whose every read errors
 */
export function finalInterviewWorld(db, { failing } = {}) {
  const service = fakeService((table, calls) => {
    if (table.startsWith("rpc:")) return { data: null, error: { message: `no rpc ${table}` } };
    if (table === failing) return { data: null, error: { message: "connection reset" } };
    const rows = db[table];
    if (!rows) throw new Error(`unexpected table ${table}`);
    const single = calls.some((c) => c[0] === "maybeSingle" || c[0] === "single");

    const insert = calls.find((c) => c[0] === "insert");
    if (insert) {
      const items = (Array.isArray(insert[1]) ? insert[1] : [insert[1]]).map((r) => ({
        id: r.id ?? nextId(table.slice(0, 4)),
        created_at: new Date(Date.now() + seq).toISOString(),
        ...r,
      }));
      rows.push(...items);
      return { data: single ? items[0] : items, error: null };
    }
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      const targets = applyFilters(
        rows,
        calls.filter((c) => c[0] !== "update"),
      );
      for (const t of targets) Object.assign(t, update[1]);
      return { data: single ? (targets[0] ?? null) : targets, error: null };
    }
    const del = calls.find((c) => c[0] === "delete");
    if (del) {
      const targets = applyFilters(
        rows,
        calls.filter((c) => c[0] !== "delete"),
      );
      for (const t of targets) rows.splice(rows.indexOf(t), 1);
      return { data: targets, error: null };
    }

    const found = applyFilters(rows, calls);
    return { data: single ? (found[0] ?? null) : found, error: null };
  });

  // resolveHostEmail reaches for auth.users when company_members has no address.
  service.auth = {
    admin: {
      getUserById: async (userId) => ({
        data: { user: { email: `${String(userId).replace(/^u-/, "")}@acme.test` } },
        error: null,
      }),
    },
  };
  return service;
}

/** Every write query (insert, update, delete) to one table, with its payload. */
export function writes(service, table) {
  return service.queries
    .filter((q) => q.table === table)
    .map((q) => q.calls.find((c) => ["insert", "update", "delete"].includes(c[0])))
    .filter(Boolean);
}
