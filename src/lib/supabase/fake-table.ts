/**
 * A fake PostgREST table for paging tests. TEST SUPPORT ONLY.
 *
 * Not src/test-support/fake-postgrest.mjs, which RECORDS calls and lets a
 * responder answer them: this one EVALUATES the query against rows, because
 * the paging tests are about which rows come back when the table moves
 * between two pages. Just enough of supabase-js's builder to drive `pageAll`,
 * `pageAllByKey` and rescoreJob's two collection reads: `from`, `select`
 * (with real column projection), `eq`, `gt`, `gte`, `in`, `order`, `range`,
 * `limit`, and a thenable that resolves `{ data, error }` as PostgREST does.
 *
 * ── What it models on purpose ────────────────────────────────
 *
 * A query with no `.order()` returns rows in ARRAY order, which stands in for
 * Postgres's heap order: undefined, usually stable, and moved by writes.
 * `touch(id)` moves a row to the end of the array, which is what a non-HOT
 * UPDATE does to a tuple's position. `insert` appends; `remove` splices. The
 * `between` hook runs after every resolved query, so a test can mutate the
 * table between two pages exactly where a concurrent writer would.
 *
 * Plain fields throughout: Node's type stripping cannot run a constructor
 * parameter property.
 */

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Answer = { data: Row[] | null; error: { message: string } | null };

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

class Query {
  table: FakeTable;
  failOnQuery: number | null;
  columns: string[] | null = null;
  filters: Filter[] = [];
  orderBy: { column: string; ascending: boolean } | null = null;
  window: { from: number; to: number } | null = null;
  cap: number | null = null;

  constructor(table: FakeTable, failOnQuery: number | null) {
    this.table = table;
    this.failOnQuery = failOnQuery;
  }
  select(columns = "*"): Query {
    this.columns = columns.trim() === "*" ? null : columns.split(",").map((c) => c.trim());
    return this;
  }
  eq(column: string, value: unknown): Query {
    this.filters.push((r) => r[column] === value);
    return this;
  }
  gt(column: string, value: string): Query {
    this.filters.push((r) => String(r[column]) > value);
    return this;
  }
  gte(column: string, value: string): Query {
    this.filters.push((r) => String(r[column]) >= value);
    return this;
  }
  in(column: string, values: unknown[]): Query {
    const set = new Set(values);
    this.filters.push((r) => set.has(r[column]));
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }): Query {
    this.orderBy = { column, ascending: opts?.ascending ?? true };
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
    if (this.failOnQuery === n) return { data: null, error: { message: "connection reset" } };
    let rows = this.table.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const x = String(a[column]);
        const y = String(b[column]);
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
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
    return { data: returned, error: null };
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
