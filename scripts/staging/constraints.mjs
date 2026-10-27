/**
 * The enumerated CHECK constraints of the schema, parsed from the dump, and an
 * assertion that every value the seed will write is permitted by them.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * The column preflight in seed.mjs proves the SHAPE: that every column the
 * seed writes exists. It says nothing about the CONTENT. The first 50-seed
 * passed that preflight for communication_logs and was then rejected by
 * communication_logs_event_check halfway through the table, because the plan
 * wrote an `event` value the constraint does not allow. A green shape check
 * read as a green light for the values too.
 *
 * This closes that gap generally, for every enumerated column the seed writes
 * — event, status, channel, pipeline_stage, role, kind and the rest — so the
 * failure is a preflight LIST before the first insert, never a half-written
 * table.
 *
 * ── Why the dump and not pg_catalog ──────────────────────────
 *
 * The seed's only live handle is the Supabase JS client over PostgREST, which
 * does not expose pg_catalog or information_schema, so the running database
 * cannot be asked for a CHECK definition through it. The authority is instead
 * the schema dump the staging database was RESTORED from (README-steps.md
 * step 1), the same artifact seed-plan.test.mjs already pins vocabularies
 * against. The residual gap, stated plainly: a CHECK altered by a
 * hand-applied migration AFTER that dump was taken would not be reflected
 * here. The migrations that sit outside the dump (step 5) do not alter any of
 * these enums; if that changes, re-take the dump. The preflight FAILS CLOSED
 * when the dump is absent — an unvalidated enumerated column is exactly what
 * caused the failure this guards against.
 */

/** Parse `(<col> = ANY (ARRAY['a'::text, 'b'::text, ...]))` → [col, values] or null. */
function parseAnyArray(text) {
  const m = text.match(/\(([a-z_]+)\s*=\s*ANY\s*\(ARRAY\[([^\]]*)\]/i);
  if (!m) return null;
  const values = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
  return values.length > 0 ? [m[1], values] : null;
}

/**
 * Map every enumerated CHECK in the dump to `${table}.${column}` → allowed[].
 *
 * Handles both forms pg_dump emits: a CONSTRAINT line inside a CREATE TABLE
 * block (the table is the block's), and a standalone ALTER TABLE ADD
 * CONSTRAINT (the table is named on the statement). Only `= ANY (ARRAY[...])`
 * CHECKs are enumerations; range and boolean CHECKs are ignored.
 */
export function parseCheckEnums(dumpText) {
  const out = {};
  const lines = String(dumpText).split("\n");
  let createTable = null; // inside CREATE TABLE public.<t> ( ... );
  let alterTable = null; // inside a (possibly multi-line) ALTER TABLE ... public.<t> ... ;

  for (const line of lines) {
    const create = line.match(/^CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+) \(/i);
    if (create) {
      createTable = create[1];
      continue;
    }
    if (createTable && /^\);/.test(line)) {
      createTable = null;
      continue;
    }
    // pg_dump writes `ALTER TABLE ONLY public.<t>` then `    ADD CONSTRAINT ... ;`
    // on the next line, so the table is remembered until the statement's `;`.
    const alter = line.match(/^ALTER TABLE (?:ONLY )?public\.([a-z0-9_]+)/i);
    if (alter) alterTable = alter[1];

    if (
      /\bCONSTRAINT\b/.test(line) &&
      /\bCHECK\b/.test(line) &&
      /=\s*ANY\s*\(ARRAY\[/i.test(line)
    ) {
      const table = createTable ?? alterTable;
      const parsed = parseAnyArray(line);
      if (table && parsed) out[`${table}.${parsed[0]}`] = parsed[1];
    }

    if (!createTable && /;\s*$/.test(line)) alterTable = null;
  }
  return out;
}

/**
 * Check every planned enumerated value against the parsed constraints.
 *
 * `wanted` is `{ "table.column": string[] }` — the distinct values the seed
 * will write into each enumerated column. Returns a list of violations, each
 * naming the column, the values the plan would write that are NOT allowed, and
 * the allowed set, so the preflight can print all of them at once.
 *
 * A wanted column with no CHECK in the dump is NOT a violation: it is a free
 * column (channel, for instance, has no constraint). A wanted column WITH a
 * CHECK must have every value permitted.
 */
export function enumViolations(constraints, wanted) {
  const violations = [];
  for (const [col, values] of Object.entries(wanted)) {
    const allowed = constraints[col];
    if (!allowed) continue;
    const allowedSet = new Set(allowed);
    const bad = [...new Set(values)].filter((v) => !allowedSet.has(v));
    if (bad.length > 0) violations.push({ column: col, bad, allowed });
  }
  return violations;
}
