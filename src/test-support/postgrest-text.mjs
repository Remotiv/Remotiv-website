/**
 * How PostgREST reads a search's text, for evaluators that answer queries.
 *
 * Two things, each modelled on behaviour measured against staging (PostgREST
 * 14.18) rather than assumed (#73):
 *
 *   parseLogic   an `or=( … )` / `and( … )` tree. An unquoted comma ends a
 *                value (measured: `or=(subject.ilike.%a,b%)` is PGRST100). A
 *                double-quoted value is data, and inside it `\` escapes the
 *                next character (measured: `"%\\50%"` reaches Postgres with one
 *                backslash). Anything this cannot parse THROWS, standing in for
 *                PostgREST's 400.
 *   ilikeMatches an ilike pattern as Postgres reads it AFTER PostgREST has
 *                rewritten every `*` to `%` (measured: `subject.ilike."*"`
 *                matched every row, so quoting does not stop it). `%` and `_`
 *                are wildcards and `\` is the escape, Postgres's default.
 *
 * Not modelled: what PostgREST does with an UNQUOTED `)` or `"` inside a
 * value. Staging answered 200 for both and counted 0, which says nothing about
 * how it parsed them. Here an unquoted `)` ends the value and the rest fails to
 * parse; the code under test never sends one unquoted.
 */

/** Parse `or(…)` or `and(…)`, the whole string. */
export function parseLogic(text) {
  let i = 0;
  const fail = (why) => {
    throw new Error(`test: PostgREST would reject this logic tree (${why}) at ${i}: ${text}`);
  };
  const peek = (s) => text.startsWith(s, i);

  function quoted() {
    i += 1;
    let out = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i += 1;
      if (i >= text.length) fail("unterminated escape");
      out += text[i];
      i += 1;
    }
    if (text[i] !== '"') fail("unterminated quote");
    i += 1;
    return out;
  }

  function raw() {
    let out = "";
    while (i < text.length && text[i] !== "," && text[i] !== ")") out += text[i++];
    return out;
  }

  function list() {
    i += 1;
    const items = [];
    while (text[i] !== ")") {
      if (i >= text.length) fail("unterminated list");
      items.push(text[i] === '"' ? quoted() : raw());
      if (text[i] === ",") i += 1;
    }
    i += 1;
    return items;
  }

  function node() {
    for (const kind of ["and", "or"]) {
      if (peek(`${kind}(`)) {
        i += kind.length + 1;
        const children = [node()];
        while (text[i] === ",") {
          i += 1;
          children.push(node());
        }
        if (text[i] !== ")") fail(`expected ) to close ${kind}`);
        i += 1;
        return { kind, children };
      }
    }
    const m = /^([a-z_][a-z0-9_.]*?)\.(not\.)?(eq|neq|is|ilike|in)\./.exec(text.slice(i));
    if (!m) fail("not a term");
    i += m[0].length;
    const [, col, not, op] = m;
    let val;
    if (op === "in") {
      if (text[i] !== "(") fail("in. without a list");
      val = list();
    } else {
      val = text[i] === '"' ? quoted() : raw();
    }
    return { kind: "term", col, not: Boolean(not), op, val };
  }

  const tree = node();
  if (i !== text.length) fail("trailing text");
  return tree;
}

/** Does `value` match the ilike `pattern`, as PostgREST hands it to Postgres? */
export function ilikeMatches(pattern, value) {
  if (value === null || value === undefined) return false;
  const p = String(pattern).replaceAll("*", "%");
  let rx = "";
  for (let k = 0; k < p.length; k += 1) {
    const ch = p[k];
    if (ch === "\\") {
      k += 1;
      if (k >= p.length) throw new Error("test: LIKE pattern must not end with escape character");
      rx += p[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") rx += "[\\s\\S]*";
    else if (ch === "_") rx += "[\\s\\S]";
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`, "i").test(String(value));
}

/** Evaluate a parsed tree against one row. SQL NULL fails every comparison but `is.null`. */
export function evalLogic(tree, row) {
  if (tree.kind === "and") return tree.children.every((c) => evalLogic(c, row));
  if (tree.kind === "or") return tree.children.some((c) => evalLogic(c, row));
  const v = row[tree.col];
  let hit;
  if (tree.op === "is")
    hit = tree.val === "null" ? v === null || v === undefined : String(v) === tree.val;
  else if (v === null || v === undefined) return false;
  else if (tree.op === "eq") hit = String(v) === tree.val;
  else if (tree.op === "neq") hit = String(v) !== tree.val;
  else if (tree.op === "in") hit = tree.val.includes(String(v));
  else hit = ilikeMatches(tree.val, v);
  return tree.not ? !hit : hit;
}
