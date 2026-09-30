/**
 * Source pins for the Phase 6 candidate-side wiring. These modules render
 * React and cannot run under bare node:test, so the assertions hold the
 * source text to the design: live regions mounted once, the required
 * announcements present, the countdown never announced, focus targets on
 * every screen, the apply modal's trap keyed on `mounted`, the booking notice
 * rendered in the booked card, the interview error boundary present.
 *
 *   node --test "src/app/interview/[token]/a11y-wiring.test.ts"
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const flow = src("./_flow.tsx");
const apply = src("../../jobs/_apply-modal.tsx");
const booking = src("../../book/[token]/_booking-client.tsx");
const messages = src("../../ai-dashboard/(gated)/messages/_messages-client.tsx");

test("A6-1: one announcer, regions rendered once, and every required event is spoken", () => {
  assert.equal((flow.match(/useAnnouncer\(\)/g) ?? []).length, 1);
  assert.match(flow, /\{liveRegions\}/);
  // Every toast is also the announcement, with error tone assertive.
  assert.match(flow, /announce\(toast\.text, \{ assertive: toast\.tone === "error" \}\)/);
  assert.match(flow, /announce\("Recording started"\)/);
  assert.match(flow, /"Recording stopped\. Saving your answer\."/);
  assert.match(
    flow,
    /Connection dropped, trying again\. Attempt \$\{attempt \+ 1\} of \$\{UPLOAD_AUTO_ATTEMPTS\}\./,
  );
  assert.match(flow, /Your answer is still on this device\. Use Retry when you have signal\./);
  assert.match(flow, /notify\(`Answer \$\{index \+ 1\} saved`\)/);
  assert.match(flow, /setSubmitErr\(message\);\n\s*announce\(message, \{ assertive: true \}\)/);
  assert.match(flow, /notify\("Please confirm you agree to be recorded", "error"\)/);
  // Error toasts never draw the checkmark.
  assert.match(flow, /toast\.tone === "error" \? \(\s*<AlertTriangle/);
  // The upload bar is a progressbar, not a live region.
  assert.match(flow, /role="progressbar"[\s\S]{0,200}aria-valuenow=\{uploadPct\}/);
});

test("A6-1: the countdown and the percentage are not live regions", () => {
  // Only the two persistent regions carry live semantics; nothing else in the flow does.
  assert.equal(
    (flow.match(/aria-live/g) ?? []).length,
    0,
    "the flow itself declares no live region",
  );
  assert.equal((flow.match(/role="(status|alert)"/g) ?? []).length, 0);
  assert.doesNotMatch(flow, /announce\([^)]*recLeft/);
  assert.doesNotMatch(flow, /announce\([^)]*uploadPct/);
});

test("A6-2: every screen has one focus target and focus moves only on screen or question change", () => {
  const targets = flow.match(/data-screen-heading/g) ?? [];
  // Welcome, Consent, TechCheck, Recorder, Review, Submitted = 6 (+ the comment mention).
  assert.ok(targets.length >= 6, `${targets.length} targets`);
  assert.match(flow, /querySelector<HTMLElement>\("\[data-screen-heading\]"\)/);
  assert.match(flow, /heading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(flow, /\}, \[screen, qi\]\);/);
  assert.match(
    flow,
    /if \(screen === "welcome" && qi < 0\) return;/,
    "no focus theft on first paint",
  );
  assert.match(
    flow,
    /aria-label=\{isPractice \? "Practice question" : `Question \$\{index \+ 1\} of \$\{total\}`\}/,
  );
});

test("A6-3: the apply modal's trap is keyed on the mount guard and owns Escape and scroll lock", () => {
  assert.match(apply, /useModalFocus\(modalRef, mounted, \{ onClose, initialFocus: "first" \}\)/);
  assert.doesNotMatch(apply, /useFocusTrap\(/);
  assert.doesNotMatch(apply, /if \(e\.key === "Escape"\) onClose\(\);/, "no second Escape handler");
  assert.doesNotMatch(apply, /document\.body\.style\.overflow = "hidden"/, "no second scroll lock");
  assert.match(apply, /if \(!mounted\) return null;/);
});

test("A6-4: booking failures render in the booked card as an alert, from the shared copy", () => {
  assert.match(booking, /import \{ errorCopyFor \} from "\.\/_error-copy";/);
  assert.doesNotMatch(booking, /const ERROR_COPY/);
  assert.equal(
    (booking.match(/<NoticeBanner text=\{notice\} \/>/g) ?? []).length,
    2,
    "open and booked",
  );
  assert.match(booking, /role="alert"/);
  const booked = booking.indexOf('state.kind === "booked" && (');
  const bookedNotice = booking.indexOf("<NoticeBanner text={notice} />", booked);
  const openBranch = booking.indexOf('state.kind === "open" && (');
  assert.ok(
    booked > 0 && bookedNotice > booked && bookedNotice < openBranch,
    "a notice inside the booked branch",
  );
});

test("A6-6: scheduled messages can be sent now or cancelled from the viewer, and the kebab shows on focus", () => {
  assert.match(messages, /onSendNow\?: \(\) => void;/);
  assert.match(messages, /onCancelSend\?: \(\) => void;/);
  assert.match(messages, /row\.kind === "scheduled" && onSendNow && \(/);
  assert.match(messages, /row\.kind === "scheduled" && onCancelSend && \(/);
  assert.match(
    messages,
    /onSendNow=\{\(\) => \{\n\s*const row = viewing;\n\s*setViewing\(null\);\n\s*void handleSendNow\(row\);/,
  );
  assert.match(messages, /focus-visible:opacity-100 \$\{\n\s*menuFor === row\.id/);
});

test("A6-24: the interview route has its own error boundary that never points home", () => {
  assert.ok(existsSync(new URL("./error.tsx", import.meta.url)));
  const boundary = src("./error.tsx");
  assert.match(boundary, /Every answer that finished saving is stored/);
  assert.match(boundary, /that one\s+recording\s+was not kept/);
  assert.match(boundary, /contact the recruiter who invited you/);
  assert.match(boundary, /onClick=\{\(\) => reset\(\)\}/);
  assert.doesNotMatch(boundary, /href="\/"/);
  assert.doesNotMatch(boundary, /talent@remotiv\.work/);
});
