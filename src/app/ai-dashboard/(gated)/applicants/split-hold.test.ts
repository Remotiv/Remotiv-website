/**
 * The Split panel's hold on a scored applicant's cards is capped (task #34).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-hold.test.ts"
 *
 * The client wires these two exactly as here (split-panel.test.ts pins the
 * wiring): the cap starts for the selected row while its read is pending, and
 * `reading` is splitReading(row, read, expired). Mock timers drive the cap;
 * the real panel renders the result. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, mock, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SplitPanel } = await import("./_split-panel.tsx");
const { SPLIT_HOLD_CAP_MS, splitReading, startHoldCap } = await import("./split-hold.ts");

const ROW = {
  id: "app-scored",
  first_name: "Candidatea",
  last_name: "Testperson",
  email: "candidate.a@example.test",
  phone: null,
  linkedin_url: null,
  job_id: "job-1",
  job_title: "Engineer",
  city: "Lahore",
  country: "Pakistan",
  years_experience: 4,
  notice_period: null,
  availability: null,
  created_at: "2026-11-01T00:00:00.000Z",
  pipeline_stage: "applied",
  score: {
    status: "scored",
    ai_status: "scored",
    overall: 82,
    ai_overall: 82,
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
};

const panel = (reading) =>
  renderToStaticMarkup(
    createElement(SplitPanel, {
      row: ROW,
      header: createElement("div"),
      scoreDetail: null,
      reading,
      unscored: null,
      screening: { status: "loading" },
      applied: { main: "11d ago" },
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
const held = (html) => /data-split-detail="loading"/.test(html) && !/>Application</.test(html);
const cards = (html) =>
  !/data-split-detail="/.test(html) && /data-split-columns="true"[\s\S]*>Application</.test(html);

describe("the hold cap", () => {
  test("is 8 seconds", () => {
    assert.equal(SPLIT_HOLD_CAP_MS, 8000);
  });

  test("a read that never returns: held until the cap, then the cards show", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let expired = null;
      const readId = undefined; // the read for this row never lands
      startHoldCap(ROW.id, (id) => {
        expired = id;
      });
      assert.ok(held(panel(splitReading(ROW.id, readId, expired))), "held at 0 s");
      mock.timers.tick(SPLIT_HOLD_CAP_MS - 1);
      assert.ok(held(panel(splitReading(ROW.id, readId, expired))), "still held just under 8 s");
      mock.timers.tick(1);
      assert.equal(expired, ROW.id);
      assert.ok(cards(panel(splitReading(ROW.id, readId, expired))), "cards at 8 s");
    } finally {
      mock.timers.reset();
    }
  });

  test("a read that lands (or fails) first ends the hold at once, and the cap is cancelled", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let expired = null;
      const cancel = startHoldCap(ROW.id, (id) => {
        expired = id;
      });
      mock.timers.tick(1000);
      assert.ok(cards(panel(splitReading(ROW.id, ROW.id, expired))), "landed at 1 s: cards");
      cancel();
      mock.timers.tick(SPLIT_HOLD_CAP_MS);
      assert.equal(expired, null, "a cancelled cap never fires");
    } finally {
      mock.timers.reset();
    }
  });

  test("the cap is per row: another row's expiry, or another row's read, holds nothing open", () => {
    assert.equal(splitReading(ROW.id, "other-row", "other-row"), true);
    assert.equal(splitReading(ROW.id, "other-row", ROW.id), false);
    assert.equal(splitReading(ROW.id, ROW.id, null), false);
  });
});
