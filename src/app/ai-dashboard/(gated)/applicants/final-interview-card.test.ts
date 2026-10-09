/**
 * The Final interviews card, the schedule form and the candidate's final-round
 * booking page, from the source. Both are client components with JSX, which
 * Node's type stripping cannot run, so these are source pins: each one names
 * the line of code that carries a behaviour the brief fixed.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/final-interview-card.test.ts"
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Code only: comments may describe a rule in words the pins would otherwise match. */
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CARD = src("./_final-interview-card.tsx");
const PANEL = src("./_interview-panel.tsx");
const PAGE = src("../../../book/[token]/_booking-client.tsx");
const ROUTE = src("../../../api/book/[token]/route.ts");
const ERROR_COPY = src("../../../book/[token]/_error-copy.ts");

/** The body of one function in the card, up to the next top-level function. */
function fn(name) {
  const c = code(CARD);
  const start = c.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = c.indexOf("\nfunction ", start + 1);
  const exported = c.indexOf("\nexport function ", start + 1);
  const ends = [next, exported].filter((i) => i > 0);
  return c.slice(start, ends.length ? Math.min(...ends) : undefined);
}

/* ── who sees what ──────────────────────────────────────────────── */

test("the card decides with canManageBookings and holds no role list of its own", () => {
  const c = code(CARD);
  assert.match(
    c,
    /import \{ type CompanyRole, canManageBookings \} from "@\/app\/ai-dashboard\/lib\/company-roles";/,
  );
  assert.match(c, /const canManage = canManageBookings\(viewerRole\);/);
  assert.doesNotMatch(c, /["']owner["']|["']admin["']|["']recruiter["']|["']hiring_manager["']/);
  // Every button is behind the flag: the schedule trigger, resend, cancel and the confirm row.
  assert.match(c, /const scheduleButton = canManage \? \(/);
  assert.match(c, /\{canManage && actions\.resend && !confirming && \(/);
  assert.match(c, /\{canManage && actions\.cancel && !confirming && \(/);
  assert.match(c, /\{canManage && confirming && \(/);
  assert.match(c, /\{canManage && formOpen && \(/);
  // The read-only empty state is the same sentence with no button.
  assert.match(CARD, /No final interviews yet\./);
  assert.match(CARD, /"An owner, admin or recruiter can schedule one\."/);
});

test("it is mounted once, below the screening booking card, with the viewer's role", () => {
  const p = code(PANEL);
  assert.equal((p.match(/<FinalInterviewCard /g) ?? []).length, 1);
  assert.match(
    p,
    /<BookingSection applicationId=\{applicationId\} viewerRole=\{viewerRole\} onToast=\{onToast\} \/>\s*<FinalInterviewCard applicationId=\{applicationId\} viewerRole=\{viewerRole\} onToast=\{onToast\} \/>/,
  );
});

/* ── rows are independent, actions refresh, nothing double-submits ── */

test("each row acts on its own id, and every action re-reads the list instead of patching it", () => {
  const c = code(CARD);
  assert.match(c, /onClick=\{\(\) => void resend\(row\.id\)\}/);
  assert.match(c, /onClick=\{\(\) => void cancel\(row\.id\)\}/);
  assert.match(c, /onClick=\{\(\) => setConfirmingId\(row\.id\)\}/);
  for (const name of ["resend", "cancel"]) {
    const body = fn(name);
    assert.match(body, /await load\(\);/, `${name} reloads`);
    assert.doesNotMatch(body, /setRows\(/, `${name} never patches the list`);
  }
  assert.doesNotMatch(c, /setRows\(\(prev\)/, "the list is never patched by hand");
  // The confirm step names the cost before it happens.
  assert.match(CARD, /Cancel this final interview\? The candidate is emailed\./);
});

test("while an action is in flight its buttons are disabled and a second click does nothing", () => {
  const c = code(CARD);
  for (const name of ["resend", "cancel"]) {
    assert.match(fn(name), /if \(busyId !== null\) return;/, name);
    assert.match(fn(name), /setBusyId\(id\);/, name);
  }
  assert.ok((c.match(/disabled=\{busyId !== null\}/g) ?? []).length >= 4, "every action button");
  assert.match(c, /\{busy \? "Sending…" : "Resend link"\}/);
  assert.match(c, /\{busy \? "Cancelling…" : "Yes, cancel it"\}/);
  const dialog = fn("ScheduleDialog");
  assert.match(dialog, /if \(!canSubmit \|\| submitting\) return;/);
  assert.match(dialog, /disabled=\{!canSubmit\}/);
});

/* ── lazy loading ───────────────────────────────────────────────── */

test("the list loads when the card mounts; the options load only when the form opens", () => {
  const card = fn("FinalInterviewCard");
  assert.match(card, /const result = await listFinalInterviews\(applicationId\);/);
  assert.doesNotMatch(card, /getFinalInterviewOptions\(/, "options are not read for a closed form");
  const dialog = fn("ScheduleDialog");
  assert.match(dialog, /getFinalInterviewOptions\(applicationId\)/);
  assert.doesNotMatch(dialog, /listFinalInterviews\(/);
  // The dialog exists in the tree only while open.
  assert.match(code(CARD), /\{canManage && formOpen && \(\s*<ScheduleDialog/);
});

/* ── the form ───────────────────────────────────────────────────── */

test("the form: a name only for a custom type, 30/45/60 defaulting to 60, hosts without a calendar disabled", () => {
  const dialog = fn("ScheduleDialog");
  assert.match(dialog, /const isCustom = interviewType === "custom";/);
  assert.match(dialog, /isCustom && \(label\.length < 1 \|\| label\.length > CUSTOM_LABEL_MAX\)/);
  assert.match(dialog, /customLabel: isCustom \? label : null,/);
  assert.match(dialog, /\{isCustom && \(/, "the name field appears only for custom");
  assert.match(dialog, /useState<number>\(DEFAULT_FINAL_DURATION\)/);
  assert.match(dialog, /\{FINAL_DURATIONS\.map\(\(d\) => \(/);
  assert.doesNotMatch(
    dialog,
    /\[\s*30,\s*45,\s*60\s*\]|value=\{(30|45|60)\}/,
    "durations come from the constants",
  );
  assert.match(dialog, /disabled=\{!m\.calendarConnected\}/);
  assert.match(dialog, /" - Calendar not connected"/);
  // The host never doubles as an interviewer, and the cap is the shared constant.
  assert.match(dialog, /\.filter\(\s*\(m\) => m\.memberId !== hostMemberId,?\s*\)/);
  assert.match(dialog, /chosenInterviewers\.length >= MAX_EXTRA_INTERVIEWERS/);
  // Submit goes to the shared action; success and failure copy as fixed.
  assert.match(dialog, /await scheduleFinalInterview\(\{/);
  assert.match(dialog, /setError\(result\.error\);/, "the server's message is shown as is");
  assert.match(CARD, /onToast\("Booking link sent\."\)/);
  assert.match(CARD, /Send booking link/);
});

test("the form is accessible: a modal on the shared primitive, every field labelled", () => {
  const dialog = fn("ScheduleDialog");
  assert.match(
    dialog,
    /useModalFocus\(dialogRef, true, \{ onClose, overlayRef, initialFocus: "first" \}\)/,
  );
  assert.match(dialog, /role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{`\$\{id\}-title`\}/);
  for (const field of ["type", "label", "host"]) {
    assert.match(dialog, new RegExp(`htmlFor=\\{\`\\$\\{id\\}-${field}\`\\}`), field);
    assert.match(dialog, new RegExp(`id=\\{\`\\$\\{id\\}-${field}\`\\}`), field);
  }
  assert.equal(
    (dialog.match(/<legend className=\{LABEL\}>/g) ?? []).length,
    2,
    "interviewers and length",
  );
  assert.match(code(CARD), /role="alert"/);
});

/* ── the candidate's page ───────────────────────────────────────── */

test("a final round shows the notice and a required tick that unlocks the times; the POST says so", () => {
  const p = code(PAGE);
  assert.match(
    p,
    /function isFinalRound\(state: State\): boolean \{\s*return "purpose" in state && state\.purpose === "final";/,
  );
  assert.match(p, /\{isFinalRound\(state\) && state\.recordingNotice && \(/);
  assert.match(p, /\{state\.recordingNotice\.text\}/);
  assert.match(PAGE, /I understand this interview will be recorded\./);
  assert.match(p, /disabled=\{isFinalRound\(state\) && !acknowledged\}/);
  assert.match(p, /disabled=\{disabled \|\| confirming !== null\}/, "slot buttons honour the tick");
  assert.match(p, /\.\.\.\(final \? \{ recordingNoticeAcknowledged: true \} : \{\}\),/);
  assert.match(
    p,
    /if \(final && !acknowledged\) \{\s*setNotice\(errorCopyFor\("acknowledgement_required"\)\);/,
  );
  // The heading names the round.
  assert.match(p, /\{state\.interviewLabel\} with \{state\.companyName \|\| "the hiring team"\}/);
});

test("a screening call's page is unchanged: the old heading, no notice, nothing extra posted", () => {
  const p = code(PAGE);
  assert.match(
    p,
    /\{state\.candidateFirstName \? `Hi \$\{state\.candidateFirstName\} — pick` : "Pick"\} a\s+time/,
  );
  // The notice block and the heading swap both hang off isFinalRound; nothing renders them otherwise.
  assert.equal((p.match(/recordingNotice/g) ?? []).length >= 2, true);
  assert.doesNotMatch(p, /recordingNoticeAcknowledged: (acknowledged|false)/);
  // PATCH (reschedule) and DELETE (cancel) carry no acknowledgement: it was given at booking.
  const patch = p.slice(p.indexOf('method: "PATCH"'), p.indexOf('method: "PATCH"') + 200);
  assert.doesNotMatch(patch, /recordingNoticeAcknowledged/);
});

test("the route refuses a missing acknowledgement with the code the page maps", () => {
  const r = code(ROUTE);
  assert.equal(
    (r.match(/fail\(400, "acknowledgement_required"\)/g) ?? []).length,
    2,
    "pre-check and claim",
  );
  assert.doesNotMatch(r, /fail\(400, ACKNOWLEDGE_RECORDING\)|ACKNOWLEDGE_RECORDING/);
  assert.match(
    ERROR_COPY,
    /acknowledgement_required: "Please confirm you understand the interview will be recorded\.",/,
  );
});

/* ── copy ───────────────────────────────────────────────────────── */

test("hyphens, never em dashes, in the new copy", () => {
  assert.doesNotMatch(CARD, /\u2014/);
  // The page keeps its existing em dashes; the lines this step added have none.
  for (const line of [
    "I understand this interview will be recorded.",
    "Tick the box to choose a time.",
    'with {state.companyName || "the hiring team"}',
    "A {state.durationMinutes}-minute call on Google Meet for",
  ]) {
    assert.ok(PAGE.includes(line), line);
    assert.doesNotMatch(line, /\u2014/);
  }
  assert.doesNotMatch(CARD, /within 24 hours/i);
  assert.doesNotMatch(
    PAGE.slice(PAGE.indexOf("isFinalRound(state) && state.recordingNotice")),
    /within 24 hours/i,
  );
});
