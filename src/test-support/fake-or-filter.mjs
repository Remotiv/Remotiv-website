/**
 * PostgREST's `or=( … )` grammar, as far as the duplicate checks use it, so a
 * fake database can answer `.or()` the way PostgREST would.
 *
 *   - Terms are split on top-level commas; a double-quoted value keeps its
 *     commas and parentheses, and `\` inside quotes escapes the next character.
 *   - `col.op.value` and `col.not.op.value`, for `eq` and `is` (null).
 *   - An UNQUOTED value holding `(`, `)`, `"` or `\` is a parse error, as it is
 *     for PostgREST: the request fails rather than matching anything.
 *   - Several `.or()` calls on one query are ANDed, as PostgREST ANDs repeated
 *     `or=` parameters.
 *
 * So an unquoted `a@x.com,id.not.is.null` really becomes two terms here, and
 * the second matches every row: the injection the quoting exists to stop.
 */

function splitTopLevel(text) {
  const out = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") {
        cur += c + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (c === '"') quoted = false;
      cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** One term, or null when PostgREST could not parse it. */
function parseTerm(term) {
  const m = term.match(/^([a-z_]+)\.(not\.)?([a-z]+)\.([\s\S]*)$/);
  if (!m) return null;
  let value = m[4];
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) return null;
    value = value.slice(1, -1).replace(/\\([\s\S])/g, "$1");
  } else if (/[()"\\]/.test(value)) {
    return null;
  }
  return { column: m[1], negated: Boolean(m[2]), op: m[3], value };
}

function termMatches(row, t) {
  let hit;
  if (t.op === "eq") hit = row[t.column] === t.value;
  else if (t.op === "is" && t.value === "null")
    hit = row[t.column] === null || row[t.column] === undefined;
  else return false;
  return t.negated ? !hit : hit;
}

/**
 * Rows passing every `.or()` in `calls`, or `{ error }` when one cannot be
 * parsed (PostgREST answers PGRST100 and no rows).
 */
export function applyOrFilters(rows, calls) {
  let out = rows;
  for (const call of calls.filter((c) => c[0] === "or")) {
    const terms = splitTopLevel(call[1]).map(parseTerm);
    if (terms.some((t) => t === null))
      return { error: { code: "PGRST100", message: "parse error" } };
    out = out.filter((row) => terms.some((t) => termMatches(row, t)));
  }
  return { rows: out };
}
