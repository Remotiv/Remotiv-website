import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  type ApplicantScoreDetail,
  type CompanyApplicantRow,
  type PipelineStage,
  showsWorthALook,
} from "@/app/ai-dashboard/lib/applicant-types";
import { type CompanyRole, canChangeStage } from "@/app/ai-dashboard/lib/company-roles";
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
import type { SplitUnscored } from "./split-unscored";

/**
 * The Applicants Split right panel (Applicants Split, commit 5c; the spec is
 * docs/design/Applicants_Split_v9.md section 2).
 *
 * A page column, not a dialog: a named <section> (role region), no focus
 * trap, no inert page and no Escape handler, so the list beside it stays
 * clickable and Tab walks from the list into the panel and back out. The live
 * drawer, with its trap, opens from the Details button and is unchanged.
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
export const PANEL_FRAME =
  "sticky top-[80px] hidden h-[calc(var(--vh-full)_-_64px_-_16px_-_64px)] flex-col overflow-hidden min-[1100px]:flex rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

const TOP_BTN =
  "inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-[11px] px-4 py-2.5 text-[13.5px] font-bold transition-colors";

/**
 * Close, previous and next: the square controls in the drawer header and the
 * panel's top row (30px, radius 11, v9 section 2 "Top row").
 */
export const PANEL_ICON_BTN =
  "grid size-[30px] shrink-0 place-items-center rounded-[11px] border border-[var(--ai-line)] text-[var(--ai-t3)] transition-colors hover:border-[var(--ai-line-strong)] hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--ai-line)] disabled:hover:bg-transparent disabled:hover:text-[var(--ai-t3)]";

/** v9 `.pc.unsc`: the live card surface, centred, 30px 22px, a 1.5px border the state colours. */
const UNSCORED_FRAME =
  "mb-5 rounded-[20px] border-[1.5px] bg-[var(--ai-surface)] px-[22px] py-[30px] text-center shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

/**
 * v9 `.g2p` from 1280px: 1.32fr / 1fr, 20px apart, 16px between the cards in a
 * column. Below 1280 (1100-1279 and the sheet) one column, in the same order.
 */
const SPLIT_COLUMNS =
  "grid items-start gap-4 min-[1280px]:grid-cols-[minmax(0,1.32fr)_minmax(0,1fr)] min-[1280px]:gap-5";
const SPLIT_COLUMN = "flex min-w-0 flex-col gap-4 *:mb-0";

/** Shortlist applies from Applied and Screening only (v9 section 1). */
const SHORTLIST_FROM: readonly PipelineStage[] = ["applied", "screening"];

/**
 * Whether the panel offers Shortlist (commit 6c): from Applied or Screening,
 * and only when the server's own stage rule (canChangeStage) allows the move
 * for this role. Hidden, never disabled, otherwise: the Stage control beside
 * it already says where the applicant is, so there is never a dead button.
 */
export function canShortlist(role: CompanyRole, stage: PipelineStage): boolean {
  return SHORTLIST_FROM.includes(stage) && canChangeStage(role, stage, "shortlisted");
}

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

export type SplitPanelProps = {
  row: CompanyApplicantRow;
  /** The drawer's identity row, rendered by the client. */
  header: ReactNode;
  /** Null until the panel's read for this row lands, or when it failed. */
  scoreDetail: ApplicantScoreDetail | null;
  /** The panel's read for this row has not landed yet (it may still fail). */
  reading: boolean;
  /** The unscored block for this applicant (split-unscored.ts); null when it has a number. */
  unscored: SplitUnscored;
  screening: Screening;
  applied: { main: string };
  /** Opens the live drawer for this applicant. */
  onDetails: () => void;
  onEmail: () => void;
  dismissing: string | null;
  onDismissFlag: (id: string) => void;
  viewerRole: CompanyRole;
  /**
   * Where this applicant sits in the current view's population ("21 of 128"),
   * or null when no sequence can be stated (off the page, total unknown): then
   * the Previous / Next group is hidden, not shown dead.
   */
  position: { index: number; total: number } | null;
  /** Step to the previous (-1) or next (+1) applicant; crosses pages. */
  onStep: (delta: number) => void;
  /** A step or a list read is in flight: both arrows wait. */
  stepBusy: boolean;
  /** The Shortlist write for this applicant is in flight. */
  shortlisting: boolean;
  /** The last Shortlist attempt for this applicant failed: the sentence to show. */
  shortlistError: string | null;
  onShortlist: () => void;
};

