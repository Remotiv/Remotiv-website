"use client";

import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  PANEL_FRAME,
  SPLIT_CARD_WIDE,
  SPLIT_TOOLBAR_WIDE,
  SplitLayout,
  SplitListColumn,
} from "./_split-panel";

const PULSE = "animate-pulse bg-[var(--ai-line-soft)]";
const SHIMMER = `${PULSE} rounded-lg`;
/** Avatars and score rings: their own radius, not SHIMMER's rounded-lg. */
const CIRCLE = `${PULSE} rounded-full`;
const ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

/**
 * The Applicants loading state in the Split shape (C3), rendered by
 * loading.tsx when Split is on.
 *
 * The same wrappers the page renders (SplitLayout, the toolbar card,
 * SplitListColumn, the panel frame), so the page drops into the skeleton's
 * boxes instead of moving them. Heights inside are the real page's, measured
 * on staging: header 89 / 113 / 173 CSS px at 1440 / 840 / 375, the stage
 * strip 42 / 74 / 107 as it wraps, the controls row 37 (82 when it wraps),
 * list rows 90.
 *
 * A client module only because the wrappers live beside client components in
 * _split-panel.tsx; it has no state of its own.
 */
function HeaderSkeleton() {
  return (
    <div className="mb-5 flex flex-col items-start justify-between gap-4 min-[525px]:flex-row min-[525px]:items-end min-[525px]:gap-6">
      <div className="w-full max-w-[520px]">
        <div className={`${SHIMMER} h-8 w-44`} />
        <div className={`${SHIMMER} mt-2.5 h-[71px] w-full min-[1100px]:h-[47px]`} />
      </div>
      <div className={`${SHIMMER} h-[42px] w-[260px] shrink-0`} />
    </div>
  );
}

/**
 * Mint block + ink breakdown, matching DashboardHero, at the real hero's height:
 * 149 CSS px side by side (1180+), 276 stacked, 293 at phone width.
 */
function HeroSkeleton() {
  return (
    <div className="mb-[26px] grid h-[293px] grid-cols-1 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] min-[640px]:h-[276px] min-[1180px]:h-[149px] min-[1180px]:grid-cols-[340px_minmax(0,1fr)]">
      <div className="flex flex-col justify-center bg-remotiv-green px-[26px] py-[22px] min-[1180px]:px-7 min-[1180px]:py-[26px]">
        <div className="h-3 w-28 animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
        <div className="mt-3 h-11 w-32 animate-pulse rounded-lg bg-[rgba(4,52,44,0.16)]" />
        <div className="mt-3 h-3 w-40 animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
      </div>
      <div className="px-[26px] py-[22px] min-[1180px]:px-[30px] min-[1180px]:py-[26px]">
        <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-8 w-40 animate-pulse rounded bg-white/10" />
      </div>
    </div>
  );
}

export function SplitSkeleton() {
  return (
    <PageContainer>
      <div aria-busy="true" data-applicants-skeleton="split">
        <HeaderSkeleton />
        <HeroSkeleton />
        <SplitLayout
          panel={
            <aside aria-hidden className={PANEL_FRAME} data-skeleton-panel>
              <div className="shrink-0 border-b border-[var(--ai-line)] px-[22px] pb-4 pt-4">
                <div className="mb-3.5 flex gap-[9px]">
                  <div className={`${SHIMMER} h-[38px] w-24`} />
                  <div className={`${SHIMMER} h-[38px] w-20`} />
                </div>
                <div className="flex items-center gap-3.5">
                  <div className={`${CIRCLE} size-[54px] shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <div className={`${SHIMMER} h-5 w-56`} />
                    <div className={`${SHIMMER} mt-2 h-3 w-72 max-w-full`} />
                  </div>
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-4 bg-[var(--ai-inset)] px-[22px] pt-[18px]">
                <div className={`${SHIMMER} h-28 rounded-[20px] bg-[var(--ai-surface)]`} />
                <div className={`${SHIMMER} h-48 rounded-[20px] bg-[var(--ai-surface)]`} />
              </div>
            </aside>
          }
        >
          <div
            className={`overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)] ${SPLIT_CARD_WIDE}`}
          >
            <div
              className={`flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5 ${SPLIT_TOOLBAR_WIDE}`}
            >
              <div
                className={`${SHIMMER} h-[107px] w-full min-[640px]:h-[74px] min-[1100px]:h-[42px] min-[1100px]:w-[873px] min-[1100px]:max-w-full`}
              />
              <div
                className={`${SHIMMER} h-[82px] w-full min-[640px]:h-[37px] min-[640px]:w-[648px] min-[640px]:max-w-full`}
              />
            </div>
            <SplitListColumn fullWidth={false}>
              {ROW_KEYS.map((k) => (
                <div
                  key={k}
                  className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--ai-line-soft)] px-5 py-[13px]"
                >
                  <div className={`${CIRCLE} size-10`} />
                  <div className="flex h-16 min-w-0 flex-col justify-center gap-2">
                    <div className={`${SHIMMER} h-4 w-40`} />
                    <div className={`${SHIMMER} h-3 w-52 max-w-full`} />
                    <div className={`${SHIMMER} h-3 w-24`} />
                  </div>
                  <div className={`${CIRCLE} size-[38px]`} />
                </div>
              ))}
            </SplitListColumn>
          </div>
        </SplitLayout>
      </div>
    </PageContainer>
  );
}
