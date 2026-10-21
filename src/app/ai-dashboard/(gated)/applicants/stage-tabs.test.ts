/**
 * The stage-filter strip, and the unknown-stage fallback behind the pills.
 *
 * _stage-tabs.tsx is rendered for real through react-dom/server, so the chip
 * assertions are about the markup a browser receives rather than the constant
 * it was derived from: a chip wired to the wrong stage, or a stage with no chip
 * at all, fails here.
 *
 * The four pill sites live inside _applicants-client.tsx and _overview-client.tsx,
 * which are 6,000-line client modules pulling in server actions — rendering
 * either one would mean stubbing most of the app. Their shared resolver
 * (lib/stage-pill.ts) is executed directly instead, with an eighth stage no
 * build has heard of, and each of the four sites is pinned to it from source.
 *
 * What is deliberately NOT tested: that the strip scrolls, or that chips resist
 * compression. node:test has no DOM and no layout engine, so nothing has a
 * width and any such assertion would pass whatever the CSS said. The classes
 * that produce the behaviour are pinned; the behaviour is a browser check.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/stage-tabs.test.ts"
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { StageTabs, TAB_STAGES } = await import("./_stage-tabs.tsx");
const { PIPELINE_STAGES, PIPELINE_STAGE_LABELS, UNKNOWN_STAGE_LABEL, pipelineStageLabel } =
  await import("@/app/ai-dashboard/lib/applicant-types.ts");
const { stagePill, overviewStagePill, UNKNOWN_STAGE_PILL, UNKNOWN_OVERVIEW_STAGE_PILL } =
  await import("@/app/ai-dashboard/lib/stage-pill.ts");
const { countLabel } = await import("./counts-state.ts");

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const APPLICANTS = src("./_applicants-client.tsx");
const OVERVIEW = src("../_overview-client.tsx");
const TABS = src("./_stage-tabs.tsx");

/**
 * Stages the database has never held, but could after an unrelated migration.
 *
 * The last three are inherited `Object.prototype` keys, and they are the reason
 * the resolvers test `Object.hasOwn` rather than `?? FALLBACK`: with `??` these
 * three resolved to the prototype object and to functions, whose `.cls` is
 * `undefined`. The CHECK constraint makes them unreachable from the column
 * today — they are kept because they catch the lookup bug, not because the
 * column could hold them.
 */
const UNKNOWN_STAGES = [
  "escalated",
  "withdrawn",
  "",
  "Applied",
  "offer ",
  "__proto__",
  "toString",
  "constructor",
];

const ZERO = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0]));

function strip(props = {}) {
  return renderToStaticMarkup(
    createElement(StageTabs, {
      tab: "all",
      total: 145,
      stageCounts: ZERO,
      updating: false,
      flaggedOnly: false,
      flaggedCount: 0,
      onSelectStage: () => {},
      onToggleFlagged: () => {},
      ...props,
    }),
  );
}

/** Every `data-stage` value in render order. */
const renderedStages = (html) => [...html.matchAll(/data-stage="([^"]+)"/g)].map((m) => m[1]);

/* ── every stage is reachable as a chip ──────────────────────────── */

test("every PIPELINE_STAGES value renders a chip whose filter target is that stage", () => {
  const stages = renderedStages(strip());
  for (const stage of PIPELINE_STAGES) {
    assert.ok(
      stages.includes(stage),
      `no chip renders data-stage="${stage}" — that stage would be unfilterable. Rendered: ${stages.join(", ")}`,
    );
  }
});

test("the strip is All followed by the seven stages in pipeline order", () => {
  assert.deepEqual(renderedStages(strip()), ["all", ...PIPELINE_STAGES]);
});

test("Screening sits between Applied and Shortlisted", () => {
  const stages = renderedStages(strip());
  assert.ok(stages.indexOf("applied") < stages.indexOf("screening"));
  assert.ok(stages.indexOf("screening") < stages.indexOf("shortlisted"));
});

test("each chip's label matches the stage it actually filters on", () => {
  const chips = [...strip().matchAll(/<button[^>]*data-stage="([^"]+)"[^>]*>(.*?)<\/button>/g)];
  assert.equal(chips.length, PIPELINE_STAGES.length + 1, "expected All plus one chip per stage");
  for (const [, stage, body] of chips) {
    const expected = stage === "all" ? "All" : PIPELINE_STAGE_LABELS[stage];
    assert.ok(body.includes(expected), `chip data-stage="${stage}" should read "${expected}"`);
  }
});

