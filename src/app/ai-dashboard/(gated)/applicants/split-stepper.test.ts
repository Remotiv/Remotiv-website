/**
 * Previous / "N of M" / Next in the Split panel's top row (B2; v9 section 2,
 * "Top row", which builds the same row for the desktop panel and the phone
 * sheet).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-stepper.test.ts"
 *
 * One stepper for the drawer, the panel and the sheet: the drawer's existing
 * stepApplicant (list-state's stepTarget / stepRow), now stepping from
 * whoever is in focus. Crossing a page turns the page with a URL replace and
 * opens the target when the rows land; the panel selects through selectSplit
 * (?applicant= by replace), the sheet replaces in place. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SplitPanel } = await import("./_split-panel.tsx");
const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

const row = {
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
  notice_period: null,
  availability: null,
  created_at: "2026-11-01T00:00:00.000Z",
  pipeline_stage: "applied",
  score: {
    status: "pending",
    ai_status: "pending",
    overall: null,
    ai_overall: null,
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
const render = (over = {}) =>
  renderToStaticMarkup(
    createElement(SplitPanel, {
      row,
      header: createElement("div"),
      scoreDetail: null,
      unscored: null,
      screening: { status: "loading" },
      applied: { main: "1d ago" },
      onDetails: () => {},
      onEmail: () => {},
      dismissing: null,
      onDismissFlag: () => {},
      viewerRole: "owner",
      position: { index: 20, total: 128 },
      onStep: () => {},
      stepBusy: false,
      shortlisting: false,
      shortlistError: null,
      onShortlist: () => {},
      ...over,
    }),
  );
const btn = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];

describe("the panel's top row", () => {
  test("Previous, '21 of 128', Next, labelled buttons after Shortlist and Details", () => {
    const html = render();
    assert.match(html, /data-split-stepper/);
    assert.match(html, /21 of 128/);
    assert.ok(btn(html, "Previous applicant"));
    assert.ok(btn(html, "Next applicant"));
    assert.ok(
      html.indexOf("data-split-details") < html.indexOf("data-split-stepper"),
      "not after Details",
    );
    assert.doesNotMatch(btn(html, "Previous applicant"), /\sdisabled=""/);
  });
  test("disabled at the first and the last applicant, and while a step is in flight", () => {
    assert.match(
      btn(render({ position: { index: 0, total: 128 } }), "Previous applicant"),
      /\sdisabled=""/,
    );
    assert.match(
      btn(render({ position: { index: 127, total: 128 } }), "Next applicant"),
      /\sdisabled=""/,
    );
    const busy = render({ stepBusy: true });
    assert.match(btn(busy, "Previous applicant"), /\sdisabled=""/);
    assert.match(btn(busy, "Next applicant"), /\sdisabled=""/);
  });
  test("hidden, not dead, when no position can be stated", () => {
    assert.doesNotMatch(render({ position: null }), /data-split-stepper|Previous applicant/);
  });
});

describe("one stepper, stepping from whoever is in focus", () => {
  const fn = (name) => {
    const at = client.indexOf(`const ${name} = useCallback(`);
    assert.ok(at > -1, `${name} not found`);
    return client.slice(at, client.indexOf("\n  );", at));
  };
  test("the drawer when open, else the panel (1100+) or the sheet", () => {
    assert.match(client, /const stepId = openId \?\? panelId;/);
    assert.match(
      client,
      /const openIndex = stepId \? paged\.findIndex\(\(r\) => r\.id === stepId\) : -1;/,
    );
    const open = fn("stepOpen");
    assert.match(open, /if \(openId \|\| !split\) \{\s*openApplicant\(id\);/);
    assert.match(open, /if \(splitWide\) \{\s*selectSplit\(id\);/);
    assert.match(
      open,
      /setSheetId\(id\);\s*syncPanelUrl\(id, null\);/,
      "the sheet step must replace, never push",
    );
    assert.doesNotMatch(open, /pushState|openSheet/);
  });
  test("every step goes through stepOpen, in a page and across a boundary", () => {
    const step = fn("stepApplicant");
    assert.doesNotMatch(step, /openApplicant/);
    assert.equal([...step.matchAll(/stepOpen\(next\.id\)/g)].length, 2);
    assert.match(step, /setFilters\(\{ page: target\.request\.page \}, "replace"\)/);
    assert.match(client, /setPendingStep\(null\);\s*stepOpen\(landed\.id\);/);
  });
  test("the panel and the sheet get the drawer's position, step and busy state", () => {
    assert.match(client, /position: stepPosition,\s*onStep: stepApplicant,\s*stepBusy: !canStep,/);
  });
});
