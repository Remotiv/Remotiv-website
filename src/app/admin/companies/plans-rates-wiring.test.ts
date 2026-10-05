/**
 * Source pins for the Plans & Rates table and drawer. These modules render
 * React and call server actions, so they cannot run under bare node:test; each
 * pin states a wiring fact and the absence of the thing it replaced.
 *
 *   node --test src/app/admin/companies/plans-rates-wiring.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Source with comments removed, so a comment cannot satisfy or trip a pin. */
const code = (rel) =>
  readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const drawer = code("./_plan-drawer.tsx");
const table = code("./_plans-table.tsx");
const history = code("./_plan-history.tsx");
const panel = code("./_rates-panel.tsx");
const pricing = code("./_pricing-settings.tsx");
const editor = code("./_plan-editor.tsx");
const actions = code("./actions.ts");
const reader = code("../../../lib/plans-admin.ts");

test("the drawer uses the shared useModalFocus primitive, with Escape wired to close", () => {
  assert.match(drawer, /import \{ useModalFocus \} from "@\/hooks\/use-modal-focus";/);
  assert.match(drawer, /useModalFocus\(panelRef, true, \{ onClose, overlayRef \}\);/);
  // Not the admin area's older private trap.
  assert.doesNotMatch(drawer, /useFocusTrap/);
});

test("the drawer is a labelled modal dialog with a close button and a scrim", () => {
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby=\{titleId\}/);
  assert.match(drawer, /<h2 id=\{titleId\}/);
  assert.match(drawer, /aria-label="Close"/);
  assert.match(drawer, /aria-label="Close plan"/);
});

test("the drawer holds the existing editor and that company's history, reloaded after a change", () => {
  assert.match(drawer, /<PlanEditor[\s\S]*?onChanged=\{\(\) => setHistoryKey\(\(k\) => k \+ 1\)\}/);
  assert.match(drawer, /<PlanHistory companyId=\{company\.id\} reloadKey=\{historyKey\} \/>/);
  // The editor calls it only after a successful write.
  assert.equal((editor.match(/onChanged\?\.\(\);/g) ?? []).length, 2);
});

test("the drawer is rendered only while open, and never for an internal company", () => {
  assert.match(table, /\{open && <PlanDrawer company=\{open\}/);
  assert.match(table, /companies\.find\(\(c\) => c\.id === openId && !c\.isInternal\)/);
  // Internal rows offer no button at all.
  assert.match(
    table,
    /status === "internal" \? \(\s*<span className="text-sm text-gray-500">Not needed<\/span>/,
  );
});

test("history is read only inside the open drawer, never for the whole table", () => {
  assert.match(
    history,
    /useEffect\(\(\) => \{[\s\S]*?fetchPlanHistory\(companyId\)[\s\S]*?\}, \[companyId, reloadKey\]\);/,
  );
  for (const [name, src] of [
    ["table", table],
    ["panel", panel],
    ["pricing", pricing],
  ]) {
    assert.doesNotMatch(src, /fetchPlanHistory|PlanHistory|readPlanHistory/, name);
  }
  // The table's read no longer carries history; the per-company read does.
  const tableRead = reader.slice(
    reader.indexOf("export async function readPlansAdmin("),
    reader.indexOf("export async function readPlanHistory("),
  );
  assert.ok(tableRead.length > 0);
  assert.doesNotMatch(tableRead, /company_plan_history|admin_users/);
  assert.match(reader, /\.eq\("company_id", companyId\)/);
});

test("fetchPlanHistory is super-admin only and refuses a malformed id before any read", () => {
  const body = actions.slice(actions.indexOf("export async function fetchPlanHistory("));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  const guard = fn.indexOf("await requireSuperAdmin();");
  const idCheck = fn.indexOf("if (!isUuid(companyId))");
  const read = fn.indexOf("readPlanHistory(createServiceClient(), companyId)");
  assert.ok(guard > 0 && guard < idCheck && idCheck < read, "guard, then id check, then read");
});

test("search and filter return to page 1; the table pages by twenty", () => {
  assert.match(table, /setQuery\(e\.target\.value\);\s*setPage\(1\);/);
  assert.match(table, /setFilter\(f\.id\);\s*setPage\(1\);/);
  assert.match(table, /paginate\(filterCompanies\(companies, query, filter\), page\)/);
  assert.match(table, /aria-pressed=\{filter === f\.id\}/);
});

test("the table has the seven columns the brief lists, in order", () => {
  const heads = [...table.matchAll(/<th scope="col" className=\{HEAD\}>\s*([^<]+?)\s*<\/th>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(heads, [
    "Company",
    "Status",
    "Plan",
    "CV scoring limit",
    "Async interview limit",
    "Quoted price",
    "Action",
  ]);
});

test("pricing settings are a summary with an inline disclosure, not a second dialog", () => {
  assert.match(pricing, /aria-expanded=\{open\}/);
  assert.match(pricing, /aria-controls=\{`\$\{formId\}-form`\}/);
  assert.match(pricing, /\{open && <PricingForm rates=\{rates\} \/>\}/);
  assert.doesNotMatch(pricing, /role="dialog"|useModalFocus/);
  // Every unset rate reads "not set", never zero.
  assert.match(pricing, /\{i\.value \?\? "not set"\}/);
});

test("no plan card or form is rendered per company any more", () => {
  assert.doesNotMatch(panel, /PlanEditor|CompanyPlanCard|History/);
  assert.match(panel, /<PlansTable companies=\{result\.companies\}/);
});
