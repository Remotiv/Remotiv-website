/**
 * `?tab=` belongs to the old drawer alone, and only for a non-default tab (A3).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/panel-tab-url.test.ts"
 *
 * QA 15 Nov: a Split row click wrote `?applicant=<id>&tab=profile` with no
 * drawer open. Now Profile (the default) is never written, the Split panel and
 * sheet write no tab at all, and closing the drawer under Split drops the
 * drawer's `?tab=` while keeping `?applicant=`. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { DEFAULT_PANEL_TAB, encodePanelUrl } = await import("./list-state.ts");
const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
const body = (name) => {
  const at = client.indexOf(`const ${name} = useCallback(`);
  assert.ok(at > -1, `${name} not found`);
  return client.slice(at, client.indexOf("\n  );", at));
};

test("the default tab is Profile and is never written", () => {
  assert.equal(DEFAULT_PANEL_TAB, "profile");
  assert.equal(encodePanelUrl("", "app-1", "profile"), "applicant=app-1");
  assert.equal(
    encodePanelUrl("applicant=app-1&tab=profile", "app-1", "profile"),
    "applicant=app-1",
  );
});

test("a non-default drawer tab is written, so a refresh reopens it there", () => {
  assert.equal(encodePanelUrl("", "app-1", "review"), "applicant=app-1&tab=review");
  assert.equal(encodePanelUrl("job=all", "app-1", "comm"), "job=all&applicant=app-1&tab=comm");
});

test("no tab argument (the Split panel and sheet) writes the applicant alone and clears a stale tab", () => {
  assert.equal(encodePanelUrl("applicant=app-0&tab=review", "app-2", null), "applicant=app-2");
});

test("Split: a row click, a sheet open and closing the drawer carry no tab", () => {
  assert.match(body("selectSplit"), /syncPanelUrl\(id, null\);/);
  assert.match(body("openSheet"), /encodePanelUrl\(window\.location\.search, applicantId, null\)/);
  assert.match(
    body("closePanel"),
    /syncPanelUrl\(new URLSearchParams\(window\.location\.search\)\.get\("applicant"\), null\);/,
  );
  assert.doesNotMatch(body("openSheet"), /panelTab/);
  assert.doesNotMatch(
    body("closePanel"),
    /panelTab/,
    "closing the drawer never writes its tab back",
  );
});
