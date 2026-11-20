/**
 * interview_sessions and jobs as PostgREST would answer the Interviews list's
 * reads (#41 part 2), for the tests that fake the database.
 *
 * The list used to read every session and filter, count and page in
 * JavaScript, so a fake could hand back all rows whatever was asked. It now
 * filters, counts and pages in SQL, so the fake has to APPLY what the code
 * sends, or a test would prove nothing about the query. This applies exactly
 * the operators the list and the review page use, with SQL's NULL semantics:
 *
 *   eq, neq, in, is null, not.is.null, not.in, gte, lt, or(... and(...)),
 *   order (several keys), range, limit, maybeSingle, count/head,
 *   the restart embed  first:interview_sessions!previous_attempt_id(...)
 *   and, on jobs, embedded counts  alias:interview_sessions(count)  with
 *   filters on `alias.column`.
 *
 * An operator it does not know throws, so a new filter cannot silently pass.
 *
 * Test-only. Nothing in the application imports this.
 */

const time = (v) => (v == null ? null : Date.parse(v));

function test1(row, col, op, val) {
  const v = row[col];
  switch (op) {
    case "eq":
      return v != null && String(v) === String(val);
    case "neq":
      return v != null && String(v) !== String(val);
    case "lt":
      return v != null && time(v) < time(val);
    case "lte":
      return v != null && time(v) <= time(val);
    case "gt":
      return v != null && time(v) > time(val);
    case "gte":
      return v != null && time(v) >= time(val);
    case "in":
      return v != null && (Array.isArray(val) ? val : listOf(val)).map(String).includes(String(v));
    case "is":
      return val === null || val === "null" ? v == null : v === val;
    default:
      throw new Error(`interview-list-fake: unsupported operator ${op} on ${col}`);
  }
}

const listOf = (s) =>
  String(s)
    .replace(/^\(|\)$/g, "")
    .split(",")
    .filter(Boolean);

/** Split on commas at depth 0. */
function topLevel(expr) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function orTerm(row, term) {
  const t = term.trim();
  if (t.startsWith("and(")) return topLevel(t.slice(4, -1)).every((x) => orTerm(row, x));
  if (t.startsWith("or(")) return topLevel(t.slice(3, -1)).some((x) => orTerm(row, x));
  const m = /^([a-z_]+)\.(not\.)?(eq|neq|lt|gte|in|is)\.(.*)$/.exec(t);
  if (!m) throw new Error(`interview-list-fake: unsupported or() term ${t}`);
  // not.in on a NULL is NULL in SQL: false either way round.
  if (m[2] && row[m[1]] == null) return false;
  const hit = test1(row, m[1], m[3], m[4]);
  return m[2] ? !hit : hit;
}

/** Does `row` pass every filter in `calls` (optionally only those on `prefix.`)? */
export function passes(row, calls, prefix = "") {
  for (const c of calls) {
    const [method, col] = c;
    if (["select", "order", "range", "limit", "maybeSingle", "single"].includes(method)) continue;
    if (method === "or") {
      // or(expr, { referencedTable }) applies to that embedded alias only.
      if ((c[2]?.referencedTable ?? "") !== prefix) continue;
      if (!topLevel(c[1]).some((t) => orTerm(row, t))) return false;
      continue;
    }
    if (typeof col !== "string") continue;
    const dot = col.indexOf(".");
    const own = dot === -1 ? "" : col.slice(0, dot);
    if (own !== prefix) continue;
    const name = dot === -1 ? col : col.slice(dot + 1);
    if (method === "not") {
      const [, , op, val] = c;
      if (op === "is") {
        if (row[name] == null) return false;
      } else if (op === "in") {
        if (row[name] == null || listOf(val).includes(String(row[name]))) return false;
      } else {
        throw new Error(`interview-list-fake: unsupported not.${op}`);
      }
      continue;
    }
    if (!test1(row, name, method, c[2])) return false;
  }
  return true;
}

function ordered(rows, calls) {
  const keys = calls.filter((c) => c[0] === "order");
  if (!keys.length) return rows;
  return [...rows].sort((a, b) => {
    for (const [, col, opts] of keys) {
      const asc = opts?.ascending !== false;
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      return (x < y ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });
}

/**
 * Answer one interview_sessions request over `sessions`. `maxRows` mimics
 * PostgREST's response cap. Out-of-range pages answer PGRST103, as PostgREST does.
 */
export function answerSessions(sessions, calls, { maxRows = 1000 } = {}) {
  const select = calls.find((c) => c[0] === "select");
  const opts = select?.[2] ?? {};
  let hit = ordered(
    sessions.filter((s) => passes(s, calls)),
    calls,
  );
  const total = hit.length;
  if (opts.head) return { data: null, count: total, error: null };
  const range = calls.find((c) => c[0] === "range");
  if (range) {
    const [, from, to] = range;
    if (from > total && total >= 0 && opts.count) {
      return {
        data: null,
        count: null,
        error: { code: "PGRST103", message: "Requested range not satisfiable" },
      };
    }
    hit = hit.slice(from, Math.min(to, from + maxRows - 1) + 1);
  }
  const limit = calls.find((c) => c[0] === "limit");
  if (limit) hit = hit.slice(0, limit[1]);
  if (String(select?.[1] ?? "").includes("first:interview_sessions!previous_attempt_id")) {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    hit = hit.map((s) => {
      const f = byId.get(s.previous_attempt_id);
      return { ...s, first: f ? { status: f.status, created_at: f.created_at } : null };
    });
  }
  if (calls.some((c) => c[0] === "maybeSingle")) return { data: hit[0] ?? null, error: null };
  return { data: hit, count: opts.count ? total : null, error: null };
}

/** Is this a jobs request with embedded session counts (the list's)? */
export function isJobsWithCounts(table, calls) {
  return (
    table === "jobs" &&
    String(calls.find((c) => c[0] === "select")?.[1] ?? "").includes("interview_sessions(count)")
  );
}

/** Answer the list's jobs request: each job with its embedded, filtered session counts. */
export function answerJobsWithCounts(jobs, sessions, calls) {
  const select = String(calls.find((c) => c[0] === "select")?.[1] ?? "");
  const aliases = [...select.matchAll(/(\w+):interview_sessions\(count\)/g)].map((m) => m[1]);
  const rows = jobs
    .filter((j) => passes(j, calls))
    .map((j) => {
      const out = { id: j.id, title: j.title ?? null };
      for (const alias of aliases) {
        const n = sessions.filter((s) => s.job_id === j.id && passes(s, calls, alias)).length;
        out[alias] = [{ count: n }];
      }
      return out;
    });
  return { data: rows, error: null };
}
