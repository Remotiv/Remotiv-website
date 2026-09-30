/**
 * Source pins for the Phase 6 dashboard wiring: every toast host uses the one
 * persistent Toast, no host mounts its own live region conditionally, every
 * listed overlay uses the modal primitive and none of them keeps a private
 * Escape handler, and the recruiter-facing error surfaces are guarded.
 *
 *   node --test src/app/ai-dashboard/_components/a11y-wiring.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const G = "../(gated)/";

const TOAST_HOSTS = [
  `${G}applicants/_applicants-client.tsx`,
  `${G}jobs/_jobs-client.tsx`,
  `${G}team/_team-client.tsx`,
  `${G}jobs/new/_wizard-client.tsx`,
  `${G}interviews/[sessionId]/_review-client.tsx`,
  `${G}messages/_messages-client.tsx`,
  `${G}settings/_settings-client.tsx`,
  `${G}weekly-report/_weekly-client.tsx`,
];

test("A6-17: all eight hosts render the persistent Toast and none mounts a live region with its text", () => {
  for (const rel of TOAST_HOSTS) {
    const s = src(rel);
    assert.match(s, /<Toast state=\{toast\} \/>/, rel);
    assert.match(s, /= useToast\(\);/, rel);
    assert.doesNotMatch(s, /\{toast && \(/, `${rel}: conditional toast markup remains`);
    assert.doesNotMatch(
      s,
      /setTimeout\(\(\) => setToast\(null\)/,
      `${rel}: private dismiss timer remains`,
    );
  }
  const toast = src("./toast.tsx");
  assert.match(toast, /useAnnouncer\(\)/);
  assert.match(toast, /assertive: state\.tone === "error"/);
  assert.match(toast, /error: <AlertCircle/);
  assert.match(toast, /aria-hidden="true"/, "the visible toast is not read twice");
  const region = src("../../../components/live-region.tsx");
  assert.match(region, /role="status"[\s\S]{0,80}aria-live="polite"/);
  assert.match(region, /role="alert"[\s\S]{0,80}aria-live="assertive"/);
  assert.match(region, /data-inert-exempt=""/);
});

test("A6-17: failures toast with the error tone on the pages that report action results", () => {
  for (const rel of [
    `${G}messages/_messages-client.tsx`,
    `${G}applicants/_applicants-client.tsx`,
    `${G}jobs/_jobs-client.tsx`,
    `${G}team/_team-client.tsx`,
  ]) {
    const s = src(rel);
    assert.doesNotMatch(s, /setToast\(result\.error\);/, `${rel}: untoned error toast`);
    assert.match(s, /tone: "error"/, rel);
  }
});

const OVERLAYS = [
  [`${G}applicants/_applicants-client.tsx`, 3],
  [`${G}team/_team-client.tsx`, 4],
  [`${G}jobs/_jobs-client.tsx`, 1],
  [`${G}jobs/new/_wizard-client.tsx`, 1],
  [`${G}interviews/[sessionId]/_review-client.tsx`, 1],
  [`${G}messages/_messages-client.tsx`, 1],
  [`${G}messages/_composer.tsx`, 1],
  [`${G}settings/_templates-card.tsx`, 1],
  ["./help-panel.tsx", 1],
  ["./welcome-modal.tsx", 1],
];

test("A6-16: every listed overlay uses the primitive the stated number of times, and keeps no private Escape handler", () => {
  for (const [rel, count] of OVERLAYS) {
    const s = src(rel);
    assert.equal((s.match(/useModalFocus\(/g) ?? []).length, count, rel);
    // The jobs file still hosts the untouched jobs DRAWER (A6-5), checked below.
    if (!rel.endsWith("jobs/_jobs-client.tsx")) {
      assert.doesNotMatch(
        s,
        /if \(e\.key === "Escape"\) onClose\(\);/,
        `${rel}: private Escape handler`,
      );
    }
    assert.doesNotMatch(s, /if \(e\.key === "Escape"\) onCancel\(\);/, rel);
  }
  // The jobs DRAWER (A6-5) is deliberately untouched this round.
  const jobs = src(`${G}jobs/_jobs-client.tsx`);
  assert.match(
    jobs,
    /if \(e\.key === "Escape"\) onClose\(\);/,
    "jobs drawer keeps its own handler for now",
  );
  // The review delete dialog is now named.
  const review = src(`${G}interviews/[sessionId]/_review-client.tsx`);
  assert.match(review, /aria-labelledby="delete-interview-title"/);
  assert.match(review, /id="delete-interview-title"/);
});

test("A6-16: the primitive itself - inert outside, one keydown listener, Escape only for the top", () => {
  const hook = src("../../../hooks/use-modal-focus.ts");
  assert.match(hook, /el\.setAttribute\("inert", ""\)/);
  assert.match(
    hook,
    /if \(prev === null\) el\.removeAttribute\("inert"\);/,
    "restores prior state exactly",
  );
  assert.match(hook, /INERT_EXEMPT_ATTR = "data-inert-exempt"/);
  assert.match(hook, /if \(escapeTarget\(stack\) === top && opts\.onClose\)/);
  assert.match(hook, /e\.stopPropagation\(\);/, "one Escape reaches one layer");
  assert.match(hook, /document\.addEventListener\("keydown", onKeyDown, true\)/);
  // The legacy wrapper delegates and does not trap the page.
  const trap = src("../../../hooks/use-focus-trap.ts");
  assert.match(
    trap,
    /useModalFocus\(containerRef, active, \{\s*initialFocus: "first",\s*lockScroll: false,\s*inertOutside: false,\s*\}\)/,
  );
});

test("A6-26: recruiter surfaces render stored errors only through the safe-sentence gate, and actions never return a database message", () => {
  const card = src("../lib/unscored-card.ts");
  assert.match(card, /isSafeFailureSentence\(input\.scoreError\)/);
  const review = src(`${G}interviews/[sessionId]/_review-client.tsx`);
  assert.equal(
    (review.match(/isSafeFailureSentence\(/g) ?? []).length,
    3,
    "strip, answer card, transcript",
  );
  assert.doesNotMatch(review, /score\.error\?\.slice\(0, 200\) \?\?\n\s*"We couldn't score/);
  for (const rel of [
    `${G}applicants/actions.ts`,
    `${G}jobs/actions.ts`,
    `${G}messages/actions.ts`,
  ]) {
    const s = src(rel);
    assert.doesNotMatch(
      s,
      /return \{ success: false, error: (updateErr|error|delErr|uploadErr|snapErr)\.message \}/,
      `${rel}: raw database or storage message returned`,
    );
    assert.doesNotMatch(s, /error: queued\.error/, `${rel}: raw queue message returned`);
  }
  // The two deletes write something BEFORE the failing statement (the CV
  // object, the title snapshots), so they must not claim nothing changed.
  const applicants = src(`${G}applicants/actions.ts`);
  assert.match(applicants, /actionIncomplete\("delete that applicant", delErr\)/);
  assert.match(applicants, /rolledBack\n\s*\? actionFailed\("add that candidate", updateErr\)/);
  const jobs = src(`${G}jobs/actions.ts`);
  assert.match(jobs, /actionIncomplete\("delete that job", error\)/);
  assert.match(jobs, /actionFailed\("delete that job", snapErr\)/);
  const cv = src("../../../lib/ai/cv-scoring.ts");
  assert.match(cv, /error: safeFailureSentence\(classifyProviderError\(jobErr\), "scoring"\)/);
  const interview = src("../../../lib/ai/interview-scoring.ts");
  assert.match(
    interview,
    /error: safeFailureSentence\(classifyProviderError\(jobErr\), "scoring"\)/,
  );
});
