/**
 * Must-have colours per v9 (section 2, "Must-haves"), in the Split panel and
 * the old drawer alike: both render the shared MustHavesBox / MustHaveRows.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/must-have-colours.test.ts"
 *
 * Found: the live "Must-haves met" purple check. Not found: a neutral slate
 * minus, the item in grey and a plain "Not found in CV" (no bold, no amber).
 * Mint stays Strengths' colour and amber Risks'. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MustHavesBox } = await import("./_drawer-parts.tsx");

const detail = {
  status: "scored",
  ai_status: "scored",
  must_haves: [
    {
      item: "Five years of TypeScript",
      status: "evidenced",
      quote: "Built TypeScript services for 6 years",
    },
    { item: "Fluent German", status: "not_found", quote: null },
  ],
  job_must_have_count: 2,
};
const html = renderToStaticMarkup(createElement(MustHavesBox, { scoreDetail: detail }));
/** The markup of the row that contains `text`. */
const rowOf = (text) => {
  const at = html.indexOf(text);
  assert.ok(at > -1, `${text} not rendered`);
  const start = html.lastIndexOf('<div class="flex gap-2.5', at);
  return html.slice(start, html.indexOf("</div></div>", at) + 12);
};

test("the pill and the count stay: Must-haves met, 1 of 2", () => {
  assert.match(html, /Must-haves met/);
  assert.match(html, /1 of 2/);
  assert.match(html, /bg-\[var\(--ai-purple-tint\)\] text-\[var\(--ai-purple-ink\)\]/);
});

test("found: the purple check, the item at full colour, and its evidence", () => {
  const row = rowOf("Five years of TypeScript");
  assert.match(row, /bg-\[var\(--ai-purple-tint\)\] text-\[var\(--ai-purple-ink\)\]/);
  assert.doesNotMatch(row, /mint/, "mint is Strengths' colour");
  assert.doesNotMatch(row, /Not found in CV/);
});

test("not found: slate minus, grey item, plain 'Not found in CV', no amber and no bold", () => {
  const row = rowOf("Fluent German");
  assert.match(row, /bg-\[var\(--ai-slate-tint\)\] text-\[var\(--ai-t4\)\]/);
  assert.match(row, /<span class="text-\[var\(--ai-t3\)\]">Fluent German<\/span>/);
  assert.match(row, /font-semibold text-\[var\(--ai-t3\)\]">Not found in CV<\/span>/);
  assert.doesNotMatch(row, /amber|<b[\s>]|not evidenced/);
});
