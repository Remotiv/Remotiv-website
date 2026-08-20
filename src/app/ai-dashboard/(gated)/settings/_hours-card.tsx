"use client";

import { useState, useTransition } from "react";
import type { WorkingRule } from "@/lib/calendar/availability";
import { saveWorkingHours } from "./hours-actions";

/**
 * Interview hours, per weekday.
 *
 * ── Why times are shown as a clock and stored as minutes ─────
 *
 * The `<input type="time">` gives "09:00" and that is converted to 540 minutes
 * from local midnight before it leaves this file. Nothing here constructs a
 * Date. A weekly intention is not an instant — "Tuesdays at 9" resolves to a
 * different instant on the Tuesday after a clock change — so it is stored as
 * the intention and resolved against the calendar's zone when slots are built.
 */

const CARD_CLS =
  "mb-4 overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)] last:mb-0";
const FOOT_CLS =
  "flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-3.5";

const DAYS = [
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
  { weekday: 0, label: "Sunday" },
];

const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const toMinutes = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

type DayState = { on: boolean; start: string; end: string };

export function HoursCard({
  initial,
  timezone,
}: {
  initial: WorkingRule[];
  /** The connected calendar's zone. These hours mean nothing without it. */
  timezone: string | null;
}) {
  const [days, setDays] = useState<Record<number, DayState>>(() => {
    const base: Record<number, DayState> = {};
    for (const { weekday } of DAYS) {
      const rule = initial.find((r) => r.weekday === weekday);
      base[weekday] = rule
        ? { on: true, start: toClock(rule.startMinute), end: toClock(rule.endMinute) }
        : { on: false, start: "09:00", end: "17:00" };
    }
    return base;
  });
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const update = (weekday: number, patch: Partial<DayState>) =>
    setDays((prev) => ({ ...prev, [weekday]: { ...prev[weekday], ...patch } as DayState }));

  const save = () => {
    startTransition(async () => {
      const payload = DAYS.filter(({ weekday }) => days[weekday]?.on).map(({ weekday }) => ({
        weekday,
        startMinute: toMinutes(days[weekday]?.start ?? "09:00"),
        endMinute: toMinutes(days[weekday]?.end ?? "17:00"),
      }));
      const result = await saveWorkingHours(payload);
      setNotice({
        ok: result.ok,
        text: result.ok ? "Interview hours saved." : (result.error ?? "Could not save."),
      });
    });
  };

  return (
    <section className={CARD_CLS}>
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <div>
          <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
            Interview hours
          </h2>
          <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
            When candidates may book you. A job can override these for that role.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-mint-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-mint-ink)]">
          Just you
        </span>
      </div>

      <div className="px-6 pb-[22px] pt-[18px]">
        {notice && (
          <p
            className={`mb-4 rounded-[12px] border px-3.5 py-3 text-[12.5px] ${
              notice.ok
                ? "border-[var(--ai-mint-ink)]/20 bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]"
                : "border-amber-300/50 bg-amber-50 text-amber-800"
            }`}
          >
            {notice.text}
          </p>
        )}

        <div className="flex flex-col gap-2">
          {DAYS.map(({ weekday, label }) => {
            const day = days[weekday] ?? { on: false, start: "09:00", end: "17:00" };
            return (
              <div key={weekday} className="flex flex-wrap items-center gap-3">
                <label className="flex min-w-[148px] items-center gap-2.5 text-[13px] font-semibold text-[var(--ai-t1)]">
                  <input
                    type="checkbox"
                    checked={day.on}
                    onChange={(e) => update(weekday, { on: e.target.checked })}
                    className="size-4 accent-remotiv-purple"
                  />
                  {label}
                </label>
                <input
                  type="time"
                  aria-label={`${label} start`}
                  value={day.start}
                  disabled={!day.on}
                  onChange={(e) => update(weekday, { start: e.target.value })}
                  className="rounded-[10px] border border-[var(--ai-line-strong)] px-2.5 py-1.5 text-[13px] disabled:opacity-40"
                />
                <span className="text-[13px] text-[var(--ai-t3)]">to</span>
                <input
                  type="time"
                  aria-label={`${label} finish`}
                  value={day.end}
                  disabled={!day.on}
                  onChange={(e) => update(weekday, { end: e.target.value })}
                  className="rounded-[10px] border border-[var(--ai-line-strong)] px-2.5 py-1.5 text-[13px] disabled:opacity-40"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className={FOOT_CLS}>
        <p className="m-0 text-[12px] leading-relaxed text-[var(--ai-t3)]">
          {timezone ? (
            <>
              Read in <b className="font-bold text-[var(--ai-t2)]">{timezone}</b>, your calendar's
              timezone. Candidates see these times converted to their own.
            </>
          ) : (
            <>Connect a calendar above — these hours need its timezone to mean anything.</>
          )}
        </p>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="shrink-0 rounded-[11px] bg-remotiv-purple px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[#6D38F0] disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save hours"}
        </button>
      </div>
    </section>
  );
}
