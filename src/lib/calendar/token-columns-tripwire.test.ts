/**
 * #68 step 12b tripwire: token-columns.ts is the ONLY file that writes a
 * calendar token column. Anywhere else, an object literal or an assignment
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
        if (name && COLUMNS.has(name)) found.push(`${at(p)}: ${name} in an object literal`);
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
      hits.some((h) => h.endsWith(`${col} in an object literal`)),
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
