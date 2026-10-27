/**
 * Review and strip a production schema dump, as pure functions over its text.
 *
 *   node scripts/staging/review-dump.mjs /tmp/remotiv-prod-schema.sql
 *   node scripts/staging/strip-dump.mjs  /tmp/remotiv-prod-schema.sql
 *
 * Two jobs, deliberately separate:
 *
 *   reviewDump(text)  reads the dump and reports every object class that
 *                     README-steps.md step 2 says must be looked at: anything
 *                     that reaches outside the database, anything naming a
 *                     host, anything that will not resolve in a fresh project.
 *                     It changes nothing.
 *   stripDump(text)   applies ONLY the approved mechanical edits, and refuses
 *                     to write anything at all while the review still shows a
 *                     finding that needs a human decision. A webhook trigger is
 *                     never "stripped automatically": it is reported, and the
 *                     operator removes it by hand and re-runs.
 *
 * ── Nothing here prints a host, a path or a token ────────────
 *
 * Every statement shown to a reader goes through mask(): a Supabase project
 * host becomes `<ref>.supabase.co` and every URL's path becomes `<path:N>`.
 * A third-party webhook URL carries a secret in its path, and a Supabase host
 * carries the project ref, and AGENTS.md puts both in the credential category.
 *
 * ── The dump is parsed into statements ───────────────────────
 *
 * pg_dump writes one statement per line except function bodies, which span
 * lines inside dollar quotes. Statements are split on a `;` that ends a line
 * outside dollar quotes, so a `;` inside a plpgsql body does not split it and a
 * grep over lines would not have found a trigger whose EXECUTE FUNCTION is on
 * the next line.
 */

