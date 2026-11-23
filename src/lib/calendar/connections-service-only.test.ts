/**
 * #68: calendar_connections (Google and Microsoft OAuth tokens) is reached
 * only through the service-role client. Migration 072 revokes every privilege
 * the anon and authenticated roles had on it; this test is what makes that
 * revoke safe to keep: a read or write through a user-session, anon or
 * browser client would fail with "permission denied" once 072 is applied.
 *
 *   node --test src/lib/calendar/connections-service-only.test.ts
 *
 * ── How ──────────────────────────────────────────────────────
 *
 * Every source file is parsed with the TypeScript compiler (the same approach
 * as tenant-isolation.test.ts). Every `.from("calendar_connections")`, with the
 * table named literally or through a same-file constant, is a site. Its
 * receiver must be an identifier that resolves to the service-role client:
 *
 *   - a variable initialised with createServiceClient(), or
 *   - a parameter of a function every caller of which passes such a variable
 *     (followed through parameters, caller to caller, until it ends in one)
 *
 * Anything else fails: createClient(), createStatelessClient(), the browser
 * client, a property, a call result, or a name the scan cannot follow. The
 * table embedded in another table's select ("calendar_connections(...)") is a
 * site that always fails, because its client is the other read's. So does the
 * table's name anywhere but a .from() argument or a constant: that is how a
 * .from(<expression>) the scan cannot follow would get it. On the
 * database side, every migration line that names the table must be a schema
 * change or a grant, never a function, view or policy body.
 *
 * ── What it does NOT prove ───────────────────────────────────
 *
 * Nothing here reaches a database. A function or view created by hand in the
 * SQL editor, outside src/lib/supabase/migrations, is invisible to it; 072's
 * own CHECK query is the proof on the live database. Calls are matched by
 * function name, which is unique for every function this scan follows today.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "src");
const TABLE = "calendar_connections";
const SERVICE_FACTORY = "createServiceClient";

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["node_modules", "test-support", "__fixtures__", "migrations"].includes(name)) continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Builds the scan over the given files. `override` replaces one file's text,
 * which is how the negative control in this file proves the scan bites.
 */
function scan(override = null) {
  const files = sourceFiles(SRC).map((p) => {
    const text = override && p.endsWith(override.file) ? override.text : readFileSync(p, "utf8");
    return ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true);
  });

  const fnName = (fn) => {
    if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
    if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
      return fn.parent.name.text;
    return null;
  };

  /** Every call by name, across all files: name -> [{ call, sf }]. */
  const calls = new Map();
  const sites = [];
  for (const sf of files) {
    const consts = new Map();
    const visitConsts = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (ts.isStringLiteralLike(n.initializer)) consts.set(n.name.text, n.initializer.text);
      }
      ts.forEachChild(n, visitConsts);
    };
    visitConsts(sf);
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null;
        if (name) {
          if (!calls.has(name)) calls.set(name, []);
          calls.get(name).push({ call: n, sf });
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "from" &&
          n.arguments[0]
        ) {
          const a = n.arguments[0];
          const table = ts.isStringLiteralLike(a)
            ? a.text
            : ts.isIdentifier(a)
              ? consts.get(a.text)
              : undefined;
          if (table === TABLE)
            sites.push({ kind: "from", node: n, receiver: callee.expression, sf });
          if (table === undefined && !ts.isStringLiteralLike(a)) {
            sites.push({ kind: "unfollowable-table", node: n, sf });
          }
        }
      }
      if (ts.isStringLiteralLike(n) && new RegExp(`\\b${TABLE}\\s*[(!]`).test(n.text)) {
        sites.push({ kind: "embedded", node: n, sf });
      }
      // The table's name anywhere else could reach a .from(<expression>) this
      // scan cannot follow: only a .from() argument or a same-file constant
      // (which the scan does follow) may hold it.
      if (ts.isStringLiteralLike(n) && n.text === TABLE) {
        const p = n.parent;
        const fromArg =
          ts.isCallExpression(p) &&
          p.arguments[0] === n &&
          ts.isPropertyAccessExpression(p.expression) &&
          p.expression.name.text === "from";
        const constInit = ts.isVariableDeclaration(p) && p.initializer === n;
        if (!fromArg && !constInit) sites.push({ kind: "stray-name", node: n, sf });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  /** Where an identifier at `node` is bound: a declaration in an enclosing scope. */
  function bind(id, node) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope)) {
        const i = scope.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === id);
        if (i >= 0) return { kind: "param", fn: scope, index: i };
      }
      const found = [];
      const look = (n) => {
        if (n !== scope && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id)
          found.push(n);
        ts.forEachChild(n, look);
      };
      if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
        ts.forEachChild(scope, look);
        if (found.length) return { kind: "var", decl: found[0] };
      }
    }
    return null;
  }

  const isServiceCall = (e) => {
    while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
    return (
      !!e &&
      ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === SERVICE_FACTORY
    );
  };

  /** Proves `expr` (at `at`) is the service client; returns the chain, or throws with why not. */
  function prove(expr, seen = new Set(), depth = 0) {
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isAsExpression(expr)
    ) {
      expr = expr.expression;
    }
    if (isServiceCall(expr)) return ["createServiceClient()"];
    if (!ts.isIdentifier(expr)) throw new Error(`receiver is not a name: ${expr.getText()}`);
    const b = bind(expr.text, expr);
    if (!b) throw new Error(`cannot follow '${expr.text}'`);
    if (b.kind === "var") {
      if (isServiceCall(b.decl.initializer)) return [`${expr.text} = createServiceClient()`];
      throw new Error(
        `'${expr.text}' = ${b.decl.initializer ? b.decl.initializer.getText().slice(0, 60) : "(no initialiser)"}`,
      );
    }
    const name = fnName(b.fn);
    if (!name) throw new Error(`'${expr.text}' is a parameter of an unnamed function`);
    const key = `${name}#${b.index}`;
    if (seen.has(key)) return [`${name}(param ${b.index}) (cycle)`];
    if (depth > 8) throw new Error(`call chain too deep at ${name}`);
    seen.add(key);
    const callers = (calls.get(name) ?? []).filter(({ call }) => call.arguments.length > b.index);
    const chain = [`${name}(param ${b.index}) <- ${callers.length} caller(s)`];
    for (const { call, sf } of callers) {
      const sub = prove(call.arguments[b.index], seen, depth + 1);
      chain.push(`  ${relative(ROOT, sf.fileName)}:${line(sf, call)} ${sub.join(" / ")}`);
    }
    return chain;
  }

  const line = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  return sites.map((s) => {
    const where = `${relative(ROOT, s.sf.fileName)}:${line(s.sf, s.node)}`;
    if (s.kind === "embedded")
      return { where, ok: false, why: "embedded in another table's select" };
    if (s.kind === "stray-name") {
      return {
        where,
        ok: false,
        why: "the table's name outside .from(): the scan cannot follow it",
      };
    }
    if (s.kind === "unfollowable-table") return { where, ok: null };
    try {
      return { where, ok: true, chain: prove(s.receiver) };
    } catch (err) {
      return { where, ok: false, why: err.message };
    }
  });
}

