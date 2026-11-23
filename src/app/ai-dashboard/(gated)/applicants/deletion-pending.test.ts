/**
 * #16: "Deletion pending" in the Applicants list and panel, and "Delete
 * anyway" only as the recruiter's explicit, confirmed choice.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/deletion-pending.test.ts"
 *
 * The banner, the pill and the panel render as shipped (renderToStaticMarkup);
 * the client's wiring is pinned from source. Synthetic data.
 */
// @ts-nocheck - same reason as split-panel.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { companyDeleteSource } from "../../../../test-support/company-delete-source.mjs";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const P = await import("./_deletion-pending.tsx");
const { SplitPanel } = await import("./_split-panel.tsx");
const { SplitListItem } = await import("./_split-list-item.tsx");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const CLIENT = read("./_applicants-client.tsx");
const ACTIONS = companyDeleteSource();
/** Code only: comments may name what the code must not do. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

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
});
const deletion = (calendarFailed) => ({
  calendarFailed,
  busy: false,
  onFinish: () => {},
  onDeleteAnyway: () => {},
});
const panel = (props = {}) =>
  renderToStaticMarkup(
    createElement(SplitPanel, {
      row: row(),
      header: createElement("div"),
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

test("U1. the panel: no banner unless pending; pending shows Finish deletion, and Delete anyway ONLY after a calendar failure", () => {
  assert.doesNotMatch(panel(), /data-deletion-pending/);
  const other = panel({ deletion: deletion(false) });
  assert.match(other, /data-deletion-pending/);
  assert.match(other, new RegExp(P.DELETION_PENDING_OTHER.replace(/[.]/g, "\\.")));
  assert.match(other, /data-deletion-finish/);
  assert.doesNotMatch(other, /data-deletion-anyway/, "no Delete anyway without a recorded failure");
  const calendar = panel({ deletion: deletion(true) });
  assert.match(calendar, new RegExp(P.DELETION_PENDING_CALENDAR.replace(/[.]/g, "\\.")));
  assert.match(calendar, /data-deletion-finish/);
  assert.match(calendar, /data-deletion-anyway/);
});

test("U2. the list row: a Deletion pending pill only when pending", () => {
  const item = (deletionPending) =>
    renderToStaticMarkup(
      createElement(SplitListItem, {
        row: row(),
        ring: null,
        applied: "Today",
        isTop: false,
        selected: false,
        onOpen: () => {},
        deletionPending,
      }),
    );
  assert.doesNotMatch(item(false), /data-deletion-pending-pill/);
  assert.match(item(true), /data-deletion-pending-pill[^>]*>Deletion pending</);
});

test("U3. Delete anyway is the recruiter's explicit, confirmed choice: the banner opens a dialog, only its confirm deletes", () => {
  const c = code(CLIENT);
  // The banner's button opens the confirmation; it deletes nothing.
  assert.match(c, /onDeleteAnyway: \(\) => setAnywayTarget\(splitRow\)/);
  // The only call with anyway = true is the dialog's confirm button.
  assert.equal((c.match(/handleDelete\([^)]*, true\)/g) ?? []).length, 1);
  assert.match(
    c,
    /data-delete-anyway-confirm\s+onClick=\{\(\) => void handleDelete\(anywayTarget, true\)\}/,
  );
  // And the flag reaches the server only from that path, literally true.
  assert.equal((c.match(/deleteApplicationAnyway\(/g) ?? []).length, 1);
  assert.match(
    c,
    /anyway\s+\? await deleteApplicationAnyway\(target\.id, \{ acknowledgeCalendarEvent: true \}\)\s+: await deleteApplication\(target\.id\)/,
  );
  // Finish deletion is the ordinary delete, again.
  assert.match(c, /onFinish: \(\) => void handleDelete\(splitRow\)/);
});

test("U4. the copy: the panel's, the dialog's and the server's are the same words, with no dashes", () => {
  for (const s of [
    P.DELETION_PENDING_TITLE,
    P.DELETION_PENDING_CALENDAR,
    P.DELETION_PENDING_OTHER,
    P.FINISH_DELETION,
    P.DELETE_ANYWAY,
    P.DELETE_ANYWAY_TITLE,
    P.DELETE_ANYWAY_BODY,
  ]) {
    assert.doesNotMatch(s, /[–—]|\s-\s/, s);
  }
  assert.ok(ACTIONS.includes(`"${P.DELETION_PENDING_CALENDAR}"`), "server and panel agree");
  assert.ok(ACTIONS.includes(`"${P.DELETION_PENDING_OTHER}"`), "server and panel agree");
});

test("U5. a failed delete re-reads the pending state, so the row and panel show it at once", () => {
  const c = code(CLIENT);
  const fn = c.slice(
    c.indexOf("async function handleDelete("),
    c.indexOf("refreshList(request);", c.indexOf("async function handleDelete(")),
  );
  assert.match(fn, /if \(!result\.success\) \{[\s\S]*?void refreshPendingDeletions\(\);\s*return;/);
});
