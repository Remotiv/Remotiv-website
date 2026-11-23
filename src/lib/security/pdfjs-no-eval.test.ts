/**
 * #72: the pdf.js builds this app runs have no eval path, so the production
 * CSP needs no 'unsafe-eval' for CV text extraction.
 *
 *   node --test src/lib/security/pdfjs-no-eval.test.ts
 *
 * ── Why this and not isEvalSupported: false ──────────────────
 *
 * The usual hardening for CVE-2024-4367 is getDocument({ isEvalSupported:
 * false }). pdfjs-dist 6 (installed: see P1) no longer has that option at all:
 * the font path it switched off was removed, and nothing in the build calls
 * eval or the Function constructor. Passing the option would be silently
 * ignored by pdf.js and rejected by its TypeScript types. So this pins the
 * property the option existed to give: the builds actually loaded contain no
 * eval and no Function constructor (beyond the "return this" global-object
 * fallback, which is never reached where globalThis exists), and have no
 * isEvalSupported option. If a pdf.js with an eval path is ever installed, for
 * example by a downgrade, this fails, and the fix is the option at every call
 * site listed in P3.
 *
 * Builds checked: the client's pdfjs-dist legacy build and its worker (the
 * ones join-as-talent and the admin bulk upload import), and unpdf's own
 * bundled pdf.js (the server's extraction, lib/pdf-text.ts).
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "src");

const BUILDS = [
  "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  "node_modules/unpdf/dist/pdfjs.mjs",
];

/** The one Function(...) allowed: core-js's global-object fallback. */
const GLOBAL_FALLBACK = /Function\(\s*["']return this["']\s*\)\s*\(\)/g;

/** Every eval path in a build's text, as short descriptions. Empty means none. */
function evalPaths(text) {
  const t = text.replace(GLOBAL_FALLBACK, "");
  const found = [];
  for (const m of t.matchAll(/(?<![\w$.])eval\s*\(/g)) found.push(`eval( at ${m.index}`);
  for (const m of t.matchAll(/\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*["'`]/g)) {
    found.push(`${m[0]} at ${m.index}`);
  }
  if (t.includes("isEvalSupported")) found.push("an isEvalSupported option");
  return found;
}

test("P1. pdfjs-dist is a version without the option (6 or later)", () => {
  const { version } = JSON.parse(
    readFileSync(join(ROOT, "node_modules/pdfjs-dist/package.json"), "utf8"),
  );
  assert.ok(Number(version.split(".")[0]) >= 6, `pdfjs-dist ${version}`);
});

test("P2. every pdf.js build the app loads has no eval, no Function constructor and no isEvalSupported", () => {
  for (const rel of BUILDS) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(text.length > 100_000, `${rel} is the real build`);
    assert.deepEqual(evalPaths(text), [], rel);
  }
});

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["node_modules", "test-support", "__fixtures__"].includes(name)) continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

test("P3. every PDF entry point is one of the three that load the builds in P2", () => {
  const sites = [];
  for (const p of sourceFiles(SRC)) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/\b(getDocument|getDocumentProxy)\s*\(/g)) {
      sites.push(`${relative(ROOT, p)} ${m[1]}`);
    }
  }
  assert.deepEqual(sites.sort(), [
    "src/app/admin/_components/bulk-upload-shared.tsx getDocument",
    "src/app/join-as-talent/page.tsx getDocument",
    "src/lib/pdf-text.ts getDocumentProxy",
  ]);
  for (const f of [
    "src/app/admin/_components/bulk-upload-shared.tsx",
    "src/app/join-as-talent/page.tsx",
  ]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.match(text, /import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/, f);
    assert.match(text, /"pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs"/, f);
  }
  assert.match(readFileSync(join(SRC, "lib/pdf-text.ts"), "utf8"), /await import\("unpdf"\)/);
});

test("P4. negative control: an eval or a Function constructor in a build is caught", () => {
  const real = readFileSync(join(ROOT, BUILDS[0]), "utf8");
  assert.deepEqual(evalPaths(real), []);
  assert.equal(evalPaths(`${real}\n;eval(font.code);`).length, 1);
  assert.equal(evalPaths(`${real}\n;const f = new Function("c", body);`).length, 1);
  assert.equal(evalPaths(`${real}\n;const opts = { isEvalSupported: true };`).length, 1);
  // The global fallback alone is not an eval path.
  assert.deepEqual(evalPaths(`${real}\n;var g = Function("return this")();`), []);
});
