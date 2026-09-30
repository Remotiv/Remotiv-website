"use client";

import { AlertCircle, Check, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAnnouncer } from "@/components/live-region";

/**
 * The dashboard's one toast (Phase 6, A6-17).
 *
 * Eight pages used to render their own `{toast && <div>…}`. Four had no live
 * region at all, and the four that did mounted the region together with its
 * text, which screen readers do not reliably announce. This component keeps
 * the visible toast as it was and routes the announcement through the
 * permanently mounted regions in components/live-region.tsx.
 *
 *   success / info → polite, checkmark / info icon, 2.6s
 *   error          → assertive, alert icon, 5s
 *
 * The visible element is aria-hidden so the message is spoken once, by the
 * live region, not twice. Migration is incremental: `showToast(string)` keeps
 * the old call shape (announced as info); pass `{ message, tone }` to mark an
 * error or a success.
 */
export type ToastTone = "success" | "info" | "error";
export type ToastState = { message: string; tone: ToastTone } | null;
export type ShowToast = (toast: string | { message: string; tone?: ToastTone }) => void;

const DISMISS_MS: Record<ToastTone, number> = { success: 2600, info: 2600, error: 5000 };

export function useToast(): [ToastState, ShowToast] {
  const [toast, setToast] = useState<ToastState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback<ShowToast>((input) => {
    const next: ToastState =
      typeof input === "string"
        ? { message: input, tone: "info" }
        : { message: input.message, tone: input.tone ?? "info" };
    setToast(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), DISMISS_MS[next.tone]);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return [toast, showToast];
}

const ICON = {
  success: <Check className="size-4 shrink-0 text-remotiv-green" strokeWidth={2.4} />,
  info: <Info className="size-4 shrink-0 text-remotiv-green" strokeWidth={2.4} />,
  error: <AlertCircle className="size-4 shrink-0 text-[#ff9d8f]" strokeWidth={2.4} />,
};

/** Always mounted, whether or not a toast is showing - that is the point. */
export function Toast({ state }: { state: ToastState }) {
  const { announce, regions } = useAnnouncer();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!state) {
      lastKey.current = null;
      return;
    }
    // A re-render with the same toast must not re-announce; a new toast with
    // the same text must (the announcer alternates its own marker for that).
    const key = `${state.tone}:${state.message}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    announce(state.message, { assertive: state.tone === "error" });
  }, [state, announce]);

  return (
    <>
      {regions}
      {state && (
        <div
          aria-hidden="true"
          data-inert-exempt=""
          className="fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-[13px] bg-[var(--ai-sidebar)] px-[19px] py-[13px] text-[13.5px] font-semibold text-white shadow-[0_18px_44px_rgba(0,0,0,0.34)]"
        >
          {ICON[state.tone]}
          {state.message}
        </div>
      )}
    </>
  );
}
