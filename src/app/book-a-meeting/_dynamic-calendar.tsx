"use client";

import { useEffect, useState } from "react";

// Decorative calendar only — the real scheduler is the Calendly iframe below.
// We render the current month with today highlighted, but make no claim about
// per-day availability.
function dayCellClass(dayNum: number | null, todayNum: number): string {
  if (dayNum === null) return "pointer-events-none opacity-0";
  if (dayNum === todayNum) return "bg-remotiv-lime-card font-semibold text-[#2a5c00]";
  return "text-[#333]";
}

function buildMonthCells(date: Date): (number | null)[] {
  const year = date.getFullYear();
  const month = date.getMonth();
  const leading = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  return Array.from({ length: totalCells }, (_, i) => {
    const dayNum = i - leading + 1;
    return dayNum >= 1 && dayNum <= daysInMonth ? dayNum : null;
  });
}

export default function DynamicCalendar() {
  // Calendar month is computed client-side after mount so the static prerender
  // doesn't bake in a stale month at build time.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const monthName = now?.toLocaleString("en-US", { month: "long" }) ?? "";
  const year = now?.getFullYear() ?? "";
  const todayNum = now?.getDate() ?? 0;
  const monthCells = now ? buildMonthCells(now) : [];

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-[10px]">
          <div className="flex size-9 items-center justify-center rounded-[10px] bg-remotiv-purple">
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="2"
                y="4"
                width="14"
                height="12"
                rx="2"
                stroke="white"
                strokeWidth="1.5"
              />
              <path
                d="M6 2v3M12 2v3M2 8h14"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <div className="font-heading text-[15px] font-semibold text-remotiv-text-dark">
              {monthName}
            </div>
            <div className="mt-px text-xs text-[#888]">{year}</div>
          </div>
        </div>
        <div className="font-heading text-[22px] font-bold text-remotiv-text-dark">
          Availability
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div
            key={`${d}-${i}`}
            className="pb-1.5 text-center text-[11px] font-medium text-[#aaa]"
          >
            {d}
          </div>
        ))}
        {monthCells.map((dayNum, i) => (
          <div
            key={i}
            className={`mx-auto flex size-8 items-center justify-center rounded-full text-[13px] sm:size-9 ${dayCellClass(dayNum, todayNum)}`}
          >
            {dayNum ?? ""}
          </div>
        ))}
      </div>
    </>
  );
}
