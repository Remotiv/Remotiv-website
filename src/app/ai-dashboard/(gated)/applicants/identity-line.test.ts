/**
 * The identity line under the applicant's name (panel, sheet and drawer).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/identity-line.test.ts"
 *
 * QA 15 Nov: at 375 the email shrank to zero width and the line opened with a
 * separator ("• Applied …"). Below 640px the email, location and applied date
 * now stack one per line with no separators; from 640px they sit on one line
 * with a dot BETWEEN items. Synthetic data only.
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
const { IdDot } = await import("./_drawer-parts.tsx");
const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

test("the separator is hidden below 640px and shown from 640px, never announced", () => {
  const html = renderToStaticMarkup(createElement(IdDot));
  assert.match(html, /aria-hidden="true"/);
  const cls = html.match(/class="([^"]+)"/)[1].split(/\s+/);
  assert.ok(cls.includes("hidden"), "visible on narrow screens again");
  assert.ok(cls.includes("min-[640px]:block"), "no longer shown on wide screens");
});

test("below 640px the line stacks; from 640px it is one row with dots between items", () => {
  const at = client.indexOf("{/* Email, then whichever of location and applied date exist.");
  assert.ok(at > -1, "identity line not found");
  const block = client.slice(at, client.indexOf("</div>", at));
  assert.match(
    block,
    /className="mt-1 flex flex-col items-start gap-0\.5 [^"]*min-\[640px\]:flex-row min-\[640px\]:items-center min-\[640px\]:gap-\[9px\]"/,
  );
  assert.match(block, /<b className="max-w-full truncate [^"]*">\{row\.email\}<\/b>/);
  // Every dot sits AFTER an item and BEFORE another: email, [dot location], dot date.
  const order = [...block.matchAll(/\{row\.email\}|<IdDot \/>|\{location\}|Applied \{fmtDay/g)].map(
    (m) => m[0],
  );
  assert.deepEqual(order, [
    "{row.email}",
    "<IdDot />",
    "{location}",
    "<IdDot />",
    "Applied {fmtDay",
  ]);
});
