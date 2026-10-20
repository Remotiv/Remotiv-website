/**
 * A PostgREST emulator faithful enough to judge an ORDER BY and a .range().
 *
 * ── Why the other fake is not enough ────────────────────────
 *
 * fake-postgrest.mjs records filters and lets the responder decide an answer.
 * That is the right tool for a head-count: the question is which filters were
 * sent, and a test reads them off `calls`.
 *
 * It cannot judge this pass. The claim of Applicants #3 is that the DATABASE
 * now ranks and pages the population, so the things that can be wrong are the
 * order terms, their sequence, their null placement, the tiebreaker, and the
 * offset arithmetic. Asserting that `.order()` was called with certain
 * arguments only restates the source. The only way to test it is to execute
 * it — so this module applies what the query asked for and returns the rows
 * that would come back.
 *
 * The emulator is therefore the DATABASE and the action under test is the
 * QUERY. If the action forgets `nullslast`, the rows arrive in the order
 * Postgres would really have produced, and the test fails on the rows.
 *
 * ── The one deliberate hostility ────────────────────────────
 *
 * Ties are reshuffled on EVERY request, seeded by a per-request counter.
 *
 * This is not noise for its own sake. Postgres makes no promise about the
 * relative order of rows that compare equal on every ORDER BY term, and two
 * requests for two adjacent pages are two separate sorts. Production was
 * measured doing exactly this: at window 1500-1549 two applicants came back
 * twice and two vanished, at 1 boundary in 5. A fake that sorted ties stably
 * would make the tiebreaker look optional and the completeness test would
 * pass with `id.asc` deleted — which is the single defect this suite exists to
 * catch. So equal rows are permuted, and only a unique final term can defeat
 * it.
 *
 * ── What is modelled, and why each one is load-bearing ──────
 *
 *   !left vs !inner      Across a LEFT embed a filter on an embedded column
 *                        does NOT restrict the parent — measured in
 *                        production, where the same two gates left the parent
 *                        at 3,789 rows across !left and cut it to 47 across
 *                        !inner. That asymmetry IS the tenancy trap, so the
 *                        emulator reproduces it rather than being lenient.
 *   order(`t(col)`)      The parenthesised column string orders the PARENT by
 *                        an embedded column. The `referencedTable` option
 *                        instead orders rows WITHIN the embed and leaves the
 *                        parent unordered — a silent no-op, measured as 200 OK
 *                        with ten unscored rows. Modelled as a no-op so the
 *                        trap is visible to a test.
 *   null placement       Postgres defaults: ASC is NULLS LAST, DESC is NULLS
 *                        FIRST. So a DESC score sort without `nullslast` puts
 *                        every unscored applicant first.
 *   range                An offset past the total is 416 / PGRST103; an offset
 *                        EQUAL to the total is a normal 206 with no rows.
 *   count/head           `head: true` returns no rows even on success, so the
 *                        count is the only thing a head request proves.
 *
 * Test-only. Nothing in the application imports this.
 */

/** Postgres' own default when a query does not say: ASC nulls last, DESC nulls first. */
function nullsFirstDefault(ascending) {
  return ascending === false;
}

/**
 * A deterministic permutation of equal-comparing rows, different each request.
 *
 * Deterministic so a failure reproduces; different per request so that two
 * pages of one population are two independent sorts, which is what Postgres
 * actually gives you and what the production defect was.
 */
function shuffleTies(rows, compare, seed) {
  const out = [...rows];
  // Group runs of rows that compare equal, then rotate each run by the seed.
  let i = 0;
  while (i < out.length) {
    let j = i + 1;
    while (j < out.length && compare(out[i], out[j]) === 0) j++;
    if (j - i > 1) {
      const run = out.slice(i, j);
      const by = seed % run.length;
      for (let k = 0; k < run.length; k++) out[i + k] = run[(k + by) % run.length];
    }
    i = j;
  }
  return out;
}

function compareValues(a, b, ascending, nullsFirst) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return nullsFirst ? -1 : 1;
  if (bNull) return nullsFirst ? 1 : -1;
  if (a === b) return 0;
  const dir = ascending === false ? -1 : 1;
  return (a < b ? -1 : 1) * dir;
}

/** `application_scores(effective_score)` -> {table, column}; a bare name -> parent column. */
function parseOrderColumn(column) {
  const m = /^([A-Za-z_][\w]*)\(([^)]+)\)$/.exec(column);
  if (m) return { table: m[1], column: m[2] };
  return { table: null, column };
}

