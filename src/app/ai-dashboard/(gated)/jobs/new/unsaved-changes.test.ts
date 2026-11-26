/**
 * The job wizard's unsaved-changes warning (#59 commit 2): createLeaveGuard
 * (unsaved-changes.ts), driven through fake window, document and history.
 *
 *   - clean: no browser prompt, links and Back go ahead;
 *   - dirty: the browser's own prompt on close or reload; an in-app link is
 *     stopped and asks; Back asks; Stay keeps the page (and Back still asks
 *     next time); Leave goes where the recruiter was going, once;
 *   - saved (clean again): nothing asks, and Back carries on.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/unsaved-changes.test.ts"
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));

const { createLeaveGuard, BACK, savedEverything } = await import("./unsaved-changes.ts");

/** A window, document and history: listeners by type, and a history stack. */
function fakeEnv(href = "https://app.test/ai-dashboard/jobs/new") {
  const listeners = { win: new Map(), doc: new Map() };
  const target = (which) => ({
    addEventListener(type, fn) {
      if (!listeners[which].has(type)) listeners[which].set(type, new Set());
      listeners[which].get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners[which].get(type)?.delete(fn);
    },
  });
  const stack = [{ page: "previous" }, { page: "wizard" }];
  const calls = { navigate: [], replace: [], pending: [], back: 0 };
  const fire = (which, type, event) => {
    for (const fn of listeners[which].get(type) ?? []) fn(event);
  };
  const win = {
    ...target("win"),
    location: { href },
    history: {
      pushState(data) {
        stack.push(data);
      },
      back() {
        calls.back += 1;
        stack.pop();
        fire("win", "popstate", {});
      },
    },
  };
  const env = {
    win,
    doc: target("doc"),
    // router.push: a new entry. router.replace: the current entry becomes the page.
    navigate: (to) => {
      calls.navigate.push(to);
      stack.push({ page: to });
    },
    replace: (to) => {
      calls.replace.push(to);
      stack[stack.length - 1] = { page: to };
    },
    onPending: (p) => calls.pending.push(p),
  };
  /** A left click on a link to `href`; returns whether it was stopped. */
  const click = (to, extra = {}) => {
    let stopped = false;
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...extra,
      target: {
        closest: () => ({ href: new URL(to, href).href, target: "", hasAttribute: () => false }),
      },
      preventDefault() {
        stopped = true;
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    fire("doc", "click", event);
    return stopped;
  };
  /** The browser's Back button: pop the top entry. */
  const browserBack = () => {
    stack.pop();
    fire("win", "popstate", {});
  };
  /** Closing the tab or reloading: whether a prompt was asked for. */
  const unload = () => {
    let prompted = false;
    fire("win", "beforeunload", {
      preventDefault() {
        prompted = true;
      },
    });
    return prompted;
  };
  return { env, stack, calls, click, browserBack, unload, listeners };
}

test("clean (nothing changed): no prompt, links go ahead, Back goes back", () => {
  const f = fakeEnv();
  createLeaveGuard(f.env);
  assert.equal(f.unload(), false);
  assert.equal(f.click("/ai-dashboard/jobs"), false);
  assert.deepEqual(f.calls.pending, []);
  assert.equal(f.stack.length, 2, "no extra history entry");
});

test("dirty: closing or reloading gets the browser's own prompt", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  assert.equal(f.unload(), true);
});

test("dirty: an in-app link is stopped and asks; Stay keeps the page; Leave goes there, once", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  assert.equal(f.click("/ai-dashboard/jobs"), true, "stopped");
  assert.deepEqual(f.calls.pending, ["/ai-dashboard/jobs"]);
  g.stay();
  assert.deepEqual(f.calls.navigate, []);
  assert.equal(f.click("/ai-dashboard/applicants"), true, "still guarded after Stay");
  g.leave();
  assert.deepEqual(f.calls.navigate, ["/ai-dashboard/applicants"]);
  assert.deepEqual(f.calls.pending, ["/ai-dashboard/jobs", null, "/ai-dashboard/applicants", null]);
  // Modifier clicks and other sites go ahead (a new tab loses nothing; the browser asks for a site).
  assert.equal(f.click("/ai-dashboard/jobs", { metaKey: true }), false);
  assert.equal(f.click("https://other.example/"), false);
});

