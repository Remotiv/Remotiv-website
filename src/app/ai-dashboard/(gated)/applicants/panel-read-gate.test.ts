/**
 * The Split panel's detail read on fast page turns (C1).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/panel-read-gate.test.ts"
 *
 * Staging, 20 page turns clicked as each page landed: 20 panel reads before,
 * 1 after; list reads unchanged at 20. An automatic pick (the first row of a
 * page that just landed) is read only after the list has settled and the pick
 * has held for AUTO_PANEL_READ_DELAY_MS; a choice the reader made (a click, a
 * step, the sheet opening, a deep link) is read at once. And the selection
 * shown in a render is derived in that render, so the panel never unmounts
 * for the frame between a page landing and the auto-select effect (19 such
 * flashes in 20 turns before). Source pins; the staging run is the behaviour.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
/** Code only: comments may name the things the code must not do. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const fn = (name) => {
  const at = code.indexOf(`const ${name} = useCallback(`);
  assert.ok(at > -1, `${name} not found`);
  return code.slice(at, code.indexOf("\n  );", at));
};

test("an automatic pick waits for a settled list and a short hold; a page turn cancels it", () => {
  assert.match(code, /const AUTO_PANEL_READ_DELAY_MS = 400;/);
  const gate = code.slice(
    code.indexOf("const [panelReadId, setPanelReadId]"),
    code.indexOf("const [splitRead, setSplitRead]"),
  );
  assert.match(
    gate,
    /if \(panelReadNow\.current\) \{\s*panelReadNow\.current = false;\s*setPanelReadId\(panelId\);\s*return;\s*\}/,
  );
  assert.match(gate, /if \(pageView\.updating\) return;/);
  assert.match(
    gate,
    /const t = setTimeout\(\(\) => setPanelReadId\(panelId\), AUTO_PANEL_READ_DELAY_MS\);\s*return \(\) => clearTimeout\(t\);/,
  );
  assert.match(gate, /\}, \[panelId, pageView\.updating\]\);/);
});

test("the read itself is keyed to the gated id, so an in-flight read is never dropped by a list update", () => {
  const read = code.slice(
    code.indexOf("const [splitRead, setSplitRead]"),
    code.indexOf("const splitRow = panelId"),
  );
  assert.match(
    read,
    /if \(!panelReadId\) return;[\s\S]*const id = panelReadId;\s*fetchCompanyApplicant\(id\)/,
  );
  assert.match(read, /\}, \[panelReadId, landingJobId, setFilters\]\);/);
  assert.doesNotMatch(read, /pageView\.updating/);
});

test("a choice the reader made reads at once: click, step, sheet, deep link, first load", () => {
  assert.match(code, /const panelReadNow = useRef\(true\);/, "the first load reads at once");
  assert.match(fn("selectSplit"), /panelReadNow\.current = true;\s*setSplitId\(id\);/);
  assert.match(fn("openSheet"), /panelReadNow\.current = true;\s*setSheetId\(id\);/);
  assert.match(fn("stepOpen"), /panelReadNow\.current = true;\s*setSheetId\(id\);/);
  assert.match(
    code,
    /useEffect\(\(\) => \{\s*if \(deepLinkId\) panelReadNow\.current = true;\s*\}, \[deepLinkId\]\);/,
  );
});

test("the shown selection is derived in render, so the panel never unmounts between pages", () => {
  assert.match(
    code,
    /const shownSplitId = splitWide\s*\?\s*autoSplitSelection\(splitId, pagedIds \? pagedIds\.split\(","\) : \[\], deepLinkId\)\s*:\s*splitId;/,
  );
  assert.match(code, /const panelId = splitWide \? shownSplitId : sheetId;/);
  assert.match(
    code,
    /selected=\{\(splitWide \? shownSplitId : \(sheetId \?\? openId\)\) === r\.id\}/,
  );
});
