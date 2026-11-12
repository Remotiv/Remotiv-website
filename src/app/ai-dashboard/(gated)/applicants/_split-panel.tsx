import type { ReactNode } from "react";
import {
  type ApplicantScoreDetail,
  type CompanyApplicantRow,
  showsWorthALook,
} from "@/app/ai-dashboard/lib/applicant-types";
import {
  ApplicationCard,
  DetailsCard,
  MustHavesBox,
  ScoredDimensionsSection,
  ScreeningQuestionsCard,
  SummaryCard,
  WorthALookBanner,
} from "./_drawer-parts";
import { fullName } from "./_list-row-parts";
import { type Screening, screeningCard, screeningCount } from "./screening-state";

/**
 * The Applicants Split right panel (Applicants Split, commit 5c; the spec is
 * docs/design/Applicants_Split_v9.md section 2).
 *
 * A page column, not a dialog: a named <section> (role region), no focus
 * trap, no inert page and no Escape handler, so the list beside it stays
 * clickable and Tab walks from the list into the panel and back out. The live drawer, with its trap, opens
 * from the Details button and is unchanged.
 *
 * Every card is a drawer component from _drawer-parts.tsx. The identity row
 * comes in as `header` because it is defined in _applicants-client.tsx, where
 * drawer-header.test.ts and company-roles.test.ts pin it.
 */

/**
 * Sticky below the 64px topbar with a 16px gap (top 80), all at CSS size
 * inside the shell's 0.82 zoom.
 *
 * The height leaves room for what sits below the grid too: a sticky box can
 * never leave its containing block (the Split grid), and PageContainer's
 * pb-16 puts the grid's end 64px above the viewport's bottom once the page is
 * scrolled all the way down. A panel taller than "viewport - 80 - 64" was
 * pushed up by the difference there and slid 25 real px under the topbar
 * (commit 5f). So: viewport - topbar 64 - gap 16 - page bottom padding 64.
 *
 * var(--vh-full), never h-screen: vh resolves against the unzoomed viewport
 * inside .ai-shell and would come out 18% short.
 */
const PANEL_FRAME =
  "sticky top-[80px] hidden h-[calc(var(--vh-full)_-_64px_-_16px_-_64px)] flex-col overflow-hidden min-[1100px]:flex rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

const TOP_BTN =
  "inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-[11px] px-4 py-2.5 text-[13.5px] font-bold transition-colors";

/** Shortlist applies from Applied and Screening only (v9 section 1). */
const SHORTLIST_FROM = new Set(["applied", "screening"]);

/**
 * The Details card in the panel shows Location, Experience and Notice period
 * only (v9 section 2). Availability, Phone and LinkedIn stay in the drawer, so
 * the shared card is handed a row without them.
 */
function panelDetailsRow(row: CompanyApplicantRow): CompanyApplicantRow {
  return { ...row, availability: null, phone: null, linkedin_url: null };
}

/*
 * ── The page layout around the panel ─────────────────────────
 *
 * Below 1100 real px nothing here applies, and with the flag off none of it
 * renders: SplitLayout and SplitListColumn hand back their children as they
 * are, so the live page keeps its exact DOM.
 *
 * At 1100+ the live list card becomes `display: contents`, so its toolbar and
 * its list body are placed by the grid directly: the toolbar across both
 * columns, the list body (rows, notices and the pager) in the 400px column,
 * and the panel beside it.
 */

const WIDE_CARD =
  "min-[1100px]:rounded-[20px] min-[1100px]:border min-[1100px]:border-[var(--ai-line)] min-[1100px]:bg-[var(--ai-surface)] min-[1100px]:shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

/** Added to the live list card's class: at 1100+ the grid places its children. */
export const SPLIT_CARD_WIDE = "min-[1100px]:contents";

/** Added to the live toolbar's class: at 1100+ it is a card of its own across both columns. */
export const SPLIT_TOOLBAR_WIDE = `${WIDE_CARD} min-[1100px]:col-span-2`;

export function SplitLayout({
  split,
  panel,
  children,
}: {
  split: boolean;
  panel: ReactNode;
  children: ReactNode;
}) {
  if (!split) return <>{children}</>;
  return (
    <div
      data-split-layout
      className="min-[1100px]:grid min-[1100px]:grid-cols-[400px_minmax(0,1fr)] min-[1100px]:items-start min-[1100px]:gap-[18px]"
    >
      {children}
      {panel}
    </div>
  );
}

