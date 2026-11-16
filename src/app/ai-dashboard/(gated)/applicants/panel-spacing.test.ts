/**
 * The Split panel body per v9 (`.pnl-b`, `.g2p`): 16px between cards, and
 * from 1280px two columns, 1.32fr / 1fr, 20px apart (B3).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/panel-spacing.test.ts"
 *
 * Scored: Must-haves and Screening on the left, Application and Details on
 * the right. Nothing for the left: Application left, Details right. Neither:
 * Application alone. The drawer keeps its own spacing (its cards' margins
 * are reset only inside the panel). Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SplitPanel } = await import("./_split-panel.tsx");

const row = (over = {}) => ({
  id: "app-aaaaaa",
  first_name: "Candidatea",
  last_name: "Testperson",
  email: "candidate.a@example.test",
  phone: null,
  linkedin_url: null,
  job_id: "job-1",
  job_title: "Engineer",
  city: null,
  country: null,
  years_experience: null,
  notice_period: "1 Month",
  availability: null,
  created_at: "2026-11-01T00:00:00.000Z",
  pipeline_stage: "applied",
  score: {
    status: "scored",
    ai_status: "scored",
    overall: 84,
    ai_overall: 84,
    adjusted: false,
    confidence: null,
    error: null,
    verdict: null,
  },
  has_cv: true,
  cv_expired: false,
  added_manually: false,
  shortlist: { flaggedAt: null, reason: null },
  screening: null,
  ...over,
});
const scored = {
  status: "scored",
  ai_status: "scored",
  overall: 84,
  summary: "A summary.",
  dimensions: [{ dimension: "Skills match", score: 84, reasoning: "Reason." }],
  must_haves: [{ item: "TypeScript", status: "evidenced", quote: null }],
  job_must_have_count: 1,
};
const NONE = { status: "ready", answers: [] };
const render = (r, scoreDetail, screening = NONE) =>
  renderToStaticMarkup(
    createElement(SplitPanel, {
      row: r,
      header: createElement("div"),
      scoreDetail,
      unscored: null,
      screening,
      applied: { main: "1d ago" },
      onDetails: () => {},
      onEmail: () => {},
      dismissing: null,
      onDismissFlag: () => {},
      viewerRole: "owner",
      position: null,
      onStep: () => {},
      stepBusy: false,
      shortlisting: false,
      shortlistError: null,
      onShortlist: () => {},
    }),
  );
/** The two column divs inside data-split-columns, as markup. */
const columns = (html) => {
  const at = html.indexOf("data-split-columns");
  assert.ok(at > -1, "no two-column grid");
  const cols = [];
  let i = html.indexOf('<div class="flex min-w-0 flex-col gap-4 *:mb-0">', at);
  while (i > -1 && cols.length < 2) {
    const next = html.indexOf('<div class="flex min-w-0 flex-col gap-4 *:mb-0">', i + 10);
    cols.push(html.slice(i, next > -1 ? next : undefined));
    i = next;
  }
  return cols;
};

test("the body: one column, 16px between cards, the cards' own margins reset", () => {
  const html = render(row(), scored);
  assert.match(html, /class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto [^"]*\*:mb-0"/);
});

test("the grid from 1280px: 1.32fr / 1fr, 20px apart; one column below", () => {
  const html = render(row(), scored);
  assert.match(
    html,
    /data-split-columns="true" class="grid items-start gap-4 min-\[1280px\]:grid-cols-\[minmax\(0,1\.32fr\)_minmax\(0,1fr\)\] min-\[1280px\]:gap-5"/,
  );
});

test("scored: Must-haves (and Screening) left; Application then Details right", () => {
  const [left, right] = columns(render(row(), scored));
  assert.match(left, /Must-haves met/);
  assert.doesNotMatch(left, /Applied to|Notice period/);
  assert.ok(
    right.indexOf("Applied to") > -1 &&
      right.indexOf("Applied to") < right.indexOf("Notice period"),
  );
});

test("nothing for the left: Application left, Details right (v9 unscored, no screening)", () => {
  const [left, right] = columns(render(row(), null));
  assert.match(left, /Applied to/);
  assert.match(right, /Notice period/);
});

test("unscored, screening still loading: no skeleton, so Application never jumps column", () => {
  const [left, right] = columns(render(row(), null, { status: "loading" }));
  assert.match(left, /Applied to/);
  assert.doesNotMatch(left + right, /Screening questions/);
});

test("scored, screening loading: the skeleton sits under Must-haves (nothing moves)", () => {
  const [left] = columns(render(row(), scored, { status: "loading" }));
  assert.ok(left.indexOf("Must-haves met") < left.indexOf("Screening questions"));
});

test("no details either: Application alone, no grid", () => {
  const html = render(row({ notice_period: null }), null);
  assert.doesNotMatch(html, /data-split-columns/);
  assert.match(html, /Applied to/);
});
