/**
 * The Split list item (Applicants Split, commit 4).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-list-item.test.ts"
 *
 * Renders the shipped SplitListItem to static markup and checks every data
 * variant and state in docs/design/Applicants_Split_v9.md (section 1 "List
 * item data", states 2-5), then pins that the client renders it only with the
 * Split flag on and keeps today's table and cards otherwise. Synthetic data.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SplitListItem, locationLine } = await import("./_split-list-item.tsx");

const RING = createElement("span", { "data-test-ring": "1" }, "ring");

function row(over = {}) {
  return {
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
    ...over,
  };
}

const scored = (verdict) => ({
  status: "scored",
  ai_status: "scored",
  overall: 84,
  ai_overall: 84,
  adjusted: false,
  confidence: "high",
  error: null,
  verdict,
});

function render(r, props = {}) {
  return renderToStaticMarkup(
    createElement(SplitListItem, {
      row: r,
      ring: RING,
      applied: "2d ago",
      isTop: false,
      selected: false,
      onOpen: () => {},
      ...props,
    }),
  );
}

test("most common row: no score, so the email fills the second line; the ring is placed", () => {
  const html = render(row());
  assert.match(html, /candidate\.a@example\.test/);
  assert.match(html, /data-test-ring="1"/);
  assert.match(html, /Applied 2d ago/);
  assert.doesNotMatch(html, /Screening/);
  assert.doesNotMatch(html, /Top match|Worth a look|Added by team/);
});

test("a scored row with a verdict shows the verdict instead of the email, clamped to 2 lines", () => {
  const html = render(row({ score: scored("Strong React lead; notice is the only gap") }));
  assert.match(html, /Strong React lead; notice is the only gap/);
  assert.match(html, /line-clamp-2/);
  assert.doesNotMatch(html, /candidate\.a@example\.test/);
});

test("a scored row with no verdict falls back to the email", () => {
  const html = render(row({ score: scored(null) }));
  assert.match(html, /candidate\.a@example\.test/);
});

test("location and years only when filled; the line is hidden when both are empty, never a dash", () => {
  assert.equal(locationLine(row()), null);
  assert.equal(locationLine(row({ city: "Lahore", country: "Pakistan" })), "Lahore, Pakistan");
  assert.equal(locationLine(row({ years_experience: 1 })), "1 year");
  assert.equal(
    locationLine(row({ city: "Lahore", country: "Pakistan", years_experience: 6 })),
    "Lahore, Pakistan · 6 years",
  );
  assert.match(render(row({ city: "Lahore", years_experience: 6 })), /Lahore · 6 years/);
  assert.doesNotMatch(render(row()), />\s*-\s*</, "a dash placeholder");
});

test("Screening X/Y met only when the job tested something, and never green", () => {
  const html = render(row({ screening: { met: 2, scored: 3 } }));
  assert.match(html, /Screening 2\/3 met/);
  const span = html.match(/<span class="([^"]*)">[^<]*Screening 2\/3 met/);
  assert.ok(span, "screening text not in its own span");
  assert.doesNotMatch(span[1], /mint|green|remotiv-green/, "screening styled green");
  assert.doesNotMatch(render(row({ screening: null })), /Screening/);
});

test("Added by team only on a row filed by hand", () => {
  assert.match(render(row({ added_manually: true })), /Added by team/);
  assert.doesNotMatch(render(row()), /Added by team/);
});

test("Top match only when the caller says so (Review top 10 at 90 or more)", () => {
  assert.match(render(row({ score: scored("x") }), { isTop: true }), /Top match/);
  assert.match(render(row(), { isTop: true }), /#49D7A7/, "mint avatar ring on a top match");
  assert.doesNotMatch(render(row({ score: scored("x") })), /Top match/);
});

test("a Worth-a-look row: chip, the reason on the second line, the purple wash, no email", () => {
  const html = render(
    row({
      shortlist: {
        flaggedAt: "2026-11-02T00:00:00.000Z",
        reason: "Scored 82 - over your 80 mark.",
      },
    }),
  );
  assert.match(html, /Worth a look/);
  assert.match(html, /Scored 82 - over your 80 mark\./);
  assert.match(html, /bg-remotiv-purple\/\[0\.035\]/);
  assert.doesNotMatch(html, /candidate\.a@example\.test/);
  assert.match(html, /opacity-100/, "the left bar is on for a flagged row");
});

test("selected: aria-pressed, the purple tint, the bar on; unselected: off", () => {
  const on = render(row(), { selected: true });
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /bg-\[var\(--ai-purple-tint\)\]/);
  const off = render(row());
  assert.match(off, /aria-pressed="false"/);
  assert.match(off, /group-hover\/split:opacity-100/, "the bar waits for hover");
});

test("one button, nothing clickable inside it, and an inset focus ring", () => {
  const html = render(
    row({
      added_manually: true,
      screening: { met: 1, scored: 2 },
      shortlist: { flaggedAt: "2026-11-02T00:00:00.000Z", reason: "r" },
    }),
    { isTop: true },
  );
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<a[\s>]/);
  assert.match(html, /focus-visible:-outline-offset-2/);
});

test("the client renders the Split item only with the flag on, and keeps today's table and cards otherwise", () => {
  const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
  const at = client.indexOf("{split ? (");
  assert.ok(at > -1, "no split branch in the list");
  const branch = client.slice(at, client.indexOf(") : (", at));
  assert.match(branch, /<SplitListItem/);
  assert.match(branch, /data-split-list/);
  assert.doesNotMatch(branch, /data-twin/, "the Split list must not use the table/card twin");
  const rest = client.slice(client.indexOf(") : (", at));
  assert.match(rest, /data-twin-narrow/);
  assert.match(rest, /data-twin-wide/);
});

test("a long name keeps at least 8ch before its ellipsis; the chips wrap below it instead (commit 5e)", () => {
  const html = render(
    row({
      first_name: "Alexandrina-Maximiliana",
      last_name: "Featherstonehaugh-Vanderbilt",
      score: { ...scored("x"), adjusted: true },
      shortlist: { flaggedAt: "2026-11-02T00:00:00.000Z", reason: "r" },
    }),
    { isTop: true },
  );
  const line = html.match(/<span class="([^"]*)"><span class="([^"]*)">Alexandrina/);
  assert.ok(line, "name line not found");
  const [, lineCls, nameCls] = line;
  assert.match(lineCls, /(^|\s)flex-wrap(\s|$)/, "the chips must be able to wrap to a second line");
  assert.match(nameCls, /(^|\s)basis-\[8ch\](\s|$)/, "8ch is what the chips must leave the name");
  assert.match(nameCls, /(^|\s)grow(\s|$)/);
  assert.match(
    nameCls,
    /(^|\s)max-w-max(\s|$)/,
    "a name that fits is shown whole, chips right after it",
  );
  assert.match(
    nameCls,
    /(^|\s)truncate(\s|$)/,
    "a name longer than the column still ends in an ellipsis",
  );
  assert.match(html, /Top match/);
  assert.match(html, /Worth a look/i);
});

test("the shared row parts the live table and cards use are not part of this fix", () => {
  const parts = readFileSync(new URL("./_list-row-parts.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    parts,
    /basis-\[8ch\]|flex-wrap/,
    "the 5e change lives in the Split item only",
  );
});
