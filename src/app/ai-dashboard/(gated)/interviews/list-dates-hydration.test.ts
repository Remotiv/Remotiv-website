/**
 * #64: the Interviews list renders the same on the UTC server and in any
 * browser zone until hydration, so React never throws #418 (hydration text
 * mismatch). After hydration, the reader's own zone and a live relative time.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/list-dates-hydration.test.ts"
 *
 * InterviewsClient runs as shipped; only its server actions and next/link are
 * stubbed. Each zone renders in its own process (TZ is read at process start)
 * with the clock frozen at one instant, and the parent compares the whole
 * server-rendered list. The dates sit just before midnight UTC, where a local
 * date is a different day in Karachi (UTC+5) and Los Angeles (UTC-8).
 * Synthetic data only.
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
const STUBS = {
  "./actions": [
    "export async function fetchInterviewList() { return { ok: false }; }",
    "export async function setInterviewArchived() { return { ok: true }; }",
  ].join("\\n"),
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
const { InterviewsClient, fmtDate, relative } = await import("./_interviews-client.tsx");

// The server's clock: 23:50 UTC. Every stamp is within a few hours of a UTC
// midnight: the evening ones are the next day in Karachi, the early one
// (EXPIRED) the day before in Los Angeles. One is over 30 days old, so
// relative() falls back to a date.
const NOW = Date.parse("2026-11-12T23:50:00.000Z");
const SUBMITTED = "2026-11-12T21:40:00.000Z";
const STARTED = "2026-11-11T23:30:00.000Z";
const SENT = "2026-11-09T23:20:00.000Z";
const EXPIRES = "2026-11-19T23:45:00.000Z";
const EXPIRED = "2026-11-11T03:10:00.000Z";
const OLD = "2026-09-01T23:15:00.000Z";

function row(n, status, dates) {
  return {
    id: `i0000000-0000-4000-8000-00000000000${n}`,
    applicationId: null,
    jobId: null,
    candidateName: `Candidate ${n}`,
    candidateEmail: `c${n}@example.test`,
    candidateLink: "unlinked",
    jobTitle: "Role",
    kind: "async",
    status,
    progress: { answered: status === "submitted" ? 3 : 0, purged: false },
    totalQuestions: 3,
    submittedAt: null,
    startedAt: null,
    expiresAt: EXPIRES,
    sentAt: SENT,
    invitedByName: null,
    score: null,
    scoreUnavailable: false,
    archivedAt: null,
    ...dates,
  };
}

const ROWS = [
  row(1, "submitted", { submittedAt: SUBMITTED }),
  row(2, "submitted", { submittedAt: OLD, sentAt: OLD }),
  row(3, "started", { startedAt: STARTED }),
  row(4, "invited", {}),
  row(5, "expired", { expiresAt: EXPIRED }),
];

const list = (now) => {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return renderToStaticMarkup(
      createElement(InterviewsClient, {
        initial: {
          ok: true,
          value: {
            applied: { status: "all", jobId: null, query: "" },
            rows: ROWS,
            total: ROWS.length,
            page: 1,
            pageSize: 20,
            counts: {
              all: 5,
              submitted: 2,
              started: 1,
              invited: 1,
              expired: 1,
              cancelled: 0,
              unknown: 0,
              archived: 0,
            },
            jobs: [],
            sentThisWeek: 1,
            openRoles: 1,
          },
        },
      }),
    );
  } finally {
    Date.now = realNow;
  }
};

// Child mode: render the list in this process's TZ and print it.
if (process.env.LIST_DATES_PRINT === "1") {
  process.stdout.write(`${JSON.stringify({ html: list(NOW) })}\n`);
  process.exit(0);
}

const ZONES = ["UTC", "Asia/Karachi", "America/Los_Angeles"];
const renders = () =>
  ZONES.map((TZ) => {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ, LIST_DATES_PRINT: "1" },
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

// Negative control: put back the old fmtDate / relative (local date, Date.now()
// on the server) and the Karachi and Los Angeles lists differ from the UTC one.
test("the whole Interviews list renders identically in UTC, Karachi and Los Angeles before hydration", () => {
  const all = renders();
  const [, utc] = all[0];
  for (const [TZ, html] of all) {
    const diff = texts(html)
      .map((t, i) => [texts(utc)[i], t])
      .filter(([a, b]) => a !== b);
    assert.deepEqual(diff, [], `${TZ}: text that differs from the UTC render`);
    assert.equal(html, utc, `${TZ}: whole list`);
  }
  // The dates are really on the page, as UTC dates.
  for (const text of [
    "12 Nov",
    "Started 11 Nov",
    "Due 19 Nov",
    "Expired 11 Nov",
    "Invited 9 Nov",
    "1 Sept",
  ]) {
    assert.ok(texts(utc).includes(text), `the list shows "${text}"`);
  }
});

// Negative control: put back relative()'s Date.now() before hydration and a
// server render at 00:39:59 says "2h ago" where the browser's, two seconds
// later, says "3h ago" (SUBMITTED was 21:40).
test("before hydration the list does not read the clock: a render two seconds later is identical", () => {
  assert.equal(list(NOW + 49 * 60_000 + 59_000), list(NOW + 50 * 60_000 + 1_000));
});

test("after hydration: the reader's own date, and the live relative time", () => {
  const own = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  assert.equal(fmtDate(SUBMITTED, false), "12 Nov");
  assert.equal(fmtDate(SUBMITTED, true), own(SUBMITTED));
  assert.equal(fmtDate(null, true), "");
  assert.equal(relative(SUBMITTED, false), "12 Nov");
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  assert.equal(relative(hoursAgo(5), true), "5h ago");
  assert.equal(relative(hoursAgo(30), true), "Yesterday");
  assert.equal(relative(hoursAgo(24 * 4), true), "4 days ago");
  assert.equal(relative(OLD, true), own(OLD));
});
