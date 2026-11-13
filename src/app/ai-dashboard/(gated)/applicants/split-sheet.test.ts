/**
 * The Split details below 1100px: a full-screen sheet (commit 7).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-sheet.test.ts"
 *
 * Renders the shipped SplitSheet, and pins the history rules in the client
 * that the browser test on staging exercises:
 *   - a row click pushes ONE history entry, so Back closes the sheet;
 *   - "Back to applicants" and Escape pop that entry only if we pushed it,
 *     and otherwise replace the URL, so a deep link never leaves the page;
 *   - Back with the drawer on top closes both;
 *   - stepping applicants never adds another entry;
 *   - widening past 1100 hands the applicant to the panel.
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
const { SplitSheet } = await import("./_split-sheet.tsx");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SHEET_SRC = read("./_split-sheet.tsx");
const PANEL_SRC = read("./_split-panel.tsx");
const CLIENT_SRC = read("./_applicants-client.tsx");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

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

function renderSheet(r) {
  return renderToStaticMarkup(
    createElement(SplitSheet, {
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
      onClose: () => {},
    }),
  );
}

function fnBody(name) {
  const start = CLIENT_SRC.indexOf(`const ${name} = useCallback(`);
  assert.ok(start > -1, `${name} not found`);
  // A useCallback ends either "  );" (deps on their own line) or "  }, [deps]);".
  const ends = ["\n  );\n", "\n  }, ["]
    .map((m) => CLIENT_SRC.indexOf(m, start))
    .filter((i) => i > start);
  return CLIENT_SRC.slice(start, Math.min(...ends));
}

describe("the sheet", () => {
  test("is a modal dialog, named, full height via --vh-full, under the drawer", () => {
    const html = renderSheet(row());
    assert.match(
      html,
      /^<div tabindex="-1" role="dialog" aria-modal="true" aria-label="Candidatea Testperson - applicant detail" data-split-sheet="true"/,
    );
    const cls = html.match(/^<div[^>]*class="([^"]*)"/)?.[1] ?? "";
    assert.match(cls, /\bfixed\b/);
    assert.match(cls, /\bh-\[var\(--vh-full\)\]/);
    assert.match(cls, /\bz-\[90\]/, "under the drawer (z-[95]) and the Composer (z-[100])");
    assert.doesNotMatch(code(SHEET_SRC), /h-screen|\d+vh\b/);
  });

  test("traps focus with the shared primitive, and Escape calls onClose", () => {
    assert.equal((SHEET_SRC.match(/useModalFocus\(/g) ?? []).length, 1);
    assert.match(SHEET_SRC, /useModalFocus\(ref, true, \{ onClose \}\);/);
    assert.equal(
      (PANEL_SRC.match(/useModalFocus\(/g) ?? []).length,
      0,
      "the 1100+ panel stays trap-free",
    );
  });

  test("carries 'Back to applicants' and the panel's own content, not a copy", () => {
    const html = renderSheet(row());
    assert.match(html, /data-split-sheet-back="true"[^>]*>.*Back to applicants<\/button>/);
    assert.match(html, /data-split-shortlist="true"/);
    assert.match(html, /data-split-details="true"/);
    assert.match(html, />Application</);
    assert.match(SHEET_SRC, /<SplitPanelContent \{\.\.\.content\} \/>/);
    assert.match(PANEL_SRC, /<SplitPanelContent \{\.\.\.props\} \/>/);
  });
});

describe("history", () => {
  test("a row click pushes one entry; a sheet already open replaces it", () => {
    const body = fnBody("openSheet");
    assert.match(
      body,
      /if \(sheetPushed\.current\) \{\s*window\.history\.replaceState\(null, "", to\(id\)\);\s*return;\s*\}/,
    );
    assert.equal((body.match(/pushState\(/g) ?? []).length, 1);
    assert.match(
      body,
      /window\.history\.pushState\(null, "", to\(id\)\);\s*sheetPushed\.current = true;/,
    );
  });

  test("a URL already naming an applicant is replaced away before the push", () => {
    const body = fnBody("openSheet");
    const replaceAway = body.indexOf(
      'if (new URLSearchParams(window.location.search).has("applicant"))',
    );
    assert.ok(replaceAway > -1 && replaceAway < body.indexOf("pushState("));
    assert.match(body.slice(replaceAway), /replaceState\(null, "", to\(null\)\)/);
  });

  test("closing pops only our own entry; a deep-linked sheet replaces the URL instead", () => {
    const body = fnBody("closeSheet");
    assert.match(
      body,
      /if \(sheetPushed\.current\) \{\s*sheetPushed\.current = false;\s*window\.history\.back\(\);\s*return;\s*\}/,
    );
    assert.equal((body.match(/history\.back\(/g) ?? []).length, 1);
    assert.match(
      body,
      /setSheetId\(null\);\s*setOpenId\(null\);\s*syncPanelUrl\(null, panelTab\);/,
    );
  });

  test("the URL losing ?applicant= closes the sheet and any drawer on top, together", () => {
    assert.match(
      CLIENT_SRC,
      /if \(split\) \{\s*setSheetId\(deepLinkId\);\s*if \(!deepLinkId\) \{\s*setOpenId\(null\);\s*sheetPushed\.current = false;\s*\}\s*return;\s*\}/,
    );
  });

  test("closing the drawer under Split never writes the URL (the sheet stays under it)", () => {
    const body = fnBody("closePanel");
    assert.match(
      body,
      /setOpenId\(null\);[\s\S]*if \(split\) return;\s*syncPanelUrl\(null, panelTab\);/,
    );
  });

  test("the drawer's prev/next replaces the URL: it never pushes", () => {
    const step = fnBody("openApplicant");
    assert.doesNotMatch(step, /pushState/);
    assert.match(
      CLIENT_SRC,
      /window\.history\.replaceState\(null, "", qs \? `\$\{pathname\}\?\$\{qs\}` : pathname\);/,
    );
  });

  test("widening past 1100 hands the sheet's applicant to the panel", () => {
    assert.match(
      CLIENT_SRC,
      /if \(!splitWide \|\| !sheetId\) return;\s*setSplitId\(sheetId\);\s*setSheetId\(null\);\s*sheetPushed\.current = false;\s*\}, \[splitWide, sheetId\]\);/,
    );
  });

  test("the sheet's key differs from the drawer's (siblings sharing a key left the sheet's DOM behind)", () => {
    assert.match(CLIENT_SRC, /<SplitSheet key=\{`sheet-\$\{splitProps\.row\.id\}`\}/);
    assert.match(CLIENT_SRC, /key=\{openRow\.id\}/);
  });

  test("Back is read from the location on popstate, not only from useSearchParams", () => {
    const at = CLIENT_SRC.indexOf('window.addEventListener("popstate", onPop);');
    assert.ok(at > -1, "no popstate listener");
    const body = CLIENT_SRC.slice(CLIENT_SRC.lastIndexOf("const onPop = () => {", at), at);
    assert.match(body, /new URLSearchParams\(window\.location\.search\)\.get\("applicant"\)/);
    assert.match(
      body,
      /setSheetId\(id\);\s*if \(!id\) \{\s*setOpenId\(null\);\s*sheetPushed\.current = false;/,
    );
  });

  test("below 1100 a row opens the sheet; only the panel or the sheet ever renders", () => {
    assert.match(
      CLIENT_SRC,
      /onOpen=\{\(\) => \(splitWide \? selectSplit\(r\.id\) : openSheet\(r\.id\)\)\}/,
    );
    assert.match(CLIENT_SRC, /splitProps && splitWide \? <SplitPanel/);
    assert.match(CLIENT_SRC, /splitProps && !splitWide && sheetId \? \(/);
  });
});
