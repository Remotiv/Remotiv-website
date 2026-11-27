/**
 * The page's one scroll lock (26 Nov bug): the job drawer and the modal
 * primitive both take the counted lock (use-body-scroll-lock.ts), so they can
 * open and close in any order and the page scrolls again.
 *
 *   node --test src/hooks/scroll-lock.test.ts
 *
 * The real acquireBodyScrollLock and createModalScrollLock run on a fake body.
 * React's effect order is replayed by hand, as it runs within one commit: all
 * cleanups first, then all new effects, a child's before its parent's (the job
 * drawer is a child of the jobs page, whose hook holds the confirm dialog).
 * useBodyScrollLock(true) re-runs only on mount and unmount: its dependency
 * never changes while the drawer is open.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));

const { acquireBodyScrollLock } = await import("./use-body-scroll-lock.ts");
const { createModalScrollLock } = await import("./use-modal-focus.ts");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const JOBS = read("../app/ai-dashboard/(gated)/jobs/_jobs-client.tsx");
const MODAL = read("./use-modal-focus.ts");

/** A page: its body, the job drawer's lock and the modals' share of it. */
function page({ overflow = "", paddingRight = "" } = {}) {
  const body = { style: { overflow, paddingRight }, dataset: {} };
  const acquire = () => acquireBodyScrollLock(body, () => 0);
  let drawerRelease = null;
  let open = 0;
  const modals = createModalScrollLock(acquire);
  return {
    body,
    locks: () => Number(body.dataset.scrollLocks ?? "0"),
    scrollable: () => body.style.overflow !== "hidden",
    // useBodyScrollLock(true) in JobDrawer: mount and unmount only.
    drawerMount: () => {
      drawerRelease = acquire();
    },
    drawerUnmount: () => {
      drawerRelease?.();
      drawerRelease = null;
    },
    // useModalFocus: the primitive's sync() after its stack changed.
    modalOpen: () => {
      open += 1;
      modals.update(open > 0);
    },
    modalClose: () => {
      open -= 1;
      modals.update(open > 0);
    },
  };
}

