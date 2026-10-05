/**
 * The Plans & Rates table's rules: status labels, search, the status filter,
 * the counts beside it, and pages of twenty.
 *
 *   node --test src/lib/plans-table.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));

const {
  countByFilter,
  filterCompanies,
  formatRate,
  limitLabel,
  PAGE_SIZE,
  PLAN_STATUS_LABEL,
  paginate,
  planStatus,
} = await import("./plans-table.ts");

const PLAN = { planName: "Starter" };
const row = (name, { internal = false, plan = null } = {}) => ({
  name,
  isInternal: internal,
  plan,
});

/* ── status ─────────────────────────────────────────────────────── */

test("the three statuses and their labels", () => {
  assert.equal(planStatus(row("A", { internal: true })), "internal");
  assert.equal(planStatus(row("B")), "no_plan");
  assert.equal(planStatus(row("C", { plan: PLAN })), "on_plan");
  assert.deepEqual(PLAN_STATUS_LABEL, {
    internal: "Internal - exempt",
    no_plan: "No plan - unlimited",
    on_plan: "On plan",
  });
});

test("internal wins over a plan: an internal company is exempt whatever its plan says", () => {
  assert.equal(planStatus(row("Remotiv", { internal: true, plan: PLAN })), "internal");
});

/* ── search and filter ──────────────────────────────────────────── */

const ROWS = [
  row("Acme Hiring", { plan: PLAN }),
  row("Beta Labs"),
  row("acme partners"),
  row("Remotiv", { internal: true }),
];

test("search is a case-insensitive match on the name; blank matches everyone", () => {
  assert.deepEqual(
    filterCompanies(ROWS, "ACME", "all").map((r) => r.name),
    ["Acme Hiring", "acme partners"],
  );
  assert.equal(filterCompanies(ROWS, "   ", "all").length, 4);
  assert.equal(filterCompanies(ROWS, "zzz", "all").length, 0);
});

test("each filter keeps only its status, and combines with search", () => {
  const names = (f, q = "") => filterCompanies(ROWS, q, f).map((r) => r.name);
  assert.deepEqual(names("on_plan"), ["Acme Hiring"]);
  assert.deepEqual(names("no_plan"), ["Beta Labs", "acme partners"]);
  assert.deepEqual(names("internal"), ["Remotiv"]);
  assert.deepEqual(names("no_plan", "acme"), ["acme partners"]);
});

test("the counts beside each filter follow the search", () => {
  assert.deepEqual(countByFilter(ROWS, ""), { all: 4, on_plan: 1, no_plan: 2, internal: 1 });
  assert.deepEqual(countByFilter(ROWS, "acme"), { all: 2, on_plan: 1, no_plan: 1, internal: 0 });
});

/* ── pages of twenty ────────────────────────────────────────────── */

const many = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("twenty to a page, with the last page partial", () => {
  assert.equal(PAGE_SIZE, 20);
  const p1 = paginate(many(52), 1);
  assert.deepEqual([p1.rows.length, p1.from, p1.to, p1.total, p1.pageCount], [20, 1, 20, 52, 3]);
  const p3 = paginate(many(52), 3);
  assert.deepEqual(
    [p3.rows, p3.from, p3.to],
    [[41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52], 41, 52],
  );
});

test("a page past the end shows the last page; below one shows the first", () => {
  assert.equal(paginate(many(52), 9).page, 3);
  assert.equal(paginate(many(52), 0).page, 1);
  assert.equal(paginate(many(52), -4).page, 1);
  // A filter that shrinks the list never strands the view on an empty page.
  assert.equal(paginate(many(5), 3).page, 1);
});

test("no rows is page 1 of 1, showing nothing", () => {
  assert.deepEqual(paginate([], 1), { rows: [], page: 1, pageCount: 1, total: 0, from: 0, to: 0 });
});

/* ── display ────────────────────────────────────────────────────── */

test("a blank limit reads Unlimited, never zero; a rate keeps its precision", () => {
  assert.equal(limitLabel(null), "Unlimited");
  assert.equal(limitLabel(0), "0");
  assert.equal(limitLabel(1500), "1,500");
  // A two-place money formatter would show 0.033 as $0.03.
  assert.equal(formatRate(0.033), "$0.033");
  assert.equal(formatRate(45), "$45.00");
  assert.equal(formatRate(0.0155), "$0.0155");
});

test("the Quote Builder's Rates used shows each entered rate through formatRate, so 0.033 reads $0.033", async () => {
  const { formatUsd } = await import("./plans-usage-types.ts");
  // The two-place formatter is what the list used before, and it hides the third place.
  assert.equal(formatUsd(0.033), "$0.03");
  assert.equal(formatRate(0.033), "$0.033");

  const builder = readFileSync(
    new URL("../app/admin/companies/_quote-builder.tsx", import.meta.url),
    "utf8",
  );
  assert.match(builder, /import \{ formatRate \} from "@\/lib\/plans-table";/);
  const rate = builder.slice(
    builder.indexOf("function Rate("),
    builder.indexOf("export function QuoteBuilder("),
  );
  assert.match(rate, /\{formatRate\(value\)\} \{unit\}/);
  assert.doesNotMatch(rate, /formatUsd/);
  const ratesUsed = builder.slice(builder.indexOf("Rates used"), builder.indexOf("</dl>"));
  for (const field of [
    "cvScoreCost",
    "asyncInterviewCost",
    "whatsappMessageCost",
    "minimumPrice",
  ]) {
    assert.match(ratesUsed, new RegExp(`<Rate value=\\{rates\\.${field}\\}`), field);
  }
  assert.match(ratesUsed, /formatRate\(rates\.fixedMonthlyCost\)/);
  // The one two-place figure left is the per-client share, a computed amount, not an entered rate.
  assert.deepEqual(ratesUsed.match(/formatUsd\([^)]*\)/g), [
    "formatUsd(rates.fixedMonthlyCost / Math.max(1, rates.clientsSharingFixedCost)",
  ]);
});