const HOST_RE = /\b[a-z0-9-]{10,}\.supabase\.(co|in)\b/gi;
const URL_RE = /https?:\/\/([^\s/'"]+)(\/[^\s'"]*)?/gi;

/** Redact what identifies a project or carries a token, keep what a reviewer needs. */
export function mask(text) {
  return String(text)
    .replace(URL_RE, (_m, host, path) => {
      const h = HOST_RE.test(host) ? host.replace(HOST_RE, "<ref>.supabase.$1") : host;
      HOST_RE.lastIndex = 0;
      return `https://${h}${path ? `/<path:${path.length - 1}>` : ""}`;
    })
    .replace(HOST_RE, "<ref>.supabase.$1");
}

/** Split dump text into { line, text } statements, dollar-quote aware. */
export function statements(text) {
  const out = [];
  const lines = String(text).split("\n");
  let buf = [];
  let start = 0;
  let tag = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (buf.length === 0) {
      if (line.trim() === "" || line.startsWith("--")) continue;
      // A psql meta-command (\restrict, \unrestrict) is one line with no
      // semicolon. Left in the buffer it would swallow the next statement.
      if (line.startsWith("\\")) {
        out.push({ line: i + 1, text: line });
        continue;
      }
      start = i + 1;
    }
    buf.push(line);
    // Track dollar quoting: $$ or $tag$. A line may open and close on itself.
    for (const m of line.matchAll(/\$([A-Za-z_]*)\$/g)) {
      if (tag === null) tag = m[1];
      else if (tag === m[1]) tag = null;
    }
    if (tag === null && /;\s*$/.test(line)) {
      out.push({ line: start, text: buf.join("\n") });
      buf = [];
    }
  }
  if (buf.length > 0) out.push({ line: start, text: buf.join("\n") });
  return out;
}

/** The classes a human must decide on. The strip refuses while any is non-empty. */
export const BLOCKING = {
  outbound: /supabase_functions|http_request|pg_net|net\.http|dblink|pg_notify|\bNOTIFY\b/i,
  cron: /\bcron\./,
  url: /https?:\/\/|\.supabase\.(co|in)\b/i,
  owner: /\bOWNER TO\b|^SET ROLE\b|SESSION AUTHORIZATION/im,
  foreign: /^CREATE (PUBLICATION|SUBSCRIPTION|EVENT TRIGGER|SERVER|FOREIGN)\b/im,
  drop: /^DROP\b/im,
};

/** The classes the strip removes mechanically, each with its reason. */
export const MECHANICAL = {
  createSchemaPublic: {
    re: /^CREATE SCHEMA (IF NOT EXISTS )?public;/i,
    reason: "a fresh project already has public; CREATE fails under ON_ERROR_STOP",
  },
  commentSchemaPublic: {
    re: /^COMMENT ON SCHEMA public /i,
    reason: "the comment belongs to CREATE SCHEMA public, which is removed",
  },
  defaultPrivilegesSupabaseAdmin: {
    re: /^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin\b/i,
    reason: "postgres cannot act for supabase_admin; the fresh project already carries these",
  },
};

const GRANTEE_RE = /^(?:GRANT|REVOKE)\b[\s\S]*?\b(?:TO|FROM)\s+([^;]+);/i;

/* ── Indexing: which extension each access method and operator class comes from ──
 *
 * A `--schema=public` dump never emits CREATE EXTENSION, so every extension
 * the schema leans on has to be inferred from what the indexes use. Two were
 * missed the first time staging was built, and each stopped the restore dead:
 * pg_trgm was known; btree_gist was not, because an EXCLUDE USING gist over a
 * uuid column needs it and nothing here looked at gist element types. The
 * tables below are the enumeration, so the third one is a review finding and
 * not a restore failure. Anything not in them is BLOCKING: the strip refuses
 * until a human says where it comes from.
 */
export const ACCESS_METHOD_SOURCE = {
  btree: "core",
  hash: "core",
  gin: "core",
  gist: "core (element types decide whether btree_gist is also needed)",
  spgist: "core",
  brin: "core",
  ivfflat: "vector",
  hnsw: "vector",
};

export const OPCLASS_SOURCE = {
  gin_trgm_ops: "pg_trgm",
  gist_trgm_ops: "pg_trgm",
  jsonb_ops: "core",
  jsonb_path_ops: "core",
  array_ops: "core",
  tsvector_ops: "core",
  range_ops: "core",
  text_pattern_ops: "core",
  varchar_pattern_ops: "core",
  bpchar_pattern_ops: "core",
  vector_l2_ops: "vector",
  vector_cosine_ops: "vector",
  vector_ip_ops: "vector",
};

/** btree_gist's operator classes are all named gist_<btree type>_ops. */
const BTREE_GIST_OPCLASS_RE =
  /^gist_(uuid|text|bpchar|varchar|int2|int4|int8|float4|float8|numeric|timestamp|timestamptz|date|time|timetz|interval|oid|money|macaddr|macaddr8|inet|cidr|bool|bit|varbit|enum|bytea|char)_ops$/;

/** Types core gist indexes without any extension. Everything else in gist needs btree_gist. */
const GIST_NATIVE_TYPE_RE =
  /^(tstzrange|tsrange|daterange|int4range|int8range|numrange|tstzmultirange|tsmultirange|datemultirange|int4multirange|int8multirange|nummultirange|box|point|circle|polygon|line|lseg|path|inet|cidr|tsvector|tsquery)\b/;
const GIST_NATIVE_EXPR_RE =
  /\b(tstzrange|tsrange|daterange|int4range|int8range|numrange|box|point|circle|polygon|to_tsvector|to_tsquery|plainto_tsquery)\s*\(/i;

/** Column types per public table, read out of the dump's CREATE TABLE statements. */
export function columnTypes(stmts) {
  const tables = {};
  for (const s of stmts) {
    const m = s.text.match(/^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z0-9_]+)"? \(/i);
    if (!m) continue;
    const cols = {};
    for (const line of s.text.split("\n").slice(1)) {
      // The type is one or more words (timestamp with time zone), lazily, up to
      // the first column keyword or the end of the line.
      const c = line.match(
        /^\s+"?([a-z0-9_]+)"?\s+((?:[a-z_]+(?: [a-z_]+)*?)(?:\([^)]*\))?(?:\[\])?)(?=\s+(?:DEFAULT|NOT NULL|NULL|GENERATED|COLLATE|CONSTRAINT|CHECK|REFERENCES|UNIQUE|PRIMARY)\b|,?\s*$)/i,
      );
      if (c && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(c[1])) {
        cols[c[1]] = c[2].toLowerCase();
      }
    }
    tables[m[1]] = cols;
  }
  return tables;
}