/** The fix is what runs: the drawer takes the counted lock, the primitive no saved value. */
function assertWired() {
  const drawer = JOBS.slice(
    JOBS.indexOf("function JobDrawer("),
    JOBS.indexOf("function JobDrawer(") + 4000,
  );
  assert.match(drawer, /useBodyScrollLock\(true\);/, "the job drawer takes the counted lock");
  assert.doesNotMatch(JOBS, /document\.body\.style\.overflow/, "and saves nothing itself");
  assert.match(MODAL, /scrollLock\.update\(\[\.\.\.records\.values\(\)\]\.some\(/);
  assert.match(MODAL, /scrollLock\.update\(false\);/);
  assert.doesNotMatch(
    MODAL,
    /prevBodyOverflow|document\.body\.style\.overflow/,
    "no saved value of its own",
  );
}

test("A: drawer, Archive (confirm), Cancel, close the drawer: the page scrolls", () => {
  assertWired();
  const p = page();
  p.drawerMount();
  // Archive: the jobs page re-renders and the dialog opens. The drawer's lock does not re-run.
  p.modalOpen();
  assert.equal(p.scrollable(), false);
  p.modalClose(); // Cancel: the drawer stays open, so the page stays locked.
  assert.equal(p.scrollable(), false, "the drawer still holds it");
  p.drawerUnmount();
  assert.deepEqual([p.scrollable(), p.locks()], [true, 0]);
});

test("B: drawer, Delete (confirm), confirmed: both close in one commit, drawer first - the page scrolls", () => {
  assertWired();
  const p = page();
  p.drawerMount();
  p.modalOpen();
  // One commit: the drawer's cleanup (child) runs before the dialog's (parent).
  p.drawerUnmount();
  assert.equal(p.scrollable(), false, "the dialog still holds it");
  p.modalClose();
  assert.deepEqual([p.scrollable(), p.locks()], [true, 0]);
});

test("C: the drawer alone, many re-renders, closed: the page scrolls", () => {
  const p = page();
  p.drawerMount();
  // Re-renders: useBodyScrollLock(true) does not re-run, and nothing else touches the body.
  for (let i = 0; i < 20; i += 1) assert.equal(p.locks(), 1);
  p.drawerUnmount();
  assert.deepEqual([p.scrollable(), p.locks()], [true, 0]);
});

test("D: two modals stacked, closed in either order: the page scrolls, one lock only", () => {
  for (const order of ["top first", "bottom first"]) {
    const p = page();
    p.modalOpen();
    p.modalOpen();
    assert.equal(p.locks(), 1, "the modals share one lock");
    p.modalClose();
    assert.equal(p.scrollable(), false, `${order}: one still open`);
    p.modalClose();
    assert.deepEqual([p.scrollable(), p.locks()], [true, 0], order);
  }
  // With the drawer underneath too, closed in every order.
  for (const steps of [
    ["drawerUnmount", "modalClose", "modalClose"],
    ["modalClose", "drawerUnmount", "modalClose"],
    ["modalClose", "modalClose", "drawerUnmount"],
  ]) {
    const p = page();
    p.drawerMount();
    p.modalOpen();
    p.modalOpen();
    for (const s of steps) p[s]();
    assert.deepEqual([p.scrollable(), p.locks()], [true, 0], steps.join(" > "));
  }
});

test("E: a modal unmounted while open (navigation): the page scrolls", () => {
  const p = page();
  p.modalOpen();
  // Unmount runs the same cleanup: the stack empties, the lock is released.
  p.modalClose();
  assert.deepEqual([p.scrollable(), p.locks()], [true, 0]);
  // The drawer unmounted while open, with nothing else: the same.
  const q = page();
  q.drawerMount();
  q.drawerUnmount();
  assert.deepEqual([q.scrollable(), q.locks()], [true, 0]);
});

test("Strict Mode: mount, cleanup, mount, cleanup ends with 0 locks and the page scrollable", () => {
  const p = page();
  // React's dev double run of each effect, for the drawer and for a modal.
  p.drawerMount();
  p.drawerUnmount();
  p.drawerMount();
  p.modalOpen();
  p.modalClose();
  p.modalOpen();
  assert.equal(p.locks(), 2, "one per holder, never more");
  p.modalClose();
  p.drawerUnmount();
  assert.deepEqual([p.scrollable(), p.locks()], [true, 0]);
});

test("each lock is released exactly once: a release run twice cannot drop someone else's", () => {
  const body = { style: { overflow: "", paddingRight: "" }, dataset: {} };
  const a = acquireBodyScrollLock(body, () => 0);
  const b = acquireBodyScrollLock(body, () => 0);
  a();
  a();
  assert.equal(body.dataset.scrollLocks, "1", "b still holds it");
  assert.equal(body.style.overflow, "hidden");
  b();
  b();
  assert.deepEqual([body.dataset.scrollLocks, body.style.overflow], [undefined, ""]);
  // The modals' share: update(false) twice releases once.
  const p = page();
  p.drawerMount();
  const modals = createModalScrollLock(() => acquireBodyScrollLock(p.body, () => 0));
  modals.update(true);
  modals.update(true);
  assert.equal(p.locks(), 2);
  modals.update(false);
  modals.update(false);
  assert.equal(p.locks(), 1, "the drawer's lock is untouched");
});

test("the last release puts back the body's ORIGINAL overflow and padding, not an empty string", () => {
  const body = { style: { overflow: "scroll", paddingRight: "3px" }, dataset: {} };
  const first = acquireBodyScrollLock(body, () => 15);
  const second = acquireBodyScrollLock(body, () => 15);
  assert.deepEqual([body.style.overflow, body.style.paddingRight], ["hidden", "15px"]);
  first();
  assert.deepEqual(
    [body.style.overflow, body.style.paddingRight],
    ["hidden", "15px"],
    "one still held",
  );
  second();
  assert.deepEqual([body.style.overflow, body.style.paddingRight], ["scroll", "3px"]);
  // And the next first lock records afresh.
  body.style.overflow = "auto";
  acquireBodyScrollLock(body, () => 0)();
  assert.equal(body.style.overflow, "auto");
});

test("the wizard opened directly, async switched on: no scroll lock is taken at all", () => {
  const dir = "../app/ai-dashboard/(gated)/jobs/new/";
  const WIZARD = read(`${dir}_wizard-client.tsx`);
  for (const file of [
    "_wizard-client.tsx",
    "_interview-question-editor.tsx",
    "_live-interview-settings.tsx",
    "unsaved-changes.ts",
    "question-lists.ts",
  ]) {
    const src = read(`${dir}${file}`);
    assert.doesNotMatch(src, /style\.overflow|useBodyScrollLock|acquireBodyScrollLock/, file);
  }
  // Its only locks are its two dialogs, each taken only while that dialog is open.
  const modals = [...WIZARD.matchAll(/useModalFocus\((\w+), ([^,]+), \{/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.deepEqual(modals, [
    ["publishedDialogRef", "published !== null"],
    ["leaveDialogRef", "leaveGuard.pending !== null"],
  ]);
  // The async switch sets its field and nothing else.
  assert.match(
    WIZARD,
    /title="Async video interview"[\s\S]{0,400}onToggle=\{\(\) =>\s*set\("async_interview_enabled", !state\.async_interview_enabled\)\s*\}/,
  );
});
