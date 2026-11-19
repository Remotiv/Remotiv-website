/**
 * #47: the Split panel (1100+) and the sheet (below) are never blank while
 * their applicant loads. They hold the panel's skeleton in the real frame.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/panel-loading.test.ts"
 *
 * The cause, measured on staging: useSplitWide() is false on the server and
 * through hydration, so the server HTML had the panel column EMPTY until the
 * page hydrated; and a deep link to an applicant off the current page had no
 * row to show until its own read landed, so the panel (or, below 1100, the
 * sheet) rendered nothing. The skeletons render here, server side; the
 * client's choice of when is pinned from its source. The staging run with
 * timings is the behaviour.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PanelSkeletonBody, SplitPanelSkeleton, SplitSkeleton } = await import(
  "./_split-skeleton.tsx"
);
const { SplitSheetSkeleton } = await import("./_split-sheet.tsx");
const { PANEL_FRAME } = await import("./_split-panel.tsx");

const html = (el) => renderToStaticMarkup(el);
const body = html(createElement(PanelSkeletonBody));

test("K1. the panel skeleton is the real panel's frame, busy, with the panel's shape inside", () => {
  const out = html(createElement(SplitPanelSkeleton));
  assert.match(
    out,
    /^<aside aria-busy="true" aria-label="Loading applicant" class="([^"]+)" data-split-panel-skeleton="true">/,
  );
  assert.equal(
    /class="([^"]+)"/.exec(out)[1],
    PANEL_FRAME,
    "same box as the panel, so nothing moves",
  );
  assert.ok(out.includes(body));
  assert.ok((out.match(/animate-pulse/g) ?? []).length >= 6);
  // A page column like the panel: no focus trap (the sheet skeleton has one).
  const skeletonSrc = readFileSync(new URL("./_split-skeleton.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(skeletonSrc, /useModalFocus/);
});

test("K2. the sheet skeleton: the sheet's frame and Back, the same body; the server copy hides at 1100+", () => {
  const onClose = () => {};
  const out = html(createElement(SplitSheetSkeleton, { onClose }));
  assert.match(
    out,
    /role="dialog" aria-modal="true" aria-busy="true" aria-label="Loading applicant"/,
  );
  assert.match(out, /data-split-sheet-skeleton/);
  assert.match(out, /data-split-sheet-back[^>]*>.*Back to applicants<\/button>/);
  assert.match(
    out,
    /class="fixed inset-x-0 top-0 z-\[90\] flex h-\[var\(--vh-full\)\] w-full flex-col/,
  );
  assert.ok(out.includes(body));
  assert.doesNotMatch(out, /min-\[1100px\]:hidden/);
  const server = html(createElement(SplitSheetSkeleton, { onClose, wideHidden: true }));
  assert.match(server, /min-\[1100px\]:hidden/);
});

test("K3. the route skeleton waits in the same panel shape", () => {
  assert.ok(html(createElement(SplitSkeleton)).includes(body));
});

const src = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

test("K4. the panel column: the panel, else its skeleton whenever a panel is coming, else nothing", () => {
  assert.match(
    src,
    /const panelLoading = paged\.length > 0 && \(splitWide \? panelId !== null : !hydrated\);/,
  );
  assert.match(
    src,
    /splitProps && splitWide \? \(\s*<SplitPanel key=\{splitProps\.row\.id\} \{\.\.\.splitProps\} \/>\s*\) : panelLoading \? \(\s*<SplitPanelSkeleton \/>\s*\) : null;/,
  );
});

test("K5. the sheet: the sheet, else its skeleton for a sheet id, else the server's copy for a deep link", () => {
  assert.match(
    src,
    /const splitSheet = splitWide \? null : sheetId \? \(\s*splitProps \? \([\s\S]*?<SplitSheet key=\{`sheet-\$\{splitProps\.row\.id\}`\}[\s\S]*?\) : \(\s*<SplitSheetSkeleton key="sheet-loading" onClose=\{closeSheet\} \/>\s*\)\s*\) : !hydrated && deepLinkId \? \([\s\S]*?<SplitSheetSkeleton key="sheet-loading" onClose=\{closeSheet\} wideHidden \/>\s*\) : null;/,
  );
});

test("K6. data and behaviour untouched: the read gate, the hold and its cap are as they were", () => {
  assert.match(src, /const AUTO_PANEL_READ_DELAY_MS = 400;/);
  const hold = readFileSync(new URL("./split-hold.ts", import.meta.url), "utf8");
  assert.match(hold, /export const SPLIT_HOLD_CAP_MS = 8000;/);
  assert.match(src, /reading: splitReading\(splitRow\.id, splitRead\?\.id, holdExpiredId\),/);
});

test("K7. ?applicant= reaches the sheet in the hydration commit: a layout effect, not a passive one", () => {
  assert.match(
    src,
    /useLayoutEffect\(\(\) => \{\s*\/\/ 1100\+: \?applicant= names the panel's applicant, not an open drawer\.[\s\S]*?setSheetId\(deepLinkId\);[\s\S]*?\}, \[deepLinkId\]\);/,
  );
});
