/**
 * The Applicants Split panel and layout (Applicants Split, commit 5c).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-panel.test.ts"
 *
 * Three pins the brief asked for, plus the selection rule they rest on:
 *   1. the panel is a region, not a dialog: no focus trap, no inert page, no
 *      Escape handler;
 *   2. auto-selecting the first row never writes the URL - only a click does;
 *   3. the panel's height comes from var(--vh-full), never h-screen or vh.
 * And with the flag off, the layout wrappers add nothing to the live DOM.
 * Synthetic data only.
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
const { SplitLayout, SplitListColumn, SplitPanel, canShortlist } = await import(
  "./_split-panel.tsx"
);
const { autoSplitSelection, SPLIT_MIN_WIDTH_QUERY } = await import("./split-selection.ts");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PANEL_SRC = read("./_split-panel.tsx");
const CLIENT_SRC = read("./_applicants-client.tsx");

/** Code only: comments may name the things the code must not do. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function row(over = {}) {
  return {
    id: "app-aaaaaa",
    first_name: "Candidatea",
    last_name: "Testperson",
    email: "candidate.a@example.test",
    phone: "+00 0000 000000",
    linkedin_url: "https://example.test/in/candidate-a",
    job_id: "job-1",
    job_title: "Engineer",
    city: null,
    country: null,
    years_experience: null,
    notice_period: "1 Month",
    availability: "Full time",
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

function renderPanel(r, props = {}) {
  return renderToStaticMarkup(
    createElement(SplitPanel, {
      row: r,
      header: createElement("div", { "data-test-header": "1" }),
      scoreDetail: null,
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
      ...props,
    }),
  );
}

describe("selection rule", () => {
  test("first row when nothing is selected and the URL names nobody", () => {
    assert.equal(autoSplitSelection(null, ["a", "b"], null), "a");
  });
  test("keeps the selection while it is on the page", () => {
    assert.equal(autoSplitSelection("b", ["a", "b"], null), "b");
  });
  test("moves to the new first row when the selection left the page", () => {
    assert.equal(autoSplitSelection("x", ["a", "b"], null), "a");
  });
  test("the URL wins: a deep-linked or clicked applicant stays, even off this page", () => {
    assert.equal(autoSplitSelection("x", ["a", "b"], "x"), "x");
    assert.equal(autoSplitSelection(null, ["a", "b"], "x"), "x");
  });
  test("an empty page selects nobody", () => {
    assert.equal(autoSplitSelection(null, [], null), null);
  });
  test("the breakpoint is a media query on the real width, 1100px", () => {
    assert.equal(SPLIT_MIN_WIDTH_QUERY, "(min-width: 1100px)");
  });
});

describe("1. no focus trap", () => {
  test("the panel module uses none of the modal machinery", () => {
    const c = code(PANEL_SRC);
    assert.doesNotMatch(c, /useModalFocus/, "the trap belongs to the drawer only");
    assert.doesNotMatch(c, /aria-modal/);
    assert.doesNotMatch(c, /role="dialog"/);
    assert.doesNotMatch(c, /\binert\b/, "the list beside the panel must stay clickable");
    assert.doesNotMatch(c, /onKeyDown|addEventListener|Escape/, "Escape does nothing in the panel");
  });

  test("it renders as a named <section>, which is role region", () => {
    const html = renderPanel(row());
    assert.match(
      html,
      /^<section aria-label="Candidatea Testperson - applicant detail" data-split-panel="true"/,
    );
    assert.doesNotMatch(html, /role="dialog"|aria-modal|tabindex="-1"/);
  });

  test("the client still has exactly the drawer's three traps (a11y-wiring's count)", () => {
    assert.equal((CLIENT_SRC.match(/useModalFocus\(/g) ?? []).length, 3);
  });
});

describe("2. the URL is written on a click, never on auto-select", () => {
  test("the auto-select effect only sets state", () => {
    const m = code(CLIENT_SRC).match(
      /useEffect\(\(\) => \{\s*if \(!splitWide\) return;\s*setSplitId\(\(prev\) =>[\s\S]*?\}, \[splitWide, pagedIds, deepLinkId\]\);/,
    );
    assert.ok(m, "auto-select effect not found - the pin needs its anchor");
    assert.match(m[0], /autoSplitSelection\(/);
    assert.doesNotMatch(m[0], /syncPanelUrl|history\.|router\.|encodePanelUrl/, m[0]);
  });

  test("selectSplit, the click handler, is the writer", () => {
    const m = code(CLIENT_SRC).match(/const selectSplit = useCallback\([\s\S]*?\n {2}\);/);
    assert.ok(m, "selectSplit not found");
    assert.match(m[0], /setSplitId\(id\);\s*syncPanelUrl\(id, panelTab\);/);
  });

  test("a Split row calls selectSplit at 1100+ and opens the sheet below it (commit 7)", () => {
    assert.match(
      CLIENT_SRC,
      /onOpen=\{\(\) => \(splitWide \? selectSplit\(r\.id\) : openSheet\(r\.id\)\)\}/,
    );
  });

  test("Details opens the drawer in state, without a URL write of its own", () => {
    // One set of props feeds both the panel and the sheet (commit 7).
    assert.match(CLIENT_SRC, /onDetails: \(\) => setOpenId\(splitRow\.id\),/);
  });
});

describe("3. height from --vh-full", () => {
  test("the panel frame is sticky at var(--vh-full) less the topbar and gaps", () => {
    const frame = PANEL_SRC.match(/const PANEL_FRAME =\s*"([^"]*)";/)?.[1];
    assert.ok(frame, "PANEL_FRAME not found");
    assert.match(frame, /\bsticky\b/);
    assert.match(frame, /\btop-\[80px\]/);
    // Topbar 64 + gap 16 + PageContainer's pb-16 (64) below the grid: a sticky
    // box cannot leave the grid, so a taller panel was pushed under the
    // topbar at the bottom of the page (5f).
    assert.match(frame, /h-\[calc\(var\(--vh-full\)_-_64px_-_16px_-_64px\)\]/);
  });

  test("no h-screen and no raw vh anywhere in the panel module", () => {
    assert.doesNotMatch(code(PANEL_SRC), /h-screen|\d+vh\b|100dvh/);
  });

  test("the panel body scrolls on its own and hands off to the page at its ends (5g)", () => {
    const body = PANEL_SRC.match(/className="(min-h-0 flex-1 overflow-y-auto[^"]*)"/)?.[1];
    assert.ok(body, "the panel body's class string moved - re-point this pin");
    assert.match(body, /\boverflow-y-auto\b/);
    // No overscroll-* on the body: -none or -contain stop the wheel at the
    // panel's top or bottom, and the page could then only be scrolled from the
    // list column (found on Rocket Search with a trackpad, 5g).
    assert.doesNotMatch(body, /overscroll-/, body);
    assert.doesNotMatch(code(PANEL_SRC), /overscroll-(none|contain|y-none|y-contain)/);
  });

  test("the bottom gap the height leaves is the page container's bottom padding", () => {
    const container = read("../../_components/page-container.tsx");
    assert.match(
      container,
      /\bpb-16\b/,
      "PageContainer's bottom padding changed: re-derive the panel height",
    );
  });

  test("the page does not bounce while the Split panel is beside the list, and only then", () => {
    const css = read("../../ai-dashboard.css");
    const rule = css.match(
      /@media \(min-width: 1100px\) \{\s*html:has\(\[data-split-layout\]\),\s*body:has\(\[data-split-layout\]\) \{\s*overscroll-behavior-y: none;\s*\}\s*\}/,
    );
    assert.ok(rule, "the scoped overscroll rule is missing or changed shape");
    // Nothing else in the shell's stylesheet turns overscroll off.
    assert.equal((css.match(/overscroll-behavior/g) ?? []).length, 1);
    // The marker it keys on renders only with the flag on.
    assert.match(PANEL_SRC, /if \(!split\) return <>\{children\}<\/>;[\s\S]*?data-split-layout/);
  });
});

describe("flag off: the layout adds nothing", () => {
  const child = createElement("div", { id: "live-card" }, "live");
  const live = renderToStaticMarkup(child);

  test("SplitLayout returns its children alone, with no panel", () => {
    const html = renderToStaticMarkup(
      createElement(SplitLayout, { split: false, panel: createElement("aside", null, "p") }, child),
    );
    assert.equal(html, live);
  });

  test("SplitListColumn returns its children alone", () => {
    const html = renderToStaticMarkup(
      createElement(SplitListColumn, { split: false, fullWidth: false }, child),
    );
    assert.equal(html, live);
  });

  test("the client adds the wide classes only when split is on", () => {
    assert.match(CLIENT_SRC, /\$\{split \? ` \$\{SPLIT_CARD_WIDE\}` : ""\}/);
    assert.match(CLIENT_SRC, /\$\{split \? ` \$\{SPLIT_TOOLBAR_WIDE\}` : ""\}/);
  });
});

describe("panel content", () => {
  test("Shortlist (6c): a live button from Applied and Screening, hidden otherwise", () => {
    const applied = renderPanel(row());
    assert.match(applied, /<button type="button" aria-busy="false" data-split-shortlist="true"/);
    const tag = applied.match(/<button[^>]*data-split-shortlist="true"[^>]*>/)?.[0] ?? "";
    assert.doesNotMatch(tag, /\sdisabled=""/, "never a dead button");
    assert.match(applied, /data-split-shortlist="true"[^>]*>Shortlist<\/button>/);
    assert.match(renderPanel(row({ pipeline_stage: "screening" })), /data-split-shortlist/);
    for (const stage of ["shortlisted", "interview", "offer", "hired", "rejected"]) {
      assert.doesNotMatch(
        renderPanel(row({ pipeline_stage: stage })),
        /data-split-shortlist/,
        stage,
      );
    }
  });

  test("canShortlist follows the server's stage rule for every role", () => {
    for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
      assert.equal(canShortlist(role, "applied"), true, role);
      assert.equal(canShortlist(role, "screening"), true, role);
      for (const stage of ["shortlisted", "interview", "offer", "hired", "rejected"]) {
        assert.equal(canShortlist(role, stage), false, `${role} ${stage}`);
      }
    }
    // A hiring manager sees the button too (Shortlisted is not a decision stage).
    assert.match(renderPanel(row(), { viewerRole: "hiring_manager" }), /data-split-shortlist/);
  });

  test("pending: spinner, Shortlisting\u2026, aria-busy and disabled", () => {
    const html = renderPanel(row(), { shortlisting: true });
    assert.match(
      html,
      /<button type="button" disabled="" aria-busy="true" data-split-shortlist="true"/,
    );
    assert.match(html, /lucide-loader-circle[^"]*animate-spin|animate-spin[^"]*lucide/);
    assert.match(html, /Shortlisting\u2026<\/button>/);
  });

  test("error: the sentence and Try again, in an alert", () => {
    const msg = "Couldn't shortlist Candidatea Testperson - nothing changed.";
    const html = renderPanel(row(), { shortlistError: msg });
    const alert = html.match(
      /<div role="alert" data-split-shortlist-error="true"[^>]*>([\s\S]*?)<\/div>/,
    );
    assert.ok(alert, "no alert");
    assert.match(alert[1], /Couldn&#x27;t shortlist Candidatea Testperson - nothing changed\./);
    assert.match(alert[1], /<button type="button"[^>]*>Try again<\/button>/);
    assert.doesNotMatch(
      renderPanel(row()),
      /data-split-shortlist-error/,
      "no alert without an error",
    );
  });

  test("Details is always there", () => {
    assert.match(
      renderPanel(row({ pipeline_stage: "hired" })),
      /data-split-details="true"[^>]*>Details<\/button>/,
    );
  });

  test("the Details card shows Location, Experience and Notice period only", () => {
    const html = renderPanel(row({ city: "Lahore", country: "Pakistan", years_experience: 4 }));
    assert.match(html, />Location</);
    assert.match(html, />Experience</);
    assert.match(html, />Notice period</);
    assert.doesNotMatch(html, />Phone<|>Availability<|>LinkedIn</, "those stay in the drawer");
  });

  test("an unscored row shows no score block", () => {
    const html = renderPanel(row());
    assert.doesNotMatch(html, />Summary<|Scored dimensions|Must-haves met/);
    assert.match(html, />Application</);
  });

  test("no em or en dashes in the panel's own copy", () => {
    const strings = [...code(PANEL_SRC).matchAll(/"([^"]*)"|>([^<>{}]+)</g)].map(
      (m) => m[1] ?? m[2],
    );
    for (const s of strings) assert.doesNotMatch(s, /[–—]/, s);
  });
});
