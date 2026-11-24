/**
 * #68 step 12b tripwire: token-columns.ts is the ONLY file that writes a
 * calendar token column, and (12c + 12d, at the end) the only one that reads
 * one off a calendar_connections row. Anywhere else, an object literal or an assignment
 * naming access_token, refresh_token, access_token_enc, refresh_token_enc or
 * token_key_id is a write that skips the sealed copies (or forges them), and
 * fails here.
 *
 *   node --test src/lib/calendar/token-columns-tripwire.test.ts
 *
 * A TypeScript parse, not a grep: type members (`access_token: string`), reads
 * (`row.access_token`), destructuring and select strings are not writes. One
 * shape is structurally not a database write and is skipped: an object literal
 * handed straight to `new URLSearchParams(...)`, which is how google.ts sends a
 * refresh token to Google's token endpoint. Every source file under src is
 * scanned (tests excluded); there is no allowlist.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const HELPER = "lib/calendar/token-columns.ts";
const COLUMNS = new Set([
  "access_token",
  "refresh_token",
  "access_token_enc",
  "refresh_token_enc",
  "token_key_id",
]);

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") sourceFiles(p, out);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const nameOf = (n) =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    ? n.text
    : null;

/** Every token-column write in one file's text: "<line>: <what>". */
export function tokenWrites(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const toGoogle = (lit) =>
    ts.isNewExpression(lit.parent) &&
    lit.parent.expression.getText(sf) === "URLSearchParams" &&
    lit.parent.arguments?.[0] === lit;
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n) && !toGoogle(n)) {
      for (const p of n.properties) {
        const name = nameOf(p.name);
        if (name && COLUMNS.has(name)) {
          const isNull =
            ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.NullKeyword;
          found.push(`${at(p)}: ${name} in an object literal${isNull ? " (null)" : ""}`);
        }
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = n.left;
      const name = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target)
          ? nameOf(target.argumentExpression)
          : null;
      if (name && COLUMNS.has(name)) found.push(`${at(n)}: ${name} assigned`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test("12b: no file but token-columns.ts writes a calendar token column", () => {
  const offending = [];
  let scanned = 0;
  for (const p of sourceFiles(SRC)) {
    const rel = relative(SRC, p);
    scanned += 1;
    if (rel === HELPER) continue;
    for (const hit of tokenWrites(rel, readFileSync(p, "utf8"))) offending.push(`${rel}:${hit}`);
  }
  assert.ok(scanned > 500, `the scan reached the tree (${scanned} files)`);
  assert.deepEqual(offending, []);
});

test("12b: the helper itself writes them (the scan sees what it is looking for)", () => {
  const hits = tokenWrites(HELPER, readFileSync(join(SRC, HELPER), "utf8"));
  for (const col of COLUMNS) {
    assert.ok(
      hits.some((h) => h.includes(`: ${col} in an object literal`)),
      `helper writes ${col}`,
    );
  }
});

test("12b: the scan catches every raw shape, and skips type members, reads and the Google request", () => {
  const fixture = [
    'await service.from("calendar_connections").update({ access_token: t });',
    'await service.from("calendar_connections").upsert({ "refresh_token": r });',
    "patch.refresh_token = r;",
    'patch["token_key_id"] = k;',
    "const p = { access_token_enc: x, refresh_token_enc: y };",
    "type Row = { access_token: string; refresh_token: string | null };",
    "const a = row.access_token; const { refresh_token } = row;",
    'service.from("calendar_connections").select("access_token, refresh_token");',
    "body: new URLSearchParams({ refresh_token: r, grant_type: 'refresh_token' }),",
  ].join("\n");
  assert.deepEqual(tokenWrites("fixture.ts", fixture), [
    "1: access_token in an object literal",
    "2: refresh_token in an object literal",
    "3: refresh_token assigned",
    "4: token_key_id assigned",
    "5: access_token_enc in an object literal",
    "5: refresh_token_enc in an object literal",
  ]);
});

/* ── 12c + 12d: reads ─────────────────────────────────────────
 *
 * Reading a token column off a row anywhere but readTokens would skip the
 * sealed copy (and, after 12e, read a column that is empty). A read is a
 * property or element access, or a destructuring, naming access_token,
 * refresh_token, access_token_enc or refresh_token_enc. Select strings and
 * type members are not reads. Scope: access_token and refresh_token in every
 * file that names the "calendar_connections" table in code (google.ts reads
 * Google's own token response, `body.access_token`, and names no table); the
 * two sealed columns in EVERY file, as nothing else has those names.
 */
const READ_COLUMNS = new Set([
  "access_token",
  "refresh_token",
  "access_token_enc",
  "refresh_token_enc",
]);
const SEALED_ONLY = new Set(["access_token_enc", "refresh_token_enc"]);

/** Every token-column read in one file's text: "<line>: <what>". */
export function tokenReads(file, text, { everyFile = false } = {}) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  let namesTable = everyFile;
  const scanTable = (n) => {
    if (ts.isStringLiteral(n) && n.text === "calendar_connections") namesTable = true;
    ts.forEachChild(n, scanTable);
  };
  scanTable(sf);
  const counts = (name) => READ_COLUMNS.has(name) && (namesTable || SEALED_ONLY.has(name));
  const assignedTo = (n) =>
    ts.isBinaryExpression(n.parent) &&
    n.parent.left === n &&
    n.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    n.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  const found = [];
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n) && counts(n.name.text) && !assignedTo(n)) {
      found.push(`${at(n)}: .${n.name.text} read`);
    }
    if (ts.isElementAccessExpression(n) && !assignedTo(n)) {
      const name = nameOf(n.argumentExpression);
      if (name && counts(name)) found.push(`${at(n)}: ["${name}"] read`);
    }
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const name = nameOf(n.propertyName ?? n.name);
      if (name && counts(name)) found.push(`${at(n)}: ${name} destructured`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

test("12d: no file but token-columns.ts reads a token column off a calendar_connections row", () => {
  const offending = [];
  let scanned = 0;
  for (const p of sourceFiles(SRC)) {
    const rel = relative(SRC, p);
    scanned += 1;
    if (rel === HELPER) continue;
    for (const hit of tokenReads(rel, readFileSync(p, "utf8"))) offending.push(`${rel}:${hit}`);
  }
  assert.ok(scanned > 500, `the scan reached the tree (${scanned} files)`);
  assert.deepEqual(offending, []);
});

test("12d: the helper itself reads the sealed columns (the scan sees what it is looking for)", () => {
  const hits = tokenReads(HELPER, readFileSync(join(SRC, HELPER), "utf8"));
  for (const col of SEALED_ONLY) {
    assert.ok(
      hits.some((h) => h.includes(col)),
      `helper reads ${col}`,
    );
  }
});

/* ── 12e: plaintext is never written and never read, the helper included ── */

const PLAINTEXT = ["access_token", "refresh_token"];

// Negative control: write a token in plaintext again (sealedWrite's
// `access_token: null` back to the token) and this test fails.
test("12e: no file, the helper included, writes a plaintext token column except as null", () => {
  const offending = [];
  let helperNulls = 0;
  for (const p of sourceFiles(SRC)) {
    const rel = relative(SRC, p);
    for (const hit of tokenWrites(rel, readFileSync(p, "utf8"))) {
      const plain = PLAINTEXT.some((c) => new RegExp(`: ${c} (in|assigned)`).test(hit));
      if (!plain) continue;
      if (rel === HELPER && hit.endsWith("(null)")) helperNulls += 1;
      else offending.push(`${rel}:${hit}`);
    }
  }
  assert.deepEqual(offending, []);
  assert.equal(helperNulls, 2, "the helper sets both plaintext columns to null on every write");
});

// Negative control: put a plaintext fallback back into readTokens
// (row.access_token) and this test fails.
test("12e: no file, the helper included, reads a plaintext token column", () => {
  const offending = [];
  for (const p of sourceFiles(SRC)) {
    const rel = relative(SRC, p);
    const text = readFileSync(p, "utf8");
    for (const hit of tokenReads(rel, text, { everyFile: rel === HELPER })) {
      if (PLAINTEXT.some((c) => new RegExp(`\\b${c}\\b(?!_enc)`).test(hit))) {
        offending.push(`${rel}:${hit}`);
      }
    }
  }
  assert.deepEqual(offending, []);
});

test("12d: the read scan catches every raw shape, and skips select strings, types, writes and Google's response", () => {
  const onTable = [
    'const { data: row } = await service.from("calendar_connections").select("access_token, refresh_token").maybeSingle();',
    "const a = row.access_token;",
    'const b = row["refresh_token"];',
    "const { access_token, refresh_token: r } = row;",
    "type Row = { access_token: string };",
    "patch.access_token = x;",
  ].join("\n");
  assert.deepEqual(tokenReads("fixture.ts", onTable), [
    "2: .access_token read",
    '3: ["refresh_token"] read',
    "4: access_token destructured",
    "4: refresh_token destructured",
  ]);
  const google = "const t = body.access_token; const r = body.refresh_token;";
  assert.deepEqual(tokenReads("google-like.ts", google), [], "no table named: Google's response");
  assert.deepEqual(tokenReads("anywhere.ts", "const s = row.refresh_token_enc;"), [
    "1: .refresh_token_enc read",
  ]);
});

test("12d + 12e: every select that reads tokens names every column readTokens needs, and no plaintext one", () => {
  const helper = readFileSync(join(SRC, HELPER), "utf8");
  const type = helper.slice(helper.indexOf("export type TokenRow = {"));
  const needed = [...type.slice(0, type.indexOf("};")).matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(needed.sort(), [
    "access_token_enc",
    "id",
    "member_id",
    "provider",
    "refresh_token_enc",
    "token_key_id",
    "updated_at",
  ]);
  const connections = readFileSync(join(SRC, "lib/calendar/connections.ts"), "utf8");
  for (const name of ["ROW_COLUMNS", "STORED_TOKEN_COLUMNS"]) {
    const m = new RegExp(`const ${name} =\\s*"([^"]+)";`).exec(connections);
    assert.ok(m, `${name} is a same-file string`);
    const cols = m[1].split(",").map((c) => c.trim());
    for (const c of needed) assert.ok(cols.includes(c), `${name} names ${c}`);
    // 12e: no plaintext token column, so 12f can drop them.
    for (const c of PLAINTEXT) assert.ok(!cols.includes(c), `${name} does not name ${c}`);
  }
  assert.match(connections, /\.select\(ROW_COLUMNS\)/);
  assert.match(connections, /\.select\(STORED_TOKEN_COLUMNS\)/);
});