export function SplitListColumn({
  split,
  fullWidth,
  children,
}: {
  split: boolean;
  /** No panel beside it: an empty list spans both columns (v9 state 9). */
  fullWidth: boolean;
  children: ReactNode;
}) {
  if (!split) return <>{children}</>;
  return (
    <div
      data-split-list-column
      className={`${WIDE_CARD} min-[1100px]:overflow-hidden ${fullWidth ? "min-[1100px]:col-span-2" : ""}`}
    >
      {children}
    </div>
  );
}

export function SplitPanel({
  row,
  header,
  scoreDetail,
  screening,
  applied,
  onDetails,
  onEmail,
  dismissing,
  onDismissFlag,
}: {
  row: CompanyApplicantRow;
  /** The drawer's identity row, rendered by the client. */
  header: ReactNode;
  /** Null until the panel's read for this row lands, or when it failed. */
  scoreDetail: ApplicantScoreDetail | null;
  screening: Screening;
  applied: { main: string };
  /** Opens the live drawer for this applicant. */
  onDetails: () => void;
  onEmail: () => void;
  dismissing: string | null;
  onDismissFlag: (id: string) => void;
}) {
  const screeningView = screeningCard(screening);
  const screeningAnswerCount = screeningCount(screening);
  const detailsRow = panelDetailsRow(row);
  const location = [row.city, row.country].filter(Boolean).join(", ");
  const experienceText =
    row.years_experience === null
      ? null
      : `${row.years_experience} year${row.years_experience === 1 ? "" : "s"}`;
  const hasDetails = Boolean(location || experienceText || row.notice_period);

  return (
    // A <section> with a name IS role="region" (Biome rejects the explicit
    // attribute as redundant); split-panel.test.ts pins both halves.
    <section
      aria-label={`${fullName(row)} - applicant detail`}
      data-split-panel
      className={PANEL_FRAME}
    >
      <header className="shrink-0 border-b border-[var(--ai-line)] bg-[var(--ai-surface)] px-[22px] pt-4">
        <div className="mb-3.5 flex items-center gap-[9px]">
          {SHORTLIST_FROM.has(row.pipeline_stage) && (
            // A placeholder until commit 6 wires the write. Disabled rather
            // than a button that silently does nothing.
            <button
              type="button"
              disabled
              data-split-shortlist
              title="Shortlisting from this panel is coming soon. Use the Stage control for now."
              className={`${TOP_BTN} bg-[var(--ai-sidebar)] text-white disabled:cursor-not-allowed disabled:opacity-60`}
            >
              Shortlist
            </button>
          )}
          <button
            type="button"
            onClick={onDetails}
            data-split-details
            className={`${TOP_BTN} border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] text-[var(--ai-t1)] hover:bg-[var(--ai-inset)]`}
          >
            Details
          </button>
        </div>
        {header}
      </header>

      {/* overscroll-none, not -contain: both stop the panel's scroll from
          handing off to the page, but -contain still lets the body itself
          bounce, which showed as a blank gap above the first card (5f). */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none bg-[var(--ai-inset)] px-[22px] pb-7 pt-[18px]">
        {showsWorthALook(row) && (
          <WorthALookBanner row={row} dismissing={dismissing} onDismissFlag={onDismissFlag} />
        )}

        {/* The model's own scorecard only, as on the drawer's Review tab. An
            unscored row shows no score block here; Details carries it. */}
        {scoreDetail?.ai_status === "scored" && (
          <>
            {scoreDetail.summary && (
              <SummaryCard scoreDetail={scoreDetail} screeningAnswerCount={screeningAnswerCount} />
            )}
            {scoreDetail.dimensions.length > 0 && (
              <ScoredDimensionsSection scoreDetail={scoreDetail} />
            )}
            <div className="mb-7">
              <MustHavesBox scoreDetail={scoreDetail} />
            </div>
          </>
        )}

        <div className="flex flex-col gap-5">
          {screeningView !== "empty" && (
            <ScreeningQuestionsCard screening={screening} screeningView={screeningView} />
          )}
          <div className={hasDetails ? "grid items-start gap-5 min-[1280px]:grid-cols-2" : ""}>
            <ApplicationCard row={row} applied={applied} onEmail={onEmail} />
            {hasDetails && (
              <DetailsCard row={detailsRow} location={location} experienceText={experienceText} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
