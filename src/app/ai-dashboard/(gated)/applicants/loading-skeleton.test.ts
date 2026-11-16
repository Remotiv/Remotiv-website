/**
 * The Applicants loading skeleton in the Split shape (C3).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/loading-skeleton.test.ts"
 *
 * Built from the page's own wrappers (SplitLayout, the toolbar card,
 * SplitListColumn, the panel frame) with the real page's measured heights, so
 * the page drops into the skeleton's boxes. On staging the estimated layout
 * shift from skeleton to page was 0.0000 at 1440 / 1100 / 840 and 0.0014 at
 * 375 (it was 0.0017 / 0.0147 / 0.0183 / 0.0349 before the hero heights).
 * With the kill switch on, the old page's skeleton. Synthetic only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: Loading } = await import("./loading.tsx");
const { PANEL_FRAME } = await import("./_split-panel.tsx");

function render(disabled) {
  const saved = process.env.APPLICANTS_SPLIT_DISABLED;
  if (disabled) process.env.APPLICANTS_SPLIT_DISABLED = "1";
  else delete process.env.APPLICANTS_SPLIT_DISABLED;
  try {
    return renderToStaticMarkup(createElement(Loading));
  } finally {
    if (saved === undefined) delete process.env.APPLICANTS_SPLIT_DISABLED;
    else process.env.APPLICANTS_SPLIT_DISABLED = saved;
  }
}

test("Split by default: the page's own wrappers, list column and a panel column", () => {
  const html = render(false);
  assert.match(html, /data-applicants-skeleton="split"/);
  assert.match(html, /data-split-layout/);
  assert.match(html, /data-split-list-column/);
  assert.match(html, /data-skeleton-panel/);
  assert.ok(html.includes(PANEL_FRAME), "the panel column is not the real panel frame");
});

test("list rows in the Split row shape, six of them, 90px like the real rows", () => {
  const html = render(false);
  const rows =
    html.match(
      /grid grid-cols-\[40px_minmax\(0,1fr\)_auto\] items-center gap-3 border-b [^"]*px-5 py-\[13px\]/g,
    ) ?? [];
  assert.equal(rows.length, 6);
  assert.match(html, /flex h-16 min-w-0 flex-col justify-center gap-2/, "13 + 64 + 13 = 90px");
});

test("the measured heights: hero 293 / 276 / 149, header lede and toolbar as they wrap", () => {
  const html = render(false);
  assert.match(html, /h-\[293px\][^"]*min-\[640px\]:h-\[276px\][^"]*min-\[1180px\]:h-\[149px\]/);
  assert.match(html, /h-\[71px\][^"]*min-\[1100px\]:h-\[47px\]/);
  assert.match(html, /h-\[107px\][^"]*min-\[640px\]:h-\[74px\][^"]*min-\[1100px\]:h-\[42px\]/);
  assert.match(html, /h-\[82px\][^"]*min-\[640px\]:h-\[37px\]/);
});

test("avatars and rings are circles, not rounded squares", () => {
  const html = render(false);
  assert.match(html, /animate-pulse bg-\[var\(--ai-line-soft\)\] rounded-full size-10"/);
  assert.match(html, /animate-pulse bg-\[var\(--ai-line-soft\)\] rounded-full size-\[38px\]"/);
  assert.doesNotMatch(html, /rounded-lg[^"]*rounded-full/);
});

test("the kill switch (APPLICANTS_SPLIT_DISABLED=1) keeps the old page's skeleton", () => {
  const html = render(true);
  assert.doesNotMatch(html, /data-applicants-skeleton|data-split-layout|data-skeleton-panel/);
  assert.match(
    html,
    /flex items-center gap-3\.5 border-b border-\[var\(--ai-line-soft\)\] px-5 py-\[13px\] last:border-b-0/,
  );
});