/** One `col.ilike.%v%` / `col.eq.v` / `col.is.null` term from an `.or()` string. */
function matchOrTerm(row, term, embedOf) {
  const dot = term.indexOf(".");
  const col = term.slice(0, dot);
  const rest = term.slice(dot + 1);
  const opEnd = rest.indexOf(".");
  const op = rest.slice(0, opEnd);
  const raw = rest.slice(opEnd + 1);
  const value = columnOf(row, col, embedOf);

  if (op === "is") return raw === "null" ? value === null || value === undefined : false;
  if (op === "eq") return String(value) === raw;
  if (op === "ilike") {
    const needle = raw.replace(/^%|%$/g, "").toLowerCase();
    return typeof value === "string" && value.toLowerCase().includes(needle);
  }
  throw new Error(`fake-list-db: unsupported or() operator ${op}`);
}

/** Read a column, following `table.column` into the embedded row. */
function columnOf(row, col, embedOf) {
  const dot = col.indexOf(".");
  if (dot === -1) return row[col];
  const table = col.slice(0, dot);
  const field = col.slice(dot + 1);
  const child = embedOf(row, table);
  return child ? child[field] : null;
}

/**
 * Build a `respond` for fakeService over a fixed world.
 *
 * `world` is `{ apps, scores, jobs, team }`:
 *   apps   job_applications rows, with whatever columns a test needs
 *   scores application_scores rows, at most one per application_id
 *   jobs   jobs rows, for the display embed and the Open roles count
 *   team   job_hiring_team rows as `{ job_id }`, the recruiter's scope
 */
