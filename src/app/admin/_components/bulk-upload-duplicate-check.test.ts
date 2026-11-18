/**
 * The admin bulk CV upload stops when duplicate checking fails, in the modal
 * and in the per-row submit behind it.
 *
 *   node --test src/app/admin/_components/bulk-upload-duplicate-check.test.ts
 *
 * Source pins, not renders. The modal needs a browser (file reading, PDF
 * parsing) and the per-row route a multipart upload and storage; the shared
 * check itself runs for real in src/lib/contact-duplicates.test.ts, and the
 * review-step route in api/check-duplicate-bulk/route.test.ts. These pins hold
 * the wiring around them, and fail on wording as well as on behaviour.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const modal = readFileSync(new URL("./bulk-batch-upload-modal.tsx", import.meta.url), "utf8");
const perRow = readFileSync(
  new URL("../../api/batch-candidate-cv/route.ts", import.meta.url),
  "utf8",
);

// Negative control: put back `if (checkRes.ok) { … } } catch { /* non-fatal */ }` and these fail.
test("the modal's check fails closed: a bad answer is null, never a set of new rows", () => {
  const fn = modal.slice(modal.indexOf("async function checkDuplicates("));
  const body = fn.slice(0, fn.indexOf("\n  }\n") + 4);
  assert.match(body, /if \(!checkRes\.ok\) return null;/);
  assert.match(
    body,
    /results\.length !== target\.length\) return null;/,
    "an answer must cover every row",
  );
  assert.match(body, /\} catch \{\n\s+return null;\n\s+\}/);
  assert.doesNotMatch(modal, /non-fatal/i);
});

// Negative control: drop the guard in submitSelected and an unchecked batch can be sent.
test("a failed check blocks every submit until a re-check succeeds", () => {
  assert.match(
    modal,
    /const checked = await checkDuplicates\(built\);\n\s+setDuplicateCheck\(checked \? "ok" : "failed"\);/,
  );
  const submit = modal.slice(modal.indexOf("async function submitSelected()"));
  assert.match(submit.slice(0, 200), /if \(duplicateCheck !== "ok"\) return;/);
  assert.match(
    modal,
    /disabled=\{submitting \|\| selectedRows === 0 \|\| duplicateCheck !== "ok"\}/,
  );
  assert.equal((modal.match(/onClick=\{submitSelected\}/g) ?? []).length, 1, "one way to submit");
  assert.match(modal, /onClick=\{recheckDuplicates\}/);
  assert.match(
    modal,
    /We couldn&apos;t check these candidates for duplicates, so nothing can be\s+submitted yet\./,
  );
});

// Negative control: move the findContactDuplicate block below the storage upload and the order fails.
test("the per-row submit checks with no application scope, and stops with 503 before uploading", () => {
  assert.match(
    perRow,
    /findContactDuplicate\(supabase, \{ email: email \?\? "", phone: phone \?\? "" \}\)/,
  );
  assert.doesNotMatch(perRow, /applicationScope/, "its scope is unchanged: none");
  const check = perRow.indexOf("const lookup = await findContactDuplicate(");
  const refuse = perRow.indexOf("if (!lookup.ok) {");
  const upload = perRow.indexOf("await supabase.storage");
  assert.ok(check > 0 && refuse > check && upload > refuse, "check, then refuse, then upload");
  assert.match(perRow.slice(refuse, refuse + 400), /\{ status: 503 \}/);
  assert.doesNotMatch(
    perRow,
    /\.or\(orFilter\)|email\.eq\.\$\{email\}/,
    "no hand-built filter left",
  );
});
