/**
 * The modal stack rules behind useModalFocus (Phase 6, A6-16): nested layers,
 * Escape reaching one layer, focus returning into the parent, Tab cycling,
 * and the inert-outside set.
 *
 *   node --test src/lib/a11y/modal-stack.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeTarget,
  focusAfterClose,
  isTop,
  nextFocusTarget,
  outsideOf,
  pushEntry,
  removeEntry,
  topId,
} from "./modal-stack.ts";

/** Elements are plain tokens; `connected` models document.contains. */
const connected = new Set(["row-button", "delete-button-in-drawer"]);
const isConnected = (el) => connected.has(el);

test("the nested scenario, step by step", () => {
  // 1. Parent modal (the applicant drawer) opens from a row button.
  let stack = pushEntry([], { id: "drawer", opener: "row-button" });
  assert.equal(isTop(stack, "drawer"), true);
  assert.equal(escapeTarget(stack), "drawer");

  // 2. A child (Delete confirm) opens from a button inside the drawer.
  stack = pushEntry(stack, { id: "confirm", opener: "delete-button-in-drawer" });

  // 3. The child is topmost: it alone traps and answers Escape; the parent is suspended.
  assert.equal(topId(stack), "confirm");
  assert.equal(isTop(stack, "drawer"), false);
  assert.equal(escapeTarget(stack), "confirm");

  // 4. Escape closes the child only.
  const afterChild = focusAfterClose(stack, "confirm", isConnected);
  stack = removeEntry(stack, "confirm");
  assert.equal(stack.length, 1, "one Escape, one layer");
  assert.equal(topId(stack), "drawer");

  // 5. Focus returns INTO the parent: to the button that opened the child.
  assert.deepEqual(afterChild, { kind: "opener", target: "delete-button-in-drawer" });

  // 6. The parent trap resumes: it is top again and answers Escape.
  assert.equal(escapeTarget(stack), "drawer");

  // 7. The parent closes and returns focus to its ORIGINAL opener.
  const afterParent = focusAfterClose(stack, "drawer", isConnected);
  stack = removeEntry(stack, "drawer");
  assert.deepEqual(afterParent, { kind: "opener", target: "row-button" });
  assert.equal(topId(stack), null, "nothing left to trap or inert");
});

test("a child whose opener has unmounted returns focus into the parent container", () => {
  const stack = pushEntry(pushEntry([], { id: "drawer", opener: "row-button" }), {
    id: "confirm",
    opener: "gone-button",
  });
  assert.deepEqual(focusAfterClose(stack, "confirm", isConnected), {
    kind: "parent",
    parentId: "drawer",
  });
});

test("a top-level modal whose opener unmounted has nowhere to return to, and says so", () => {
  const stack = pushEntry([], { id: "dialog", opener: "gone" });
  assert.deepEqual(focusAfterClose(stack, "dialog", isConnected), { kind: "none" });
  assert.deepEqual(
    focusAfterClose(stack, "dialog", () => true),
    {
      kind: "opener",
      target: "gone",
    },
  );
  assert.deepEqual(focusAfterClose(pushEntry([], { id: "d", opener: null }), "d", isConnected), {
    kind: "none",
  });
});

test("re-registering the same id moves it to the top without duplicating it", () => {
  const stack = pushEntry(
    pushEntry(pushEntry([], { id: "a", opener: null }), { id: "b", opener: null }),
    {
      id: "a",
      opener: null,
    },
  );
  assert.deepEqual(
    stack.map((e) => e.id),
    ["b", "a"],
  );
});

test("Tab cycling wraps at both ends and pulls focus back in when it escaped", () => {
  const items = ["close", "first-name", "submit"];
  assert.equal(nextFocusTarget(items, "submit", false), "close", "Tab on last wraps to first");
  assert.equal(nextFocusTarget(items, "close", true), "submit", "Shift+Tab on first wraps to last");
  assert.equal(
    nextFocusTarget(items, "first-name", false),
    null,
    "in the middle, browser handles it",
  );
  assert.equal(nextFocusTarget(items, "first-name", true), null);
  assert.equal(nextFocusTarget(items, "outside", false), "close", "escaped: pull back to first");
  assert.equal(
    nextFocusTarget(items, "outside", true),
    "submit",
    "escaped + shift: pull back to last",
  );
  assert.equal(nextFocusTarget(items, null, false), "close");
  assert.equal(nextFocusTarget([], "x", false), null, "nothing focusable: leave it");
});

test("outsideOf collects every sibling up the chain and skips exempt nodes; the modal chain itself is never included", () => {
  // body > [ root > [ page, portal > [ overlay > [ scrim, panel ] ] ], toast(exempt), script(exempt) ]
  const tree = {
    body: ["root", "toast", "script"],
    root: ["page", "portal"],
    portal: ["overlay"],
    overlay: ["scrim", "panel"],
  };
  const parentOf = {};
  for (const [p, kids] of Object.entries(tree)) for (const k of kids) parentOf[k] = p;
  const api = {
    parent: (n) => parentOf[n] ?? null,
    children: (n) => tree[n] ?? [],
    isExempt: (n) => n === "toast" || n === "script",
  };
  assert.deepEqual(outsideOf("overlay", "body", api), ["page"]);
  // For a child modal opened over that one, the parent's overlay is a sibling
  // at the portal level and becomes inert too.
  tree.portal = ["overlay", "child-overlay"];
  parentOf["child-overlay"] = "portal";
  assert.deepEqual(outsideOf("child-overlay", "body", api), ["overlay", "page"]);
});
