/**
 * The Split panel's unscored block (v9 section 2, "Unscored").
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-unscored.test.ts"
 *
 * The state is the drawer's unscoredCardState; only two states take v9's
 * words (in progress: dashed "Scoring this CV"; unreadable CV: solid "No
 * readable CV text"), every other state keeps the drawer's exact heading and
 * body. Never a score number, hyphens only, and the block sits above
 * Screening, Application and Details in the panel (and so in the sheet, which
 * renders the same SplitPanelContent). Synthetic data only.
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
const { splitUnscored, splitUnscoredCopy } = await import("./split-unscored.ts");
const { unscoredCardState } = await import("../../lib/unscored-card.ts");
const { CV_LIMIT_REACHED_REASON } = await import("../../lib/applicant-types.ts");
const { SplitPanel } = await import("./_split-panel.tsx");

const ID = "app-aaaaaa";
const NOW = new Date("2026-11-13T10:00:00.000Z");
const PENDING_SCORE = {
  status: "pending",
  ai_status: "pending",
  overall: null,
  ai_overall: null,
  adjusted: false,
  confidence: null,
  error: null,
  verdict: null,
};

function row(over = {}) {
  return {
    id: ID,
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
    score: PENDING_SCORE,
    has_cv: true,
    cv_expired: false,
    added_manually: false,
    shortlist: { flaggedAt: null, reason: null },
    screening: null,
    ...over,
  };
}

const FACTS = { jobScoringEnabled: true, cvReadable: true, queue: null };
const read = ({ facts = {}, detail = null, ok = true, id = ID } = {}) => ({
  id,
  ok,
  scoreDetail: detail,
  scoring: ok ? { ...FACTS, ...facts } : null,
});
const detail = (over) => ({ ...PENDING_SCORE, ...over });
const block = (r, canEdit = true) => splitUnscored({ row: row(), read: r, canEdit, now: NOW });
/** The drawer's own card for the same facts, for the exact-wording checks. */
const drawer = (facts, over = {}) =>
  unscoredCardState({
    scoreStatus: null,
    scoreError: null,
    hasCv: true,
    cvExpired: false,
    facts: { ...FACTS, ...facts },
    canEdit: true,
    jobId: "job-1",
    now: NOW,
    ...over,
  });

describe("the five states the brief names", () => {
  test("Pending: dashed, v9's 'Scoring this CV', for a queued, running or retrying job", () => {
    for (const queue of ["queued", "running", "retrying"]) {
      assert.deepEqual(block(read({ facts: { queue } })), {
        heading: "Scoring this CV",
        body: "The CV is still being scored. Nothing is shown until the score is ready - a number is never guessed.",
        dashed: true,
      });
    }
  });
  test("No CV text: solid, v9's 'No readable CV text'", () => {
    assert.deepEqual(block(read({ facts: { cvReadable: false } })), {
      heading: "No readable CV text",
      body: "We couldn't read text from this CV, so it wasn't scored. A number is never guessed.",
      dashed: false,
    });
  });
  test("Failed: solid, the drawer's exact heading and body", () => {
    const got = block(read({ detail: detail({ status: "failed", ai_status: "failed" }) }));
    const want = drawer({}, { scoreStatus: "failed" });
    assert.equal(want.kind, "failed");
    assert.deepEqual(got, { heading: want.heading, body: want.body, dashed: false });
    assert.equal(got.heading, "Scoring failed");
  });
  test("Scoring off: solid, the drawer's exact wording, editor and viewer alike", () => {
    for (const canEdit of [true, false]) {
      const want = drawer({ jobScoringEnabled: false }, { canEdit });
      assert.equal(want.kind, "scoring_off");
      assert.deepEqual(block(read({ facts: { jobScoringEnabled: false } }), canEdit), {
        heading: want.heading,
        body: want.body,
        dashed: false,
      });
    }
  });
  test("Limit reached: solid, the drawer's exact wording", () => {
    const d = detail({ status: "skipped", ai_status: "skipped", error: CV_LIMIT_REACHED_REASON });
    const want = drawer({}, { scoreStatus: "skipped", scoreError: CV_LIMIT_REACHED_REASON });
    assert.equal(want.kind, "limit_reached");
    assert.deepEqual(block(read({ detail: d })), {
      heading: want.heading,
      body: want.body,
      dashed: false,
    });
  });
});

describe("every other state keeps the drawer's words", () => {
  const kinds = [
    ["job_gone", { jobScoringEnabled: null }, {}],
    ["cv_expired", {}, { cvExpired: true }],
    ["no_cv", {}, { hasCv: false }],
    ["ready_to_rescore", {}, { scoreStatus: "skipped" }],
    ["gave_up", { queue: "dead" }, {}],
    ["not_queued", {}, {}],
  ];
  for (const [kind, facts, over] of kinds) {
    test(kind, () => {
      const card = drawer(facts, over);
      assert.equal(card.kind, kind);
      assert.deepEqual(splitUnscoredCopy(card), {
        heading: card.heading,
        body: card.body,
        dashed: false,
      });
    });
  }
});