/**
 * Walk SQL text tracking parenthesis depth, ignoring parentheses inside
 * single-quoted literals. The real EXCLUDE constraint carries '[)' as a range
 * bound, and a walker that counted that `)` closed the element list early.
 */
function walk(text, from, onChar) {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === "(") depth += 1;
    else if (!quoted && ch === ")") depth -= 1;
    if (onChar(ch, depth, i, quoted) === false) return;
  }
}

/** The text between the parenthesis after `USING gist` and its matching close. */
function gistElementList(stmtText) {
  const at = stmtText.search(/USING gist\s*\(/i);
  if (at < 0) return null;
  const open = stmtText.indexOf("(", at);
  let result = null;
  walk(stmtText, open, (_ch, depth, i) => {
    if (depth === 0) {
      result = stmtText.slice(open + 1, i);
      return false;
    }
    return true;
  });
  return result;
}

function splitTopLevel(list) {
  const out = [];
  let cur = "";
  walk(list, 0, (ch, depth, _i, quoted) => {
    if (ch === "," && depth === 0 && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
    return true;
  });
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Classify one gist element: where its operator support comes from.
 *
 * Returns { expr, source, reason } with source one of "core", "pg_trgm",
 * "btree_gist" or "unknown". A bare column is resolved through the table's
 * CREATE TABLE; an expression is classified by the function it calls. Anything
 * that cannot be resolved is reported as needing btree_gist AND as unknown, so
 * the extension is prepended (harmless: IF NOT EXISTS) and the strip still
 * refuses until someone looks.
 */
function classifyGistElement(raw, cols) {
  let expr = raw.replace(/\s+WITH\s+\S+\s*$/i, "").trim();
  const op = expr.match(/\s+(?:public\.)?([a-z0-9_]+_ops)\s*$/i);
  if (op) {
    expr = expr.slice(0, op.index).trim();
    const name = op[1].toLowerCase();
    if (BTREE_GIST_OPCLASS_RE.test(name)) return { expr, source: "btree_gist", reason: name };
    const known = OPCLASS_SOURCE[name];
    if (known) return { expr, source: known.split(" ")[0], reason: name };
    return { expr, source: "unknown", reason: `operator class ${name} is from no known extension` };
  }
  if (GIST_NATIVE_EXPR_RE.test(expr))
    return { expr, source: "core", reason: "range or text-search expression" };
  const bare = expr.match(/^"?([a-z0-9_]+)"?$/i);
  if (bare) {
    const type = cols?.[bare[1]];
    if (!type) {
      return {
        expr,
        source: "unknown",
        reason: "column type not found in the dump's CREATE TABLE",
      };
    }
    if (GIST_NATIVE_TYPE_RE.test(type)) return { expr, source: "core", reason: type };
    return {
      expr,
      source: "btree_gist",
      reason: `${type} has no gist operator class without btree_gist`,
    };
  }
  return { expr, source: "unknown", reason: "expression of an unresolved type" };
}

/** Every gist index or EXCLUDE constraint, with each element's source. */
export function gistUsage(stmts, types) {
  const out = [];
  for (const s of stmts) {
    if (!/USING gist\s*\(/i.test(s.text)) continue;
    const list = gistElementList(s.text);
    const table = s.text.match(
      /(?:ON|ALTER TABLE(?: ONLY)?)\s+(?:public\.)?"?([a-z0-9_]+)"?/i,
    )?.[1];
    const cols = table ? types[table] : undefined;
    out.push({
      line: s.line,
      preview: mask(s.text.split("\n").at(-1).trim()).slice(0, 160),
      elements: list === null ? [] : splitTopLevel(list).map((e) => classifyGistElement(e, cols)),
    });
  }
  return out;
}

export function reviewDump(text) {
  const stmts = statements(text);
  const hit = (re) => stmts.filter((s) => re.test(s.text));
  const show = (list) =>
    list.map((s) => ({ line: s.line, preview: mask(s.text.split("\n")[0]).slice(0, 160) }));

  const counts = {
    statements: stmts.length,
    tables: hit(/^CREATE TABLE\b/i).length,
    rlsEnabled: hit(/ENABLE ROW LEVEL SECURITY/i).length,
    policies: hit(/^CREATE POLICY\b/i).length,
    indexes: hit(/^CREATE (UNIQUE )?INDEX\b/i).length,
    triggers: hit(/^CREATE (OR REPLACE )?TRIGGER\b/i).length,
    functions: hit(/^CREATE (OR REPLACE )?FUNCTION\b/i).length,
    sequences:
      hit(/^CREATE SEQUENCE\b/i).length + hit(/GENERATED (ALWAYS|BY DEFAULT) AS IDENTITY/i).length,
    generatedColumns: (text.match(/GENERATED ALWAYS AS \(/gi) ?? []).length,
    grants: hit(/^(GRANT|REVOKE)\b/i).length,
    defaultPrivileges: hit(/^ALTER DEFAULT PRIVILEGES\b/i).length,
    extensions: hit(/^CREATE EXTENSION\b/i).length,
    securityDefiner: hit(/SECURITY DEFINER/i).length,
  };

  const grantees = new Set();
  for (const s of hit(/^(GRANT|REVOKE)\b/i)) {
    const m = s.text.match(GRANTEE_RE);
    if (m) for (const g of m[1].split(",")) grantees.add(g.trim().replace(/^"|"$/g, ""));
  }

  const blocking = Object.fromEntries(
    Object.entries(BLOCKING).map(([k, re]) => [k, show(hit(re))]),
  );
  const mechanical = Object.fromEntries(
    Object.entries(MECHANICAL).map(([k, { re, reason }]) => [k, { reason, hits: show(hit(re)) }]),
  );

  const triggersOutsidePublic = show(
    hit(/^CREATE (OR REPLACE )?TRIGGER\b/i).filter(
      (s) => !/EXECUTE (FUNCTION|PROCEDURE) public\./i.test(s.text),
    ),
  );

  // Indexing: every access method and operator class the dump uses, each with
  // its source, and every gist element resolved to the extension it needs.
  const tally = (re) => {
    const m = {};
    for (const s of stmts) {
      for (const x of s.text.matchAll(re)) m[x[1].toLowerCase()] = (m[x[1].toLowerCase()] ?? 0) + 1;
    }
    return m;
  };
  const accessMethods = Object.fromEntries(
    Object.entries(tally(/\bUSING ([a-z_]+)\s*\(/gi)).map(([k, n]) => [
      k,
      { count: n, source: ACCESS_METHOD_SOURCE[k] ?? "UNKNOWN: decide by hand" },
    ]),
  );
  const operatorClasses = Object.fromEntries(
    Object.entries(tally(/\b(?:public\.)?([a-z0-9_]+_ops)\b/gi)).map(([k, n]) => [
      k,
      {
        count: n,
        source: BTREE_GIST_OPCLASS_RE.test(k)
          ? "btree_gist"
          : (OPCLASS_SOURCE[k] ?? "UNKNOWN: decide by hand"),
      },
    ]),
  );
  const gist = gistUsage(stmts, columnTypes(stmts));
  const unknownIndexing = [
    ...Object.entries(accessMethods)
      .filter(([, v]) => v.source.startsWith("UNKNOWN"))
      .map(([k]) => `access method ${k}`),
    ...Object.entries(operatorClasses)
      .filter(([, v]) => v.source.startsWith("UNKNOWN"))
      .map(([k]) => `operator class ${k}`),
    ...gist.flatMap((g) =>
      g.elements
        .filter((e) => e.source === "unknown")
        .map((e) => `gist element at line ${g.line}: ${e.reason}`),
    ),
  ];
  blocking.extension = unknownIndexing.map((reason) => ({ line: 0, preview: reason }));

  return {
    counts,
    grantees: [...grantees].sort(),
    needs: {
      pg_trgm: /gin_trgm_ops|gist_trgm_ops/.test(text),
      uuid_ossp: /uuid_generate_v/.test(text),
      btree_gist: gist.some((g) =>
        g.elements.some((e) => e.source !== "core" && e.source !== "pg_trgm"),
      ),
    },
    indexing: { accessMethods, operatorClasses, gist },
    effectiveScore: show(hit(/effective_score[\s\S]*GENERATED ALWAYS AS/i)),
    triggersOutsidePublic,
    blocking,
    mechanical,
    blockingTotal: Object.values(blocking).reduce((n, l) => n + l.length, 0),
  };
}

/**
 * The approved mechanical edits, or a refusal naming what still needs a human.
 *
 * Removes the CREATE SCHEMA public pair and any supabase_admin default
 * privileges, prepends the extensions the body references, and refuses to
 * produce output while any blocking class has a hit. The output is also
 * checked for a DROP of any kind: there is none in a dump taken without
 * --clean, and the restore being structurally unable to drop anything is the
 * safety property the README leans on.
 */
/**
 * The restore GATE on effective_score.
 *
 * application_scores.effective_score is the GENERATED column Best Match orders
 * by (applicants/actions.ts:865). It appears in no repo artifact. A dump
 * without it is a dump of a database where Best Match cannot work, and the
 * right response is to stop and report, not to restore and investigate after:
 * a staging database restored without it would fail the Best Match assertions
 * for a reason that has nothing to do with the ordering under test.
 */
export const EFFECTIVE_SCORE_GATE =
  "effective_score: NOT FOUND as a GENERATED ALWAYS AS column. RESTORE GATE: stop and report; " +
  "do not restore and investigate afterwards.";

/** The only two psql meta-commands a pg_dump 18 schema dump legitimately carries. */
const META_COMMAND_RE = /^\\(restrict|unrestrict)\b/;

export function stripDump(text) {
  const review = reviewDump(text);
  const blockers = Object.entries(review.blocking)
    .filter(([, l]) => l.length > 0)
    .map(([k, l]) =>
      k === "extension"
        ? `extension: ${l.length} indexing feature(s) from no known extension: ${l.map((x) => x.preview).join("; ")}`
        : `${k}: ${l.length} statement(s) at line(s) ${l.map((x) => x.line).join(", ")}`,
    );
  if (review.effectiveScore.length === 0) blockers.push(EFFECTIVE_SCORE_GATE);
  if (blockers.length > 0) return { ok: false, review, blockers };

  const removed = [];
  const keep = [];
  for (const s of statements(text)) {
    // \restrict and \unrestrict are re-emitted ONCE, by the header and footer
    // below. Left in the body they appear twice, and psql refuses the second
    // \restrict: "backslash commands are restricted; only \unrestrict is allowed".
    // ANY OTHER meta-command is refused with its line and text: a file that
    // silently lost a \command it did not expect looks fine and is not.
    if (s.text.startsWith("\\")) {
      if (META_COMMAND_RE.test(s.text)) continue;
      return {
        ok: false,
        review,
        blockers: [
          `meta-command: line ${s.line}: unexpected psql command ${mask(s.text).slice(0, 120)}`,
        ],
      };
    }
    const rule = Object.entries(MECHANICAL).find(([, { re }]) => re.test(s.text));
    if (rule) {
      removed.push({
        line: s.line,
        rule: rule[0],
        reason: rule[1].reason,
        preview: mask(s.text.split("\n")[0]).slice(0, 120),
      });
    } else keep.push(s);
  }

  const prepended = [];
  if (review.needs.pg_trgm) {
    prepended.push("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;");
  }
  if (review.needs.uuid_ossp) {
    prepended.push('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;');
  }
  if (review.needs.btree_gist) {
    prepended.push("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;");
  }

  // The \restrict line, if any, must stay first: psql reads it as a meta-command.
  const lines = String(text).split("\n");
  const restrict = lines.find((l) => l.startsWith("\\restrict"));
  const header = [
    ...(restrict ? [restrict] : []),
    "-- scripts/staging/strip-dump.mjs: approved mechanical edits applied. See README-steps.md steps 2 and 4.",
    ...prepended,
    "",
  ];
  const body = keep.map((s) => s.text).join("\n\n");
  const unrestrict = lines.find((l) => l.startsWith("\\unrestrict"));
  const out = `${[...header, body, ...(unrestrict ? ["", unrestrict] : [])].join("\n")}\n`;

  if (/^DROP\b/im.test(out)) {
    return { ok: false, review, blockers: ["the output contains a DROP statement; refusing"] };
  }
  return { ok: true, review, text: out, removed, prepended };
}
