/**
 * The rules behind useModalFocus (src/hooks/use-modal-focus.ts), as pure
 * functions so they can be tested without a DOM.
 *
 * ── The stack ────────────────────────────────────────────────
 *
 * Open modals form a stack. Only the TOP entry traps Tab, answers Escape and
 * owns the inert background; a parent whose child is open is suspended, not
 * closed, and keeps the opener it will return focus to. Closing the top entry
 * returns focus to its own opener when that is still in the document (for a
 * child modal that opener is a button inside the parent, which is exactly
 * "focus returns into the parent"), otherwise into the parent's container,
 * otherwise nowhere. One Escape press reaches one layer.
 *
 * ── Tab cycling ──────────────────────────────────────────────
 *
 * Wraps at both ends, and pulls focus back in when it has escaped the
 * container entirely, which happens on the first Tab after a click on the
 * scrim. Returns null when the browser should handle the key itself.
 *
 * ── Inert outside ────────────────────────────────────────────
 *
 * `outsideOf` walks from the overlay up to the root and collects every
 * sibling on the way, skipping exempt nodes (live regions and toasts, which
 * must keep announcing while a modal is open). Those nodes get `inert`; the
 * modal's own ancestors never do, so the modal itself stays live. For a child
 * modal this set naturally includes the parent's overlay.
 */

export type StackEntry<T> = { id: string; opener: T | null };

export function pushEntry<T>(
  stack: readonly StackEntry<T>[],
  entry: StackEntry<T>,
): StackEntry<T>[] {
  return [...stack.filter((e) => e.id !== entry.id), entry];
}

export function removeEntry<T>(stack: readonly StackEntry<T>[], id: string): StackEntry<T>[] {
  return stack.filter((e) => e.id !== id);
}

export function topId<T>(stack: readonly StackEntry<T>[]): string | null {
  return stack.length === 0 ? null : stack[stack.length - 1].id;
}

export function isTop<T>(stack: readonly StackEntry<T>[], id: string): boolean {
  return topId(stack) === id;
}

export type CloseFocus<T> =
  | { kind: "opener"; target: T }
  | { kind: "parent"; parentId: string }
  | { kind: "none" };

/**
 * Where focus goes when `id` closes. Decided against the stack as it was
 * BEFORE removal, so the parent is the entry directly beneath.
 */
export function focusAfterClose<T>(
  stack: readonly StackEntry<T>[],
  id: string,
  isConnected: (target: T) => boolean,
): CloseFocus<T> {
  const index = stack.findIndex((e) => e.id === id);
  if (index === -1) return { kind: "none" };
  const entry = stack[index];
  if (entry.opener !== null && isConnected(entry.opener)) {
    return { kind: "opener", target: entry.opener };
  }
  if (index > 0) return { kind: "parent", parentId: stack[index - 1].id };
  return { kind: "none" };
}

/** Which layer an Escape press reaches: the top one only, or none. */
export function escapeTarget<T>(stack: readonly StackEntry<T>[]): string | null {
  return topId(stack);
}

/**
 * The element to focus on Tab / Shift+Tab inside a trapped container, or null
 * to let the browser move focus normally.
 */
export function nextFocusTarget<T>(
  focusables: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = active !== null && focusables.includes(active);
  if (!inside) return shiftKey ? last : first;
  if (shiftKey) return active === first ? last : null;
  return active === last ? first : null;
}

export type TreeApi<N> = {
  parent(node: N): N | null;
  children(node: N): readonly N[];
  isExempt(node: N): boolean;
};

/**
 * Every node outside `overlay`'s ancestor chain, up to and excluding `root`:
 * the set that becomes inert while the overlay is the top modal.
 */
export function outsideOf<N>(overlay: N, root: N, api: TreeApi<N>): N[] {
  const out: N[] = [];
  let node: N = overlay;
  for (;;) {
    const parent = api.parent(node);
    if (parent === null) break;
    for (const sibling of api.children(parent)) {
      if (sibling !== node && !api.isExempt(sibling)) out.push(sibling);
    }
    if (parent === root) break;
    node = parent;
  }
  return out;
}