describe("never a number, never a guess", () => {
  test("no state's words carry a number, except the limit's reset date", () => {
    const facts = [
      { queue: "queued" },
      { queue: "retrying" },
      { queue: "dead" },
      { cvReadable: false },
      { jobScoringEnabled: false },
      { jobScoringEnabled: null },
      {},
    ];
    const overs = [{}, { scoreStatus: "failed" }, { scoreStatus: "skipped" }, { hasCv: false }];
    for (const f of facts) {
      for (const o of overs) {
        for (const canEdit of [true, false]) {
          const b = splitUnscoredCopy(drawer(f, { ...o, canEdit }));
          assert.doesNotMatch(b.heading, /\d/, b.heading);
          assert.doesNotMatch(b.body, /\d/, b.body);
        }
      }
    }
    const limit = splitUnscoredCopy(
      drawer({}, { scoreStatus: "skipped", scoreError: CV_LIMIT_REACHED_REASON }),
    );
    const digits = limit.body.match(/\d+/g) ?? [];
    assert.ok(digits.length > 0, "the limit body states its reset date");
    assert.match(limit.body, /resets on [^.]*\d/, "a digit outside the reset date");
    assert.equal(
      limit.body.replace(/resets on [^.]*?(?= or )/, "").match(/\d/),
      null,
      "a digit outside the reset date",
    );
  });
  test("hyphens only: no em or en dash in any block", () => {
    const all = [
      block(read({ facts: { queue: "queued" } })),
      block(read({ facts: { cvReadable: false } })),
      block(read({ facts: { jobScoringEnabled: false } })),
      block(read({ detail: detail({ status: "failed", ai_status: "failed" }) })),
      block(
        read({
          detail: detail({
            status: "skipped",
            ai_status: "skipped",
            error: CV_LIMIT_REACHED_REASON,
          }),
        }),
      ),
    ];
    for (const b of all) assert.doesNotMatch(`${b.heading} ${b.body}`, /[–—]/);
  });
  test("a scored applicant gets no block; the detail read's score wins over the list's", () => {
    const scored = {
      ...PENDING_SCORE,
      status: "scored",
      ai_status: "scored",
      overall: 81,
      ai_overall: 81,
    };
    assert.equal(splitUnscored({ row: row({ score: scored }), read: null, canEdit: true }), null);
    assert.equal(
      block(read({ detail: { ...scored } })),
      null,
      "list says pending, detail says scored",
    );
  });
  test("until this applicant's read lands: loading, never another applicant's state", () => {
    assert.equal(block(null), "loading");
    assert.equal(block(read({ id: "app-bbbbbb", facts: { jobScoringEnabled: false } })), "loading");
  });
  test("a failed read shows no block rather than a guessed state", () => {
    assert.equal(block(read({ ok: false })), null);
  });
});

describe("in the panel", () => {
  const render = (unscored, over = {}) =>
    renderToStaticMarkup(
      createElement(SplitPanel, {
        row: row(),
        header: createElement("div", { "data-test-header": "1" }),
        scoreDetail: null,
        unscored,
        screening: { status: "loading" },
        applied: { main: "11d ago" },
        onDetails: () => {},
        onEmail: () => {},
        dismissing: null,
        onDismissFlag: () => {},
        viewerRole: "owner",
        shortlisting: false,
        shortlistError: null,
        onShortlist: () => {},
        ...over,
      }),
    );
  test("Pending is dashed, every other state solid with an invisible border", () => {
    const dashed = render(block(read({ facts: { queue: "queued" } })));
    assert.match(
      dashed,
      /data-split-unscored="dashed"[^>]*border-dashed border-\[var\(--ai-line-strong\)\]/,
    );
    assert.match(dashed, /<h3[^>]*>Scoring this CV<\/h3>/);
    const solid = render(block(read({ facts: { cvReadable: false } })));
    assert.match(solid, /data-split-unscored="solid"[^>]*border-transparent/);
    assert.doesNotMatch(solid, /border-dashed/);
  });
  test("the block leads the body: above Application and Details", () => {
    const html = render(block(read({ facts: { jobScoringEnabled: false } })));
    const at = html.indexOf("data-split-unscored");
    assert.ok(at > -1);
    assert.ok(at < html.indexOf("Applied to"), "the block is not above the Application card");
    assert.ok(at < html.indexOf("Notice period"), "the block is not above the Details card");
  });
  test("loading is a hidden placeholder; null renders nothing", () => {
    assert.match(render("loading"), /aria-hidden="true" data-split-unscored="loading"/);
    assert.doesNotMatch(render(null), /data-split-unscored/);
  });
  test("client: the panel keeps the read's scoring facts and passes the drawer's re-score roles", () => {
    const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
    assert.match(client, /scoring: read\.ok \? \(read\.value\?\.scoring \?\? null\) : null,/);
    assert.match(
      client,
      /unscored: splitUnscored\(\{ row: splitRow, read: splitRead, canEdit: canRescore \}\),/,
    );
  });
});