export function fakeListDb(world, options = {}) {
  const { apps = [], scores = [], jobs = [], team = [] } = world;
  const { failTable = null, scopeFails = false } = options;
  const scoreOf = (id) => scores.find((s) => s.application_id === id) ?? null;
  /** Bumped per job_applications request, so each sort permutes ties differently. */
  let requestSeq = 0;
  const embedOf = (row, table) => {
    if (table === "application_scores") return scoreOf(row.id);
    if (table === "jobs") return jobs.find((j) => j.id === row.job_id) ?? null;
    throw new Error(`fake-list-db: unknown embed ${table}`);
  };

  return function respond(table, calls) {
    if (table === "job_hiring_team") {
      if (scopeFails) return { data: null, error: { message: "boom", code: "57014" } };
      return { data: team.map((t) => ({ job_id: t.job_id })), error: null };
    }

    if (table === "jobs") {
      if (failTable === "jobs") return { data: null, count: null, error: fail() };
      return respondJobs(calls);
    }

    if (table !== "job_applications") {
      throw new Error(`fake-list-db: unexpected table ${table}`);
    }
    if (failTable === "job_applications") return { data: null, count: null, error: fail() };

    const seq = ++requestSeq;
    const selectCall = calls.find((c) => c[0] === "select");
    const select = selectCall?.[1] ?? "";
    const opts = selectCall?.[2] ?? {};

    /*
     * The embed's join type, read from the projection the action actually sent.
     * Absent entirely means no score embed at all, which is how negative
     * control (f) — dropping the ordered column — becomes visible: the order
     * term then names a column the response does not carry.
     */
    const embedMatch = /application_scores(!left|!inner)?\(([^)]*)\)/.exec(select);
    const joinType = embedMatch ? (embedMatch[1] ?? "!left").slice(1) : null;
    const embedFields = embedMatch ? embedMatch[2].split(",").map((f) => f.trim()) : [];

    let rows = apps.slice();

    // ── Parent filters ──────────────────────────────────────
    for (const [method, ...args] of calls) {
      if (method === "eq") {
        const [col, val] = args;
        if (col.includes(".")) {
          // An embed-keyed filter. Across !inner it restricts the parent;
          // across !left it does not restrict it AT ALL. Reproducing that is
          // the whole point — it is the trap the tenancy rule exists for.
          if (joinType === "inner") {
            rows = rows.filter((r) => String(columnOf(r, col, embedOf)) === String(val));
          }
        } else {
          rows = rows.filter((r) => r[col] === val);
        }
      } else if (method === "in") {
        const [col, list] = args;
        rows = rows.filter((r) => list.includes(r[col]));
      } else if (method === "not") {
        const [col, op, val] = args;
        if (op !== "is" || val !== null) {
          throw new Error(`fake-list-db: unsupported not(${op})`);
        }
        if (col.includes(".")) {
          if (joinType === "inner") {
            rows = rows.filter((r) => {
              const v = columnOf(r, col, embedOf);
              return v !== null && v !== undefined;
            });
          }
        } else {
          rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
        }
      } else if (method === "gte") {
        const [col, val] = args;
        rows = rows.filter((r) => r[col] !== null && r[col] >= val);
      } else if (method === "or") {
        /*
         * Each `.or()` is its own `or=` parameter and PostgREST ANDs them, so
         * the terms inside one call are ORed and separate calls are ANDed.
         * That is what makes a multi-word search AND its words — a single
         * `.or()` holding every word would OR them and widen the search to
         * anyone matching any one of them.
         */
        const terms = splitOrTerms(args[0]);
        rows = rows.filter((r) => terms.some((t) => matchOrTerm(r, t, embedOf)));
      }
    }

    // ── The join itself ─────────────────────────────────────
    // !inner drops parents with no child row. !left keeps them, which is why
    // the default view must stay !left: in production !inner returned 146 of
    // 3,788 rows, hiding 96.1% of applicants.
    if (joinType === "inner") rows = rows.filter((r) => scoreOf(r.id) !== null);

    // ── ORDER BY ────────────────────────────────────────────
    const orderTerms = [];
    for (const [method, ...args] of calls) {
      if (method !== "order") continue;
      const [column, opts2 = {}] = args;
      // `referencedTable` orders rows WITHIN the embed. For a to-one embed
      // that is a no-op, and the parent stays unordered. Silent in production.
      if (opts2.referencedTable) continue;
      const parsed = parseOrderColumn(column);
      // Ordering by an embedded column the embed did not select is 42703.
      if (parsed.table && !embedFields.includes(parsed.column)) {
        return {
          data: null,
          count: null,
          error: {
            code: "42703",
            message: `column ${parsed.table}.${parsed.column} does not exist`,
          },
        };
      }
      orderTerms.push({
        ...parsed,
        ascending: opts2.ascending !== false,
        nullsFirst:
          opts2.nullsFirst === undefined ? nullsFirstDefault(opts2.ascending) : opts2.nullsFirst,
      });
    }

    const compare = (a, b) => {
      for (const t of orderTerms) {
        const av = t.table ? (embedOf(a, t.table)?.[t.column] ?? null) : a[t.column];
        const bv = t.table ? (embedOf(b, t.table)?.[t.column] ?? null) : b[t.column];
        const c = compareValues(av, bv, t.ascending, t.nullsFirst);
        if (c !== 0) return c;
      }
      return 0;
    };

    if (orderTerms.length > 0) {
      rows.sort(compare);
      rows = shuffleTies(rows, compare, seq);
    } else {
      // No ORDER BY at all: the order is arbitrary and must not be relied on.
      rows = shuffleTies(rows, () => 0, seq);
    }

    const total = rows.length;

    // ── LIMIT / RANGE ───────────────────────────────────────
    const limitCall = calls.find((c) => c[0] === "limit");
    const rangeCall = calls.find((c) => c[0] === "range");

    if (rangeCall) {
      const [from, to] = [rangeCall[1], rangeCall[2]];
      // Measured boundary: offset == total is a normal empty 206; only an
      // offset strictly GREATER than the total is 416.
      if (from > total) {
        return {
          data: null,
          count: null,
          error: {
            code: "PGRST103",
            message: "Requested range not satisfiable",
          },
        };
      }
      rows = rows.slice(from, to + 1);
    } else if (limitCall) {
      rows = rows.slice(0, limitCall[1]);
    }

    const data = opts.head ? null : rows.map((r) => project(r, joinType, embedFields));
    return { data, count: opts.count === "exact" ? total : null, error: null };

    function project(row, join, fields) {
      const out = { ...row };
      delete out.__tie;
      if (join) {
        const child = scoreOf(row.id);
        out.application_scores = child
          ? Object.fromEntries(fields.filter((f) => f in child).map((f) => [f, child[f]]))
          : null;
      }
      if (/\bjobs\(/.test(select)) {
        const j = jobs.find((x) => x.id === row.job_id) ?? null;
        out.jobs = j ? { title: j.title } : null;
      }
      return out;
    }
  };

  function fail() {
    return { message: "boom", code: "57014" };
  }

  /** The Open roles count: jobs with at least one matching application, !inner. */
  function respondJobs(calls) {
    const eqs = Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
    const ids = calls.find((c) => c[0] === "in" && c[1] === "id")?.[2];
    const embedCompany = eqs["job_applications.company_id_snapshot"];
    const rows = jobs
      .filter((j) => !("company_id" in eqs) || j.company_id === eqs.company_id)
      .filter((j) => ids === undefined || ids.includes(j.id))
      .filter((j) => !("id" in eqs) || j.id === eqs.id)
      .filter((j) => !("deleted_at" in eqs) || j.deleted_at === eqs.deleted_at)
      .filter((j) =>
        apps.some(
          (a) =>
            a.job_id === j.id &&
            (embedCompany === undefined || a.company_id_snapshot === embedCompany),
        ),
      );
    return { data: null, count: rows.length, error: null };
  }
}

/** Split `a.ilike.%x%,b.eq.y` on top-level commas only. */
function splitOrTerms(expr) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out.map((t) => t.trim()).filter((t) => t.length > 0);
}
