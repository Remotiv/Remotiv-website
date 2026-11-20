/**
 * #65: the Jobs list renders the same on the UTC server and in any browser
 * zone until hydration, so React never throws #418 (hydration text mismatch).
 * After hydration, the reader's own zone and a live "Nd ago". Same rule as the
 * Interviews list (#64).
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/list-dates-hydration.test.ts"
 *
 * JobsClient runs as shipped; only its server actions and next/link and
 * next/navigation are stubbed. Each zone renders in its own process (TZ is read
 * at process start) with the clock frozen at one instant, and the parent
 * compares the whole server-rendered list: cards and table both. Synthetic
 * data only.
 */
// @ts-nocheck - same reason as review-dates-hydration.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const action = (n) => "export async function " + n + "() { return { success: true }; }";
const STUBS = {
  "./actions": ["deleteCompanyJob", "duplicateCompanyJob", "restoreCompanyJob", "setCompanyJobArchived", "updateCompanyJobStatus"].map(action).join("\\n"),
  "./team-actions": ["addToHiringTeam", "fetchAssignableMembers", "fetchHiringTeam", "removeFromHiringTeam", "updateHiringTeamRole"].map(action).join("\\n"),
  "../applicants/actions": action("rescoreJob"),
  "next/navigation": "export function useRouter() { return { refresh() {}, push() {} }; }\\nexport function useSearchParams() { return new URLSearchParams(); }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;
const { JobsClient, fmtPosted } = await import("./_jobs-client.tsx");

// The server's clock: 23:50 UTC. The evening stamps are the next day in
// Karachi (UTC+5); the early one is the day before in Los Angeles (UTC-8).
// POSTED_TODAY crosses a day boundary of "Nd ago" ten minutes after NOW.
const NOW = Date.parse("2026-11-12T23:50:00.000Z");
const POSTED_TODAY = "2026-11-12T00:00:00.000Z";
const POSTED_EVENING = "2026-11-05T21:40:00.000Z";
const POSTED_EARLY = "2026-10-20T03:10:00.000Z";
const EDITED = "2026-11-09T22:15:00.000Z";

function job(n, status, created_at) {
  return {
    id: `j0000000-0000-4000-8000-00000000000${n}`,
    title: `Role ${n}`,
    location: "Remote",
    category: "Engineering",
    experience_level: "Mid",
    contract_type: "Full-time",
    work_type: "Remote",
    status,
    slug: `role-${n}`,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    positions: 1,
    created_at,
    archived_at: null,
    applicant_count: n,
  };
}

const JOBS = [
  job(1, "open", POSTED_TODAY),
  job(2, "open", POSTED_EVENING),
  job(3, "closed", POSTED_EARLY),
  job(4, "on_hold", EDITED),
];

const list = (now) => {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return renderToStaticMarkup(
      createElement(JobsClient, {
        viewerRole: "owner",
        jobs: JOBS,
        deletedJobs: [],
        loadFailed: false,
        deletedLoadFailed: false,
      }),
    );
  } finally {
    Date.now = realNow;
  }
};

// Child mode: render the list in this process's TZ and print it.
if (process.env.JOBS_DATES_PRINT === "1") {
  process.stdout.write(`${JSON.stringify({ html: list(NOW) })}\n`);
  process.exit(0);
}

const ZONES = ["UTC", "Asia/Karachi", "America/Los_Angeles"];
const renders = () =>
  ZONES.map((TZ) => {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ, JOBS_DATES_PRINT: "1" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return [TZ, JSON.parse(out.trim().split("\n").at(-1)).html];
  });

/** Every text node of a render, in order: the unit React compares when it hydrates. */
const texts = (html) =>
  html
    .split(/<[^>]+>/)
    .map((t) => t.trim())
    .filter(Boolean);

// Negative control: put back the old fmtPosted (local date, Date.now() on the
// server) and the Karachi and Los Angeles lists differ from the UTC one.
test("the whole Jobs list renders identically in UTC, Karachi and Los Angeles before hydration", () => {
  const all = renders();
  const [, utc] = all[0];
  for (const [TZ, html] of all) {
    const diff = texts(html)
      .map((t, i) => [texts(utc)[i], t])
      .filter(([a, b]) => a !== b);
    assert.deepEqual(diff, [], `${TZ}: text that differs from the UTC render`);
    assert.equal(html, utc, `${TZ}: whole list`);
  }
  // The dates are really on the page, as UTC dates, in the cards and the table.
  for (const text of ["12 Nov", "05 Nov", "20 Oct", "Edited 09 Nov"]) {
    assert.ok(
      texts(utc).filter((t) => t.includes(text)).length >= 2,
      `cards and table show "${text}"`,
    );
  }
});

// Negative control: put back fmtPosted's Date.now() before hydration and a
// server render at 23:59:59 says "Today" where the browser's, two seconds
// later, says "1d ago" (POSTED_TODAY was 00:00).
test("before hydration the list does not read the clock: a render two seconds later is identical", () => {
  assert.equal(list(NOW + 9 * 60_000 + 59_000), list(NOW + 10 * 60_000 + 1_000));
});

test("after hydration: the reader's own date, and the live 'Nd ago'", () => {
  const own = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  assert.deepEqual(fmtPosted(POSTED_EVENING, "open", false), { main: "05 Nov", sub: "05 Nov" });
  assert.deepEqual(fmtPosted(EDITED, "on_hold", false), {
    main: "Not posted",
    sub: "Edited 09 Nov",
  });
  assert.deepEqual(fmtPosted(EDITED, "on_hold", true), {
    main: "Not posted",
    sub: `Edited ${own(EDITED)}`,
  });
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000 - 60_000).toISOString();
  assert.deepEqual(fmtPosted(daysAgo(0), "open", true), { main: "Today", sub: own(daysAgo(0)) });
  assert.equal(fmtPosted(daysAgo(1), "open", true).main, "1d ago");
  assert.equal(fmtPosted(daysAgo(6), "open", true).main, "6d ago");
  assert.deepEqual(fmtPosted("not a date", "open", false), { main: "-", sub: "-" });
});
