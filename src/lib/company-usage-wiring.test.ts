/**
 * The client usage view, from the source: one session-scoped way in, the same
 * rows and month as enforcement, no month math of its own, the price never
 * selected for a role that may not see it, and read-only surfaces.
 *
 *   node --test src/lib/company-usage-wiring.test.ts
 *
 * Behaviour is run in company-usage.test.ts and company-usage-view.test.ts.
 * These pins catch what a behavioural test cannot: a second reader, a client
 * component calling the loader, a hand-rolled month, copy drifting.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });

/** Code only: comments may name a thing to say it is not done. */
const strip = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FILES = walk(SRC)
  .filter((p) => !p.includes(join("src", "test-support")))
  .map((p) => {
    const raw = readFileSync(p, "utf8");
    return { rel: relative(ROOT, p), raw, text: strip(raw) };
  });
const file = (rel) => {
  const f = FILES.find((x) => x.rel === rel);
  assert.ok(f, `missing ${rel}`);
  return f;
};

const G = "src/app/ai-dashboard/(gated)/";
const READER = "src/lib/company-usage.ts";
const RULES = "src/lib/company-usage-types.ts";
const LOADER = "src/app/ai-dashboard/lib/company-usage-view.ts";
const CARD = `${G}settings/_plan-usage-card.tsx`;
const METER = `${G}_usage-meter.tsx`;
const BANNER = `${G}applicants/_quota-banner.tsx`;
const NEW_FILES = [READER, RULES, LOADER, CARD, METER, BANNER];

/* ── one way in, scoped to the session ──────────────────────────── */