const tableSites = (results) => results.filter((r) => r.ok !== null);

test("S1. every read and write of calendar_connections goes through the service-role client", () => {
  const all = scan();
  const results = tableSites(all);
  // CALENDAR_SCAN_DUMP=1 prints every site with its proof, for review.
  if (process.env.CALENDAR_SCAN_DUMP) {
    for (const r of results)
      console.log(`${r.ok ? "OK " : "BAD"} ${r.where}\n    ${(r.chain ?? [r.why]).join("\n    ")}`);
    console.log(`unfollowable .from(<expression>) sites: ${all.length - results.length}`);
    for (const r of all.filter((x) => x.ok === null)) console.log(`    ${r.where}`);
  }
  // Not vacuous: the 16 sites found by hand on 2026-11-23 are all in the scan.
  assert.ok(results.length >= 16, `only ${results.length} sites found`);
  const bad = results.filter((r) => !r.ok);
  assert.deepEqual(
    bad.map((r) => `${r.where}: ${r.why}`),
    [],
    "a non-service client touches calendar_connections; migration 072 would break it",
  );
});

test("S2. the three parameter sites are followed to their callers, each ending in createServiceClient()", () => {
  const results = tableSites(scan());
  const viaParam = results.filter((r) => r.chain?.[0].includes("(param"));
  assert.ok(viaParam.length >= 3, `${viaParam.length} parameter sites`);
  for (const r of viaParam) assert.match(r.chain.join("\n"), /createServiceClient\(\)/, r.where);
});

test("S3. no migration puts calendar_connections in a function, view or policy body", () => {
  const dir = join(SRC, "lib/supabase/migrations");
  const ALLOWED =
    /^\s*(--.*|alter table (only )?public\.calendar_connections\b.*|revoke .* on (table )?public\.calendar_connections from .*|grant .* on (table )?public\.calendar_connections to service_role;.*)$/i;
  const offending = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (l.includes(TABLE) && !ALLOWED.test(l)) offending.push(`${f}:${i + 1}: ${l.trim()}`);
      });
  }
  assert.deepEqual(offending, []);
});

test("S4. negative control: one site pointed at the user-session client fails the scan", () => {
  const file = "src/lib/calendar/availability.ts";
  const text = readFileSync(join(ROOT, file), "utf8");
  const swapped = text.replace(
    "const service = createServiceClient();",
    "const service = await createClient();",
  );
  assert.notEqual(swapped, text, "the control found its line");
  const bad = tableSites(scan({ file, text: swapped })).filter((r) => !r.ok);
  assert.equal(bad.length, 1);
  assert.match(bad[0].where, /availability\.ts/);
  assert.match(bad[0].why, /createClient\(\)/);
});

test("M1. migration 072 only revokes, from anon, authenticated and PUBLIC, inside one transaction", () => {
  const file = join(
    SRC,
    "lib/supabase/migrations/072_calendar_connections_revoke_public_roles.sql",
  );
  const sql = readFileSync(file, "utf8");
  assert.ok(sql.startsWith("-- "), "line 1 starts with '-- '");
  const statements = sql
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("--"))
    .map((l) => l.trim());
  assert.deepEqual(statements, [
    "begin;",
    "revoke all on table public.calendar_connections from public;",
    "revoke all on table public.calendar_connections from anon, authenticated;",
    "commit;",
  ]);
  // The CHECK is there, as comments, and covers both sides.
  assert.match(sql, /-- CHECK \(read-only\)/);
  assert.match(sql, /has_table_privilege\(r\.rolname, 'public\.calendar_connections', 'SELECT'\)/);
  assert.match(sql, /where r\.rolname in \('anon', 'authenticated', 'service_role'\)/);
});
