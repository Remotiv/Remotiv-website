/**
 * A fake PostgREST table for paging tests. TEST SUPPORT ONLY.
 *
 * Not src/test-support/fake-postgrest.mjs, which RECORDS calls and lets a
 * responder answer them: this one EVALUATES the query against rows, because
 * the paging tests are about which rows come back when the table moves
 * between two pages. Just enough of supabase-js's builder to drive `pageAll`,
 * `pageAllByKey`, rescoreJob's two collection reads and the cv-purge loop:
 * `from`, `select` (with real column projection), `eq`, `gt`, `gte`, `lt`,
 * `lte`, `is`, `not(col, "is", v)`, `in`, `or` (PostgREST's expression syntax,
 * nested `and(...)`/`or(...)` included), several `order` keys in sequence,
 * `range`, `limit`, `update(values)`, `delete()`, and a thenable that resolves
 * `{ data, error, count }` as PostgREST does.
 *
 * ── What it models on purpose ────────────────────────────────
 *
 * A query with no `.order()` returns rows in ARRAY order, which stands in for
 * Postgres's heap order: undefined, usually stable, and moved by writes.
 * `touch(id)` moves a row to the end of the array, which is what a non-HOT
 * UPDATE does to a tuple's position; so does every `.update()` the code under
 * test issues, deliberately, because the question these tests ask is whether a
 * loop survives its own writes moving rows. `insert` appends; `remove`
 * splices. The `between` hook runs after every resolved query, so a test can
 * mutate the table between two pages exactly where a concurrent writer would.
 *
 * The sort is JavaScript's, which is stable: rows tied on every key keep
 * ARRAY order, as Postgres keeps an undefined one. A test that relies on ties
 * staying put is relying on something production does not promise.
 *
 * Plain fields throughout: Node's type stripping cannot run a constructor
 * parameter property.
 */

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Answer = { data: Row[] | null; error: { message: string } | null; count: number | null };

export class FakeTable {
  rows: Row[];
  queries = 0;
  /** Called after each resolved query with its ordinal (1-based) and the rows it returned. */
  between: ((queryNo: number, returned: Row[]) => void | Promise<void>) | null = null;

  constructor(rows: Row[]) {
    this.rows = rows.map((r) => ({ ...r }));
  }
  touch(id: string): void {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`touch: no row ${id}`);
    const [row] = this.rows.splice(i, 1);
    this.rows.push(row);
  }
  insert(row: Row): void {
    this.rows.push({ ...row });
  }
  remove(id: string): void {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`remove: no row ${id}`);
    this.rows.splice(i, 1);
  }
}

