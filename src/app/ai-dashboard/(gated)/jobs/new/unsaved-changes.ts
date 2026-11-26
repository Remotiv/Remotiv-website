import { useEffect, useRef, useState } from "react";
import type { CompanyJobInput } from "@/app/ai-dashboard/lib/job-types";

/**
 * The job wizard's unsaved-changes warning (#59).
 *
 * "Dirty" is the form differing from what was last loaded or saved. While it
 * is dirty:
 *   - closing the tab, reloading or typing a new URL gets the browser's own
 *     prompt (beforeunload; browsers show their own words, not ours);
 *   - an in-app link (the sidebar, the "Jobs" button) is stopped and our
 *     dialog asks first;
 *   - the browser's Back (and the trackpad swipe, which is the same thing)
 *     lands on a same-page history entry pushed for this purpose, and our
 *     dialog asks before going back for real.
 * Moving between wizard steps is local state, never a navigation, so it never
 * warns. A successful save resets the baseline, so nothing warns after it.
 */

export const LEAVE_TITLE = "Leave without saving?";
export const LEAVE_BODY = "Your changes to this job will be lost.";
export const STAY_LABEL = "Stay";
export const LEAVE_LABEL = "Leave";

/** The dialog's pending destination when it was the browser's Back. */
export const BACK = "back" as const;

/**
 * What the wizard compares. The description box stands in for the three
 * columns it is parsed into: an effect rewrites those columns from the box on
 * load, and that must not count as a change.
 */
export function formSnapshot(state: CompanyJobInput, jdBox: string): string {
  const { description: _d, responsibilities: _r, requirements: _q, ...rest } = state;
  return JSON.stringify({ ...rest, jdBox });
}

/**
 * Whether a save result moves the baseline: only a FULL success. A save whose
 * job fields landed but whose questions did not (a `warning`) leaves the form
 * dirty, so the warning still asks: what is on screen is not what is stored.
 */
export function savedEverything(result: { success: boolean; warning?: string }): boolean {
  return result.success && !result.warning;
}

/** The form differs from the last loaded or saved one. */
export function isDirty(baseline: string, current: string): boolean {
  return baseline !== current;
}

type Click = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};
type LinkTarget = { href: string; target: string; download: boolean };

/**
 * The in-app page a link click would open, or null when the click must go
 * ahead: no link, another button or a modifier (a new tab or window loses
 * nothing), a download, another window target, another site (beforeunload
 * covers that), or the same page (a hash).
 */
export function guardedHref(click: Click, link: LinkTarget | null, here: string): string | null {
  if (!link || click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (link.download || (link.target && link.target !== "_self")) return null;
  let to: URL;
  let from: URL;
  try {
    to = new URL(link.href, here);
    from = new URL(here);
  } catch {
    return null;
  }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return to.pathname + to.search + to.hash;
}

type Listener = (e: never) => void;
type Target = {
  addEventListener(type: string, fn: Listener, capture?: boolean): void;
  removeEventListener(type: string, fn: Listener, capture?: boolean): void;
};
export type LeaveGuardEnv = {
  win: Target & {
    history: { pushState(data: unknown, unused: string): void; back(): void };
    location: { href: string };
  };
  doc: Target;
  /** In-app navigation, after Leave (the wizard passes router.push). */
  navigate: (href: string) => void;
  /** In-app navigation that takes the current history entry's place (router.replace). */
  replace: (href: string) => void;
  /** The dialog's destination changed: a path, BACK, or null (closed). */
  onPending: (pending: string | null) => void;
};

/**
 * The warning's behaviour, without React: what the hook below wires to the
 * real window and document, and what the tests drive with fakes.
 */
export function createLeaveGuard(env: LeaveGuardEnv) {
  let dirty = false;
  let pending: string | null = null;
  /**
   * Our same-page history entry is the current one. Back pops it before our
   * listener runs, so a Leave that goes back is never stopped a second time.
   */
  let guardOnTop = false;
  const show = (to: string | null) => {
    pending = to;
    env.onPending(to);
  };
  const pushGuard = () => {
    // Next.js copies its own route state into an entry pushed this way, so
    // popping it shows the same page: Back lands here first.
    env.win.history.pushState({ remotivUnsavedGuard: true }, "");
    guardOnTop = true;
  };

  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  // Capture, on the document: before React's own handler, so a <Link> never sees the click.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    const link = a && { href: a.href, target: a.target, download: a.hasAttribute("download") };
    const href = guardedHref(e, link, env.win.location.href);
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    show(href);
  };
  const onPopState = () => {
    if (!guardOnTop) return;
    guardOnTop = false;
    if (dirty) show(BACK);
    // Saved (or put back) since: carry on where Back was going.
    else env.win.history.back();
  };
  env.win.addEventListener("popstate", onPopState as Listener);

  return {
    setDirty(next: boolean) {
      if (next === dirty) return;
      dirty = next;
      if (dirty) {
        env.win.addEventListener("beforeunload", onBeforeUnload as Listener);
        env.doc.addEventListener("click", onClick as Listener, true);
        if (!guardOnTop) pushGuard();
      } else {
        env.win.removeEventListener("beforeunload", onBeforeUnload as Listener);
        env.doc.removeEventListener("click", onClick as Listener, true);
        // Clean again on the same page (saved, or put back): step off our own
        // entry, so Back behaves as if it had never been there. Marked first,
        // so the popstate this causes is not taken for the recruiter's Back.
        if (guardOnTop) {
          guardOnTop = false;
          env.win.history.back();
        }
      }
    },
    /**
     * The page's own navigation after a save. Our entry, if it is on top,
     * becomes the destination (replace), so no extra wizard stop is left
     * behind for Back. Call before the form turns clean.
     */
    go(href: string) {
      if (guardOnTop) {
        guardOnTop = false;
        env.replace(href);
      } else env.navigate(href);
    },
    stay() {
      if (pending === BACK && !guardOnTop) pushGuard();
      show(null);
    },
    leave() {
      const to = pending;
      show(null);
      if (to === BACK) env.win.history.back();
      else if (to) env.navigate(to);
    },
    dispose() {
      env.win.removeEventListener("popstate", onPopState as Listener);
      env.win.removeEventListener("beforeunload", onBeforeUnload as Listener);
      env.doc.removeEventListener("click", onClick as Listener, true);
    },
  };
}

/**
 * The warning for one page. `pending` is where the recruiter was going (a
 * path, or BACK) while the dialog is open; `stay` and `leave` close it.
 */
export function useUnsavedChangesGuard(
  dirty: boolean,
  navigate: (href: string) => void,
  replace: (href: string) => void,
) {
  const [pending, setPending] = useState<string | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const replaceRef = useRef(replace);
  replaceRef.current = replace;
  const guard = useRef<ReturnType<typeof createLeaveGuard> | null>(null);

  useEffect(() => {
    const g = createLeaveGuard({
      win: window as unknown as LeaveGuardEnv["win"],
      doc: document as unknown as LeaveGuardEnv["doc"],
      navigate: (href) => navigateRef.current(href),
      replace: (href) => replaceRef.current(href),
      onPending: setPending,
    });
    guard.current = g;
    return () => {
      g.dispose();
      guard.current = null;
    };
  }, []);

  useEffect(() => {
    guard.current?.setDirty(dirty);
  }, [dirty]);

  return {
    pending,
    stay: () => guard.current?.stay(),
    leave: () => guard.current?.leave(),
    /** The page's own navigation after a save: see `go` above. */
    go: (href: string) => (guard.current ? guard.current.go(href) : navigateRef.current(href)),
  };
}