test("the loaders take no company, are not server actions, and decide the role before reading", () => {
  const { text } = file(LOADER);
  assert.doesNotMatch(
    text,
    /^\s*["']use server["']/m,
    "a server action could be called from the browser",
  );
  const fns = [...text.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
  assert.deepEqual(
    fns.map((m) => [m[1], m[2]]),
    [
      ["loadSettingsUsage", ""],
      ["loadOverviewUsage", ""],
      ["loadApplicantsUsage", ""],
    ],
  );
  for (const [name, surface] of [
    ["loadSettingsUsage", "settingsCard"],
    ["loadOverviewUsage", "overviewMeter"],
    ["loadApplicantsUsage", "applicantsBanner"],
  ]) {
    const start = text.indexOf(`export async function ${name}(`);
    const next = text.indexOf("export async function", start + 1);
    const body = text.slice(start, next < 0 ? undefined : next);
    const order = [
      "const ctx = await getCompanyContext();",
      "const may = usageSurfacesFor(ctx.role);",
      `if (!may.${surface}) return null;`,
      "await readCompanyUsage(createServiceClient(), ctx.companyId, {",
    ];
    let last = -1;
    for (const step of order) {
      const i = body.indexOf(step, last + 1);
      assert.ok(i > last, `${name}: out of order or missing: ${step}`);
      last = i;
    }
    // The price is asked for only on the Settings card, and only by permission.
    const price = body.match(/includePrice: ([^,\n}]+)/)[1].trim();
    assert.equal(price, name === "loadSettingsUsage" ? "may.price" : "false", name);
  }
});

test("only the loader calls the reader, and only pages call the loader; no client component does", () => {
  const readerCallers = FILES.filter((f) => /\breadCompanyUsage\(/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(readerCallers.sort(), [LOADER, READER].sort());
  const loaderUsers = FILES.filter((f) => /company-usage-view["']/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(loaderUsers.sort(), [
    `${G}applicants/page.tsx`,
    `${G}page.tsx`,
    `${G}settings/page.tsx`,
  ]);
  for (const f of FILES.filter((x) => /^["']use client["']/m.test(x.raw))) {
    assert.doesNotMatch(f.text, /company-usage-view|lib\/company-usage["']/, f.rel);
  }
  // The price permission is the existing billing rule, not a new one.
  assert.match(file(RULES).text, /price: canManageBilling\(role\),/);
});

test("the pages render the finished element, so figures never sit in client state", () => {
  assert.match(
    file(`${G}settings/page.tsx`).text,
    /const planUsage = await loadSettingsUsage\(\);/,
  );
  assert.match(
    file(`${G}settings/page.tsx`).text,
    /planUsage=\{planUsage && <PlanUsageCard view=\{planUsage\} \/>\}/,
  );
  assert.match(file(`${G}page.tsx`).text, /loadOverviewUsage\(\),/);
  assert.match(file(`${G}page.tsx`).text, /usageMeter=\{usage && <UsageMeter view=\{usage\} \/>\}/);
  assert.match(file(`${G}applicants/page.tsx`).text, /loadApplicantsUsage\(\),/);
  assert.match(
    file(`${G}applicants/page.tsx`).text,
    /quotaBanner=\{quota && <QuotaBanner view=\{quota\} \/>\}/,
  );
});

/* ── the same rows and month as enforcement ─────────────────────── */

test("the reader counts usage_events by type from the shared Karachi month start, summing quantity", () => {
  const { text } = file(READER);
  assert.match(text, /const monthStart = karachiMonthWindow\(now\)\.startIso;/);
  assert.match(
    text,
    /\.from\("usage_events"\)\s*\.select\("quantity"\)\s*\.eq\("company_id", companyId\)\s*\.eq\("type", type\)\s*\.gte\("created_at", monthStart\)/,
  );
  assert.match(text, /sum \+ \(r\.quantity \?\? 0\)/);
  assert.match(text, /usage\("cv_scored"\),\s*usage\("interview_sent"\),/);
  assert.match(text, /resetDate: allowanceResetDate\(now\),/);
  // Never a scorecard, session or completion count; never a write or an allowance call.
  assert.doesNotMatch(text, /interview_sessions|ai_scorecards|scorecard|submitted_at/);
  assert.doesNotMatch(text, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.doesNotMatch(text, /consume_allowance|release_allowance/);
});

test("no file in this feature works out a month or a reset date for itself", () => {
  for (const rel of NEW_FILES) {
    const { text } = file(rel);
    assert.doesNotMatch(
      text,
      /Date\.UTC|Intl\.DateTimeFormat|["']Asia\/Karachi["']|setMonth|getMonth|getUTCMonth|toLocaleDateString/,
      rel,
    );
  }
});

test("the quoted price is selected in one place, behind the permission flag", () => {
  const holders = FILES.filter(
    (f) => f.rel.startsWith("src/app/ai-dashboard/") || NEW_FILES.includes(f.rel),
  ).filter((f) => /quoted_price/.test(f.text));
  assert.deepEqual(
    holders.map((f) => f.rel),
    [READER],
  );
  assert.match(
    file(READER).text,
    /\.select\(options\.includePrice \? `\$\{BASE_PLAN_COLUMNS\}, \$\{PRICE_COLUMNS\}` : BASE_PLAN_COLUMNS\)/,
  );
  assert.doesNotMatch(file(READER).text.match(/const BASE_PLAN_COLUMNS = [^;]+;/)[0], /price/);
  // The card shows a price row only when the server sent one.
  assert.match(file(CARD).text, /\{view\.price && \(/);
});

/* ── read-only surfaces and copy ────────────────────────────────── */

test("the card, meter and banner are server-rendered, read-only, and offer no upgrade", () => {
  for (const rel of [CARD, METER, BANNER]) {
    const { raw, text } = file(rel);
    assert.doesNotMatch(raw, /["']use client["']/, rel);
    assert.doesNotMatch(text, /<form|<button|onClick|<input/, rel);
    assert.doesNotMatch(text, /@\/lib\/supabase|lib\/company-usage["']|company-usage-view/, rel);
    assert.doesNotMatch(text, /upgrade|buy now|checkout|payment|pricing/i, rel);
    // Live AI is not metered yet, so it is not shown.
    assert.doesNotMatch(text, /live ai|live interview|liveMinutes|live_minutes/i, rel);
  }
  assert.match(file(CARD).text, /\{NEED_MORE\}/);
  assert.match(file(CARD).text, /\{planName \?\? UNLIMITED_THIS_MONTH\}/);
  assert.match(file(CARD).text, /\{view\.resetDate\}, \{BILLING_TIME_ZONE\}/);
  assert.match(file(CARD).text, /\{USAGE_LOAD_ERROR\}/);
  assert.match(file(METER).text, /\{USAGE_LOAD_ERROR\}/);
  assert.match(file(METER).text, /view\.kind === "meter" && view\.linksToCard && \(/);
});

test("hyphens, never em dashes, in the copy this feature adds", () => {
  for (const rel of NEW_FILES) {
    assert.doesNotMatch(file(rel).raw, /—/, rel);
  }
});