const cmp = (a: unknown, b: unknown): number => {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

function operator(op: string, value: unknown): (actual: unknown) => boolean {
  switch (op) {
    case "eq":
      return (a) => (value === null ? a === null : String(a) === String(value));
    case "neq":
      return (a) => String(a) !== String(value);
    case "gt":
      return (a) => a !== null && cmp(a, value) > 0;
    case "gte":
      return (a) => a !== null && cmp(a, value) >= 0;
    case "lt":
      return (a) => a !== null && cmp(a, value) < 0;
    case "lte":
      return (a) => a !== null && cmp(a, value) <= 0;
    case "is":
      return (a) => (value === null ? a === null : a === value);
    case "not.is":
      return (a) => (value === null ? a !== null : a !== value);
    default:
      throw new Error(`fake table: operator ${op} is not modelled`);
  }
}

/** Split on top-level commas only, so `and(a,b)` stays one term. */
function splitTerms(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out.map((t) => t.trim()).filter(Boolean);
}

/** PostgREST's `or=` / `and(...)` expression language, the subset the code under test writes. */
function parseExpression(expr: string, join: "and" | "or"): Filter {
  const terms = splitTerms(expr).map((term): Filter => {
    const nested = term.match(/^(and|or)\(([\s\S]*)\)$/);
    if (nested) return parseExpression(nested[2], nested[1] as "and" | "or");
    const m = term.match(/^([^.]+)\.(not\.is|eq|neq|gt|gte|lt|lte|is)\.([\s\S]*)$/);
    if (!m) throw new Error(`fake table: cannot parse filter term "${term}"`);
    const [, column, op, raw] = m;
    const value = raw === "null" ? null : raw;
    const test = operator(op, value);
    return (r) => test(r[column] ?? null);
  });
  return join === "and" ? (r) => terms.every((t) => t(r)) : (r) => terms.some((t) => t(r));
}

class Query {
  table: FakeTable;
  failOnQuery: number | null;
  columns: string[] | null = null;
  filters: Filter[] = [];
  orders: { column: string; ascending: boolean }[] = [];
  window: { from: number; to: number } | null = null;
  cap: number | null = null;
  mode: "select" | "update" | "delete" = "select";
  values: Row | null = null;
  wantCount = false;

  constructor(table: FakeTable, failOnQuery: number | null) {
    this.table = table;
    this.failOnQuery = failOnQuery;
  }
  select(columns = "*", opts?: { count?: string; head?: boolean }): Query {
    this.columns = columns.trim() === "*" ? null : columns.split(",").map((c) => c.trim());
    if (opts?.count) this.wantCount = true;
    return this;
  }
  update(values: Row): Query {
    this.mode = "update";
    this.values = values;
    return this;
  }
  delete(opts?: { count?: string }): Query {
    this.mode = "delete";
    if (opts?.count) this.wantCount = true;
    return this;
  }
  eq(column: string, value: unknown): Query {
    this.filters.push((r) => operator("eq", value)(r[column] ?? null));
    return this;
  }
  gt(column: string, value: unknown): Query {
    this.filters.push((r) => operator("gt", value)(r[column] ?? null));
    return this;
  }
  gte(column: string, value: unknown): Query {
    this.filters.push((r) => operator("gte", value)(r[column] ?? null));
    return this;
  }
  lt(column: string, value: unknown): Query {
    this.filters.push((r) => operator("lt", value)(r[column] ?? null));
    return this;
  }
  lte(column: string, value: unknown): Query {
    this.filters.push((r) => operator("lte", value)(r[column] ?? null));
    return this;
  }
  is(column: string, value: unknown): Query {
    this.filters.push((r) => operator("is", value)(r[column] ?? null));
    return this;
  }
  not(column: string, op: string, value: unknown): Query {
    if (op !== "is") throw new Error(`fake table: not(${op}) is not modelled`);
    this.filters.push((r) => operator("not.is", value)(r[column] ?? null));
    return this;
  }
  in(column: string, values: unknown[]): Query {
    const set = new Set(values);
    this.filters.push((r) => set.has(r[column]));
    return this;
  }
  or(expression: string): Query {
    this.filters.push(parseExpression(expression, "or"));
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }): Query {
    this.orders.push({ column, ascending: opts?.ascending ?? true });
    return this;
  }
  range(from: number, to: number): Query {
    this.window = { from, to };
    return this;
  }
  limit(count: number): Query {
    this.cap = count;
    return this;
  }
  // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is thenable; so is this
  then<R>(resolve: (v: Answer) => R): Promise<R> {
    return this.run().then(resolve);
  }
  async run(): Promise<Answer> {
    this.table.queries += 1;
    const n = this.table.queries;
    if (this.failOnQuery === n) {
      return { data: null, error: { message: "connection reset" }, count: null };
    }
    const matching = this.table.rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.mode === "update") {
      // A non-HOT update: the new tuple version lands elsewhere. Every updated
      // row moves to the end of the array, in its current relative order.
      for (const row of matching) {
        Object.assign(row, this.values);
        this.table.touch(String(row.id));
      }
      if (this.table.between) await this.table.between(n, []);
      return { data: null, error: null, count: this.wantCount ? matching.length : null };
    }
    if (this.mode === "delete") {
      for (const row of matching) this.table.remove(String(row.id));
      if (this.table.between) await this.table.between(n, []);
      return { data: null, error: null, count: this.wantCount ? matching.length : null };
    }

    let rows = matching;
    if (this.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of this.orders) {
          const c = cmp(a[column], b[column]);
          if (c !== 0) return ascending ? c : -c;
        }
        return 0;
      });
    }
    if (this.window) rows = rows.slice(this.window.from, this.window.to + 1);
    if (this.cap !== null) rows = rows.slice(0, this.cap);
    const returned = rows.map((r) => {
      if (!this.columns) return { ...r };
      const out: Row = {};
      for (const c of this.columns) out[c] = r[c];
      return out;
    });
    if (this.table.between) await this.table.between(n, returned);
    return { data: returned, error: null, count: this.wantCount ? matching.length : null };
  }
}

/** A client with one or more fake tables behind `.from()`. */
export function fakeClient(tables: Record<string, FakeTable>, opts: { failOnQuery?: number } = {}) {
  return {
    from(name: string): Query {
      const t = tables[name];
      if (!t) throw new Error(`fake client: no table ${name}`);
      return new Query(t, opts.failOnQuery ?? null);
    },
  };
}

/** `n` rows whose ids sort as zero-padded hex, so "before the cursor" is constructible. */
export function hexRows(n: number, extra: Row = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: i.toString(16).padStart(8, "0"), ...extra }));
}