test("dirty: the browser's Back asks; Stay keeps the page and Back still asks; Leave goes back for real", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  assert.equal(f.stack.length, 3, "a same-page entry for Back to land on");
  f.browserBack();
  assert.deepEqual(f.calls.pending, [BACK]);
  assert.equal(f.stack.length, 2, "still on the wizard's own entry");
  g.stay();
  assert.equal(f.stack.length, 3, "the entry is back, so the next Back asks again");
  f.browserBack();
  assert.deepEqual(f.calls.pending, [BACK, null, BACK]);
  g.leave();
  assert.equal(f.calls.back, 1, "went back once");
  assert.deepEqual(f.stack, [{ page: "previous" }], "on the previous page");
  assert.deepEqual(f.calls.pending, [BACK, null, BACK, null], "no second dialog on the way out");
});

test("saved on the same page (clean again): no prompt, links go ahead, and the extra entry is gone", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  g.setDirty(false);
  assert.equal(f.unload(), false);
  assert.equal(f.click("/ai-dashboard/jobs"), false);
  assert.deepEqual(f.stack, [{ page: "previous" }, { page: "wizard" }], "as if never pushed");
  assert.deepEqual(f.calls.pending, [], "stepping off it asked nothing");
  f.browserBack();
  assert.deepEqual(f.calls.pending, [], "no dialog");
  assert.deepEqual(f.stack, [{ page: "previous" }], "one Back leaves the wizard");
});

test("edit, save, go to Jobs, Back: lands on the wizard once, exactly as with no warning at all", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  // The wizard's own navigation after a full save: our entry becomes Jobs.
  g.go("/ai-dashboard/jobs");
  g.setDirty(false);
  assert.deepEqual(f.calls.replace, ["/ai-dashboard/jobs"]);
  assert.deepEqual(f.stack, [
    { page: "previous" },
    { page: "wizard" },
    { page: "/ai-dashboard/jobs" },
  ]);
  f.browserBack();
  assert.deepEqual(f.stack, [{ page: "previous" }, { page: "wizard" }], "Back: the wizard, once");
  assert.deepEqual(f.calls.pending, []);
  // Clean, never dirty: go() is a plain navigation.
  const c = fakeEnv();
  createLeaveGuard(c.env).go("/ai-dashboard/jobs");
  assert.deepEqual([c.calls.navigate, c.calls.replace], [["/ai-dashboard/jobs"], []]);
});

test("edit, Back, Stay, save: Back then carries on normally", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  f.browserBack();
  g.stay();
  g.setDirty(false);
  assert.deepEqual(f.stack, [{ page: "previous" }, { page: "wizard" }]);
  f.browserBack();
  assert.deepEqual(f.stack, [{ page: "previous" }], "straight back, no dialog");
  assert.deepEqual(f.calls.pending, [BACK, null], "only the first Back asked");
});

test("a partial save (the questions failed) keeps the form dirty, so a link click still asks", () => {
  assert.equal(savedEverything({ success: true, data: undefined }), true);
  assert.equal(
    savedEverything({
      success: true,
      data: undefined,
      warning:
        "The role saved, but its interview questions were not updated. Your previous questions are kept.",
    }),
    false,
  );
  assert.equal(
    savedEverything({
      success: true,
      data: { id: "j" },
      warning:
        "The role saved, but its interview questions were not saved. Open the job to add them.",
    }),
    false,
  );
  assert.equal(savedEverything({ success: false, error: "x" }), false);
  // So the wizard does not move its baseline, and the guard stays armed.
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  const partial = { success: true, warning: "The role saved, but..." };
  if (savedEverything(partial)) g.setDirty(false);
  assert.equal(f.click("/ai-dashboard/jobs"), true, "the link still asks");
  assert.deepEqual(f.calls.pending, ["/ai-dashboard/jobs"]);
});

test("dispose removes every listener", () => {
  const f = fakeEnv();
  const g = createLeaveGuard(f.env);
  g.setDirty(true);
  g.dispose();
  for (const which of ["win", "doc"]) {
    for (const [, set] of f.listeners[which]) assert.equal(set.size, 0);
  }
});