test("TAB_STAGES is derived from PIPELINE_STAGES, not a second hand-written list", () => {
  assert.deepEqual([...TAB_STAGES], [...PIPELINE_STAGES], "the exclusion list is empty");
  assert.match(TABS, /TAB_STAGES[^=]*=\s*PIPELINE_STAGES\.filter/);
  assert.doesNotMatch(
    TABS,
    /TAB_STAGES[^=]*=\s*\[/,
    "a literal array here is the bug this replaced",
  );
});

test("the All chip clears the filter and each stage chip sets its own", () => {
  assert.match(TABS, /onClick=\{\(\) => onSelectStage\(null\)\}/, "All must clear the filter");
  assert.match(TABS, /onClick=\{\(\) => onSelectStage\(stage\)\}/, "a chip filters on its stage");
  assert.doesNotMatch(TABS, /onSelectStage\("/, "no chip may hard-code a stage string");
});

test("the selected chip is the one whose stage is the active tab", () => {
  const chips = [
    ...strip({ tab: "screening" }).matchAll(
      /<button[^>]*data-stage="([^"]+)"[^>]*class="([^"]*)"/g,
    ),
  ];
  assert.ok(chips.length > 1, "expected to find chips with classes");
  for (const [, stage, cls] of chips) {
    assert.equal(
      cls.includes("--ai-sidebar"),
      stage === "screening",
      `data-stage="${stage}" has the wrong selected state`,
    );
  }
});

/* ── unknown vs zero, and never an em dash ──────────────────────── */

/** The rendered badge text for one chip, as a browser would read it. */
const badge = (html, stage) => {
  const m = html.match(new RegExp(`data-stage="${stage}"[\\s\\S]*?<span[^>]*>([^<]*)</span>`));
  return m?.[1];
};

test("an unknown count renders a hyphen and an actual zero renders 0", () => {
  const unknown = strip({ total: null, stageCounts: { ...ZERO, applied: null } });
  assert.equal(badge(unknown, "all"), "-", "an unknown total must read as a hyphen");
  assert.equal(badge(unknown, "applied"), "-", "an unknown stage count must read as a hyphen");
  // Same render: the stages still holding a real 0 must not borrow the hyphen.
  assert.equal(badge(unknown, "screening"), "0", "a real zero must read as 0");
});

test("unknown and zero stay distinguishable, which is the whole point", () => {
  const unknown = badge(strip({ total: null }), "all");
  const zero = badge(strip({ total: 0 }), "all");
  assert.equal(unknown, "-");
  assert.equal(zero, "0");
  assert.notEqual(unknown, zero, "a failed count must never be readable as nobody applied");
});

test("no chip renders an em dash — Remotiv copy uses hyphens", () => {
  for (const props of [{ total: null }, { total: 0 }, { total: 145 }]) {
    assert.doesNotMatch(
      strip(props),
      /—/,
      `em dash in rendered chips for ${JSON.stringify(props)}`,
    );
  }
  assert.doesNotMatch(strip({ stageCounts: { ...ZERO, offer: null } }), /—/);
});

test("the strip's dash comes from countLabel, so the rule holds at one place", () => {
  assert.match(TABS, /countLabel\(count\)/, "the badge must defer to the shared formatter");
  assert.doesNotMatch(TABS, /"—"|'—'/, "no chip may hard-code a dash of its own");
  assert.equal(countLabel(null), "-");
  assert.equal(countLabel(0), "0");
});

/* ── scroll + shrink: class pins, explicitly not layout claims ───── */

test("the chip container keeps its own scroll box", () => {
  const container = strip().slice(0, strip().indexOf("<button"));
  assert.match(container, /overflow-x-auto/, "the strip must scroll within itself");
  assert.match(container, /max-w-full/, "the strip must never widen the page");
});

test("every chip carries shrink-0, so deleting it fails this test", () => {
  const buttons = [...strip().matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, PIPELINE_STAGES.length + 2, "All, seven stages, and Flagged");
  for (const button of buttons) {
    assert.match(button, /shrink-0/, `a chip is missing shrink-0: ${button.slice(0, 140)}`);
  }
});

/* ── unknown stage: the resolver, executed ───────────────────────── */

test("an unknown stage gets a neutral Applicants pill with both fields present", () => {
  for (const stage of UNKNOWN_STAGES) {
    const pill = stagePill(stage);
    assert.deepEqual(pill, UNKNOWN_STAGE_PILL, `stagePill(${JSON.stringify(stage)})`);
    // The three Applicants sites interpolate .cls and .dot into className.
    assert.equal(typeof pill.cls, "string");
    assert.equal(typeof pill.dot, "string");
    assert.ok(!`${pill.cls} ${pill.dot}`.includes("undefined"));
  }
});

test("an unknown stage gets a neutral Overview pill rather than the string undefined", () => {
  for (const stage of UNKNOWN_STAGES) {
    const cls = overviewStagePill(stage);
    assert.equal(cls, UNKNOWN_OVERVIEW_STAGE_PILL, `overviewStagePill(${JSON.stringify(stage)})`);
    assert.ok(!cls.includes("undefined"));
    assert.ok(cls.length > 0);
  }
});

test("the unknown pill is not Applied's styling — it must not pass as a real stage", () => {
  assert.notDeepEqual(stagePill("escalated"), stagePill("applied"));
  assert.notEqual(overviewStagePill("escalated"), overviewStagePill("applied"));
});

test("an unknown stage is labelled Unknown stage, never Applied", () => {
  for (const stage of UNKNOWN_STAGES) {
    assert.equal(pipelineStageLabel(stage), UNKNOWN_STAGE_LABEL);
    assert.notEqual(pipelineStageLabel(stage), "Applied");
  }
});

test("every real stage still resolves to its own pill and label", () => {
  for (const stage of PIPELINE_STAGES) {
    assert.notDeepEqual(stagePill(stage), UNKNOWN_STAGE_PILL, `${stage} fell through`);
    assert.notEqual(overviewStagePill(stage), UNKNOWN_OVERVIEW_STAGE_PILL, `${stage} fell through`);
    assert.equal(pipelineStageLabel(stage), PIPELINE_STAGE_LABELS[stage]);
  }
});

/* ── all four render sites route through the resolver ─────────────── */

test("the three Applicants pill sites resolve through stagePill", () => {
  const sites = [...APPLICANTS.matchAll(/const pill = (\S+)/g)].map((m) => m[1]);
  assert.equal(sites.length, 3, `expected the three known pill sites, found ${sites.length}`);
  for (const site of sites) assert.equal(site, "stagePill(stage);");
  assert.doesNotMatch(APPLICANTS, /STAGE_PILL\[/, "no site may index a pill map directly");
});

test("the Applicants labels beside those pills resolve through pipelineStageLabel", () => {
  const pillLabels = [...APPLICANTS.matchAll(/\$\{pill\.dot\}`\}[\s\S]*?\n\s*\{([^}]+)\}/g)];
  assert.equal(pillLabels.length, 3, "expected a label next to each of the three pills");
  for (const [, expr] of pillLabels) {
    assert.equal(expr.trim(), "pipelineStageLabel(stage)");
  }
});

test("the Overview pill site resolves both styling and label through the fallbacks", () => {
  assert.match(OVERVIEW, /\$\{overviewStagePill\(row\.stage\)\}/);
  assert.match(OVERVIEW, /\{pipelineStageLabel\(row\.stage\)\}/);
  assert.doesNotMatch(OVERVIEW, /STAGE_PILL\[row\.stage\]/);
  assert.doesNotMatch(OVERVIEW, /PIPELINE_STAGE_LABELS\[row\.stage\]/);
});

/* ── the limit of the fallback, kept documented ──────────────────── */

test("an unknown stage has no chip — the fallback contains damage, it does not add a filter", () => {
  assert.ok(!renderedStages(strip()).includes("escalated"));
  assert.match(
    src("../../lib/applicant-types.ts"),
    /REQUIRES adding it to/,
    "the drift limitation must stay documented beside the fallback",
  );
});

/* ── counts: still one parallel batch, no new round trips ─────────── */

test("the seven stage counts come from the existing parallel batch", () => {
  const actions = src("./actions.ts");
  assert.match(
    actions,
    /Promise\.all\(\s*PIPELINE_STAGES\.map\(/,
    "the stage counts must be issued as one parallel map over PIPELINE_STAGES",
  );
  // Showing three more chips must not add a query: the counts were always
  // fetched for all seven and three were thrown away.
  const awaits = (actions.match(/await /g) || []).length;
  assert.ok(awaits > 0);
  assert.doesNotMatch(TABS, /await|fetch\(|from "\.\/actions"/, "the strip must not read data");
});

test("the strip renders counts it is handed, so adding chips costs no query", () => {
  const html = strip({ stageCounts: { ...ZERO, screening: 1, offer: 7 } });
  assert.match(html, />1</);
  assert.match(html, />7</);
});