/**
 * The panel itself: the 1100+ page column. A region, never a dialog (see the
 * module note); below 1100 the same content opens as a full-screen sheet in
 * _split-sheet.tsx, which is the one that traps focus (commit 7).
 */
export function SplitPanel(props: SplitPanelProps) {
  return (
    // A <section> with a name IS role="region" (Biome rejects the explicit
    // attribute as redundant); split-panel.test.ts pins both halves.
    <section
      aria-label={`${fullName(props.row)} - applicant detail`}
      data-split-panel
      className={PANEL_FRAME}
    >
      <SplitPanelContent {...props} />
    </section>
  );
}

/**
 * What the panel and the sheet both show: the top row (Shortlist, Details),
 * the identity row, and the scrolling body of cards. Shared so the sheet below
 * 1100 is the same content, not a copy (commit 7).
 */
export function SplitPanelContent({
  row,
  header,
  scoreDetail,
  reading,
  unscored,
  screening,
  applied,
  onDetails,
  onEmail,
  dismissing,
  onDismissFlag,
  viewerRole,
  position,
  onStep,
  stepBusy,
  shortlisting,
  shortlistError,
  onShortlist,
}: SplitPanelProps) {
  const showShortlist = canShortlist(viewerRole, row.pipeline_stage);
  const screeningView = screeningCard(screening);
  const screeningAnswerCount = screeningCount(screening);
  const detailsRow = panelDetailsRow(row);
  const location = [row.city, row.country].filter(Boolean).join(", ");
  const experienceText =
    row.years_experience === null
      ? null
      : `${row.years_experience} year${row.years_experience === 1 ? "" : "s"}`;
  const hasDetails = Boolean(location || experienceText || row.notice_period);
  const scored = scoreDetail?.ai_status === "scored";

  /*
   * v9 `.g2p`: Must-haves and Screening on the left, Application and Details
   * on the right. With nothing for the left (unscored, no screening), the
   * Application card moves left and Details sits beside it; with neither,
   * Application takes the full width.
   */
  const application = <ApplicationCard key="app" row={row} applied={applied} onEmail={onEmail} />;
  const details = hasDetails ? (
    <DetailsCard
      key="details"
      row={detailsRow}
      location={location}
      experienceText={experienceText}
    />
  ) : null;
  let left: ReactNode[] = [
    scored ? <MustHavesBox key="must" scoreDetail={scoreDetail} /> : null,
    // While the answers load, an unscored applicant shows no Screening
    // skeleton: most jobs ask no questions, and a skeleton in the left column
    // would push Application right and then snap it back. Scored, Must-haves
    // already hold the left column, so the skeleton costs nothing there.
    screeningView === "list" ||
    screeningView === "failed" ||
    (screeningView === "loading" && scored) ? (
      <ScreeningQuestionsCard key="screening" screening={screening} screeningView={screeningView} />
    ) : null,
  ].filter(Boolean);
  let right: ReactNode[] = [application, details].filter(Boolean);
  if (left.length === 0) {
    left = [application];
    right = details ? [details] : [];
  }
  const cards =
    right.length > 0 ? (
      <div data-split-columns className={SPLIT_COLUMNS}>
        <div className={SPLIT_COLUMN}>{left}</div>
        <div className={SPLIT_COLUMN}>{right}</div>
      </div>
    ) : (
      left
    );

  /*
   * QA R2 F2 (CLS 0.09 at 1440). For an applicant the list shows as scored,
   * the read brings Summary and Scored dimensions (about 600px) ABOVE the
   * cards. Painting the cards first and inserting those over them pushed the
   * cards out of the panel's view as the read landed. Until it lands, one
   * loading block stands in for all of them, so they appear together and
   * nothing on screen moves. A failed read ends `reading` too: the cards
   * then show without a scorecard, as before. So does a read still in flight
   * after SPLIT_HOLD_CAP_MS (split-hold.ts), so one that never returns cannot
   * hide the cards for good.
   */
  const holdCards = reading && row.score.status === "scored";

  return (
    <>
      <header className="shrink-0 border-b border-[var(--ai-line)] bg-[var(--ai-surface)] px-[22px] pt-4">
        <div className="mb-3.5 flex items-center gap-[9px]">
          {showShortlist && (
            // The same stage write as the drawer's Stage control. Nothing
            // reaches the candidate: `shortlisted` is not a STAGE_EVENTS key
            // (shortlist-no-email.test.ts pins that).
            <button
              type="button"
              onClick={onShortlist}
              disabled={shortlisting}
              aria-busy={shortlisting}
              data-split-shortlist
              className={`${TOP_BTN} bg-[var(--ai-sidebar)] text-white hover:bg-[var(--ai-sidebar-hover)] disabled:cursor-wait disabled:opacity-80`}
            >
              {shortlisting ? (
                <>
                  <Loader2 aria-hidden className="size-4 animate-spin" strokeWidth={2.2} />
                  Shortlisting…
                </>
              ) : (
                "Shortlist"
              )}
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
          {position && (
            <div className="ml-auto flex items-center gap-1.5" data-split-stepper>
              <button
                type="button"
                onClick={() => onStep(-1)}
                disabled={stepBusy || position.index === 0}
                aria-label="Previous applicant"
                className={PANEL_ICON_BTN}
              >
                <ChevronLeft className="size-[14px]" strokeWidth={1.6} />
              </button>
              <span className="px-1.5 text-[11.5px] font-semibold tabular-nums text-[var(--ai-t3)]">
                {position.index + 1} of {position.total}
              </span>
              <button
                type="button"
                onClick={() => onStep(1)}
                disabled={stepBusy || position.index >= position.total - 1}
                aria-label="Next applicant"
                className={PANEL_ICON_BTN}
              >
                <ChevronRight className="size-[14px]" strokeWidth={1.6} />
              </button>
            </div>
          )}
        </div>
        {shortlistError && (
          <div
            role="alert"
            data-split-shortlist-error
            className="-mt-1 mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[11px] border border-[var(--ai-danger)]/30 bg-[var(--ai-danger-tint)] px-3.5 py-2.5 text-[12.5px] font-semibold text-[var(--ai-danger)]"
          >
            <span className="min-w-0">{shortlistError}</span>
            {showShortlist && (
              <button
                type="button"
                onClick={onShortlist}
                disabled={shortlisting}
                className="font-bold underline underline-offset-2 hover:no-underline disabled:opacity-60"
              >
                Try again
              </button>
            )}
          </div>
        )}
        {header}
      </header>

      {/* Normal scroll chaining, on purpose: at its top or bottom the wheel
          moves the page, so the page can be scrolled with the pointer over
          the panel. overscroll-none here (5f) trapped the wheel in the panel
          and left the page scrollable only from the list column (5g). The
          page-level no-bounce rule in ai-dashboard.css stays. */}
      {/* v9 `.pnl-b`: one column, 16px between cards. The shared cards carry
          their own bottom margins for the drawer's Review tab; `*:mb-0` resets
          them here so the gap alone spaces the panel (the drawer is unchanged). */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-[var(--ai-inset)] px-[22px] pb-7 pt-[18px] *:mb-0">
        {showsWorthALook(row) && (
          <WorthALookBanner row={row} dismissing={dismissing} onDismissFlag={onDismissFlag} />
        )}

        {unscored === "loading" ? (
          <LoadingBlock marker="data-split-unscored" />
        ) : (
          unscored && (
            <div
              data-split-unscored={unscored.dashed ? "dashed" : "solid"}
              className={`${UNSCORED_FRAME} ${unscored.dashed ? "border-dashed border-[var(--ai-line-strong)]" : "border-transparent"}`}
            >
              <h3 className="m-0 mb-1.5 font-heading text-[15px] font-bold text-[var(--ai-t1)]">
                {unscored.heading}
              </h3>
              <p className="m-0 mx-auto max-w-[420px] text-[13px] leading-[1.6] text-[var(--ai-t2)]">
                {unscored.body}
              </p>
            </div>
          )
        )}

        {/* The model's own scorecard only, as on the drawer's Review tab. With
            no number, the unscored block above says why instead. */}
        {scored && scoreDetail.summary && (
          <SummaryCard scoreDetail={scoreDetail} screeningAnswerCount={screeningAnswerCount} />
        )}
        {scored && scoreDetail.dimensions.length > 0 && (
          <ScoredDimensionsSection scoreDetail={scoreDetail} />
        )}

        {holdCards ? <LoadingBlock marker="data-split-detail" /> : cards}
      </div>
    </>
  );
}

/** Two pulsing bars that hold a place in the panel while its read is in flight. */
function LoadingBlock({ marker }: { marker: "data-split-unscored" | "data-split-detail" }) {
  return (
    <div
      aria-hidden
      {...{ [marker]: "loading" }}
      className={`${UNSCORED_FRAME} border-transparent`}
    >
      <div className="mx-auto h-4 w-40 animate-pulse rounded-full bg-[var(--ai-inset)]" />
      <div className="mx-auto mt-3 h-3 w-full max-w-[360px] animate-pulse rounded-full bg-[var(--ai-inset)]" />
    </div>
  );
}
