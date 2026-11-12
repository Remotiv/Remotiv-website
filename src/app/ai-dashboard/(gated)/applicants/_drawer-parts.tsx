import {
  AlertTriangle,
  Check,
  ChevronRight,
  ExternalLink,
  File,
  Flag,
  Mail,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  ApplicantScoreDetail,
  CompanyApplicantRow,
  ScoreDimensionRow,
} from "@/app/ai-dashboard/lib/applicant-types";
import { AddedByTeamChip } from "./_list-row-parts";
import type { Screening, ScreeningCard } from "./screening-state";

/**
 * Display pieces of the applicant drawer that the Applicants Split panel will
 * reuse: the rings, the Review card sections, the pane card and the detail
 * rows. Moved here unchanged from _applicants-client.tsx (Applicants Split,
 * commit 5a) so the panel can use them without importing the client module.
 */

/**
 * Three states, not two. An expired CV is not a missing one — it was here, it
 * was read, and it reached the end of its retention. Labelling that "No CV"
 * blames the applicant for a deletion we performed on schedule.
 */
export function cvLabel(row: CompanyApplicantRow): string {
  if (row.has_cv) return "Open CV";
  return row.cv_expired ? "CV expired" : "No CV";
}

export function scoreBand(score: number): { stroke: string; ink: string } {
  if (score >= 80) return { stroke: "#49D7A7", ink: "#04342C" };
  if (score >= 60) return { stroke: "#F5A524", ink: "#7A4E05" };
  return { stroke: "#E0524B", ink: "#B02A24" };
}

export const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const DIMENSION_LABEL: Record<string, string> = {
  requirements_match: "Requirements match",
  experience_depth: "Experience depth",
  domain_relevance: "Domain relevance",
  responsibilities_fit: "Responsibilities fit",
};

/**
 * Colour for the confidence badge on the Review card.
 *
 * The design only draws the "high" case, and always in mint. Reusing mint for
 * the other two would put a success colour on the words "Low confidence",
 * which is the one reading that must not happen — so the other two bands take
 * the tokens they already have elsewhere in the panel.
 */
export const CONFIDENCE_BADGE: Record<string, { pill: string; dot: string }> = {
  high: { pill: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]", dot: "bg-remotiv-green" },
  medium: {
    pill: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
    dot: "bg-[var(--ai-amber-dot)]",
  },
  low: { pill: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]", dot: "bg-[var(--ai-t3)]" },
};

/** The 3px separator between the header's identity facts. */
export function IdDot() {
  return <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-[var(--ai-t4)]" />;
}

/** 42px ring for the panel header. */
export function DrawerMiniRing({ score }: { score: number }) {
  const C = 2 * Math.PI * 18;
  const band = scoreBand(score);
  return (
    <span className="relative flex size-[42px] shrink-0 items-center justify-center">
      <svg className="size-[42px] -rotate-90" viewBox="0 0 42 42" aria-hidden>
        <circle cx="21" cy="21" r="18" fill="none" stroke="var(--ai-slate-tint)" strokeWidth="4" />
        <circle
          cx="21"
          cy="21"
          r="18"
          fill="none"
          stroke={band.stroke}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C.toFixed(2)}
          strokeDashoffset={(C * (1 - score / 100)).toFixed(2)}
        />
      </svg>
      <span className="absolute font-heading text-sm font-extrabold tracking-[-0.035em] tabular-nums text-[var(--ai-t1)]">
        {score}
      </span>
    </span>
  );
}

/**
 * 112px ring for the Review card, on the light surface.
 *
 * A separate component rather than a `dark` flag on one: the track colour, the
 * numeral colour and the "out of 100" caption are most of what the thing is,
 * so a shared shell would read as one component and behave as two.
 */
export function ReviewScoreRing({ score }: { score: number }) {
  const C = 2 * Math.PI * 49;
  const band = scoreBand(score);
  return (
    <span className="relative flex size-[112px] shrink-0 items-center justify-center">
      <svg className="size-[112px] -rotate-90" viewBox="0 0 112 112" aria-hidden>
        <circle cx="56" cy="56" r="49" fill="none" stroke="var(--ai-slate-tint)" strokeWidth="9" />
        <circle
          cx="56"
          cy="56"
          r="49"
          fill="none"
          stroke={band.stroke}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={C.toFixed(2)}
          strokeDashoffset={(C * (1 - score / 100)).toFixed(2)}
        />
      </svg>
      <span className="absolute flex flex-col items-center gap-0.5">
        <b className="font-heading text-[34px] font-extrabold leading-none tracking-[-0.045em] tabular-nums text-[var(--ai-t1)]">
          {score}
        </b>
        <i className="text-[10.5px] font-bold uppercase not-italic tracking-[0.06em] text-[var(--ai-t3)]">
          out of 100
        </i>
      </span>
    </span>
  );
}

/**
 * The verified CV span, hidden behind a per-item toggle.
 *
 * PER ITEM rather than one switch for the whole card, on purpose. A recruiter
 * checking a scorecard is almost never asking "show me all twelve quotes" —
 * they are asking "is THAT one claim real?", usually the one that decides it.
 * A single card-level toggle answers a question nobody asked and dumps the
 * full wall of prose back on screen, which is the problem being fixed. Per
 * item keeps the default scannable while making any single claim one click
 * from proof, and the open/closed state stays local so opening one does not
 * expand the rest.
 */
export function EvidenceQuote({ quote }: { quote: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
      >
        <ChevronRight
          className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
          strokeWidth={2.2}
        />
        {open ? "Hide evidence" : "View evidence"}
      </button>
      {open && (
        <p className="m-0 mt-1.5 border-l-2 border-[var(--ai-line-strong)] pl-2.5 text-[12px] italic leading-snug text-[var(--ai-t3)]">
          &ldquo;{quote}&rdquo;
        </p>
      )}
    </div>
  );
}

/** The design's `.card` — the white panel every block in every pane sits in. */
export const CARD_SURFACE =
  "rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

/**
 * A section heading with a rule running to a right-aligned sub-line.
 *
 * The sub-line is optional, and where the design put an invented one — the
 * dimensions' "Weighted to 87 · model v4.2" — this renders nothing rather than
 * a plausible number.
 */
export function ReviewSubhead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-[13px] flex items-center gap-3">
      <h2 className="m-0 whitespace-nowrap font-heading text-[15px] font-bold tracking-[-0.025em] text-[var(--ai-t1)]">
        {title}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-[var(--ai-line)]" />
      {meta && <span className="shrink-0 text-[11px] font-medium text-[var(--ai-t3)]">{meta}</span>}
    </div>
  );
}

/**
 * A dimension's supporting CV span, shown open.
 *
 * The toggle in EvidenceQuote exists because the lists can run to a dozen
 * quotes; a scorecard has at most four dimensions, and a bar with no quote
 * under it is just an assertion. So this one renders expanded and is styled as
 * a quotation rather than as a disclosure.
 */
function DimQuote({ quote }: { quote: string }) {
  return (
    <figure className="m-0 mt-3 overflow-hidden rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
      <blockquote className="relative m-0 py-[13px] pl-[42px] pr-4 text-[13px] font-medium leading-[1.65] text-[var(--ai-t1)]">
        <span
          aria-hidden
          className="absolute left-[15px] top-[11px] font-heading text-[30px] font-extrabold leading-none text-remotiv-purple opacity-30"
        >
          &ldquo;
        </span>
        {quote}
      </blockquote>
    </figure>
  );
}

/**
 * One of Evidence's four boxes: a tinted badge, a real count, and its rows.
 *
 * The count is the length of the array being rendered, or evidenced-over-total
 * on the must-haves — see the Must-haves block for why a ratio is on screen at
 * all, given CriterionRow used to argue against exactly that.
 */
export function EvidenceList({
  label,
  badge,
  dot,
  count,
  children,
}: {
  label: string;
  badge: string;
  dot: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${CARD_SURFACE} px-5 py-[18px]`}>
      <h3 className="m-0 mb-3 flex items-center gap-2 text-[13px] font-bold">
        <span
          className={`inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold ${badge}`}
        >
          <span aria-hidden className={`size-[5px] rounded-full ${dot}`} />
          {label}
        </span>
        <em className="rounded-full bg-[var(--ai-slate-tint)] px-[7px] py-0.5 text-[10.5px] font-bold not-italic text-[var(--ai-t3)]">
          {count}
        </em>
      </h3>
      {children}
    </div>
  );
}

const EVIDENCE_ICON = "mt-px grid size-4 shrink-0 place-items-center rounded-full";

/**
 * One row inside an Evidence box.
 *
 * Carries what survived CriterionRow, which this replaces: the item is
 * rendered in the employer's or the model's own words at full weight, and an
 * absent one is described as absent from the DOCUMENT rather than as a failing
 * of the person. What did not survive is that component's refusal of a count
 * and of a warning mark — both are the design's call, and both are now here.
 * The unmet mark is amber, not the red the missing-requirements rows use: a
 * must-have the CV did not mention is a gap to ask about, not a rejection.
 */
export function EvidenceRow({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2.5 py-[7px] text-[12.5px] leading-[1.6] text-[var(--ai-t2)]">
      {tone === "ok" && (
        <span
          className={`${EVIDENCE_ICON} bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]`}
          aria-hidden
        >
          <Check className="size-2.5" strokeWidth={2.4} />
        </span>
      )}
      {tone === "warn" && (
        <span
          className={`${EVIDENCE_ICON} bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]`}
          aria-hidden
        >
          <AlertTriangle className="size-2.5" strokeWidth={2.4} />
        </span>
      )}
      {tone === "danger" && (
        <span
          className={`${EVIDENCE_ICON} bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]`}
          aria-hidden
        >
          <X className="size-[9px]" strokeWidth={2.6} />
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * What an Evidence box says when its list is empty.
 *
 * All four boxes render on every scored card, so an empty one has to say which
 * kind of empty it is. For three of them that is unambiguous and worth stating:
 * the scorer runs strengths, missing_requirements and concerns through a
 * normaliser that always yields an array, so an empty one is the model
 * reporting it found none — never a field the card is too old to have. "No
 * gaps found" is a finding, and the box disappearing said nothing.
 *
 * Must-haves is the exception and passes its own text, because an empty array
 * there has two possible causes and only the job's current count separates
 * them.
 */
export function EvidenceEmpty({ children }: { children: React.ReactNode }) {
  return <p className="m-0 py-[7px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">{children}</p>;
}

/**
 * The Summary card's sub-line.
 *
 * Genuine, which is why it survived when the design's other sub-lines did not:
 * the screening answers are frozen at apply time, and the scorer is handed them
 * as context beside the CV text, so the count on the row is the count the model
 * actually read.
 */
export function summarySource(answers: number): string {
  if (answers === 0) return "Generated from the CV";
  return `Generated from CV + ${answers} screening answer${answers === 1 ? "" : "s"}`;
}

/**
 * The Scored dimensions sub-line — how many of them the overall is an average
 * of, which is the one thing about the set a reader cannot see by looking.
 *
 * NOT the design's "Weighted to 87 · model v4.2". The weights are not stored on
 * the scorecard, and the model and date are already in the card's disclaimer.
 */
export function dimensionsMeta(detail: ApplicantScoreDetail): string {
  const total = detail.dimensions.length;
  const counted = detail.dimensions.filter((d) => !d.unstated).length;
  if (counted === total) return `All ${total} averaged into the overall`;
  return `${counted} of ${total} averaged into the overall`;
}

/**
 * The Evidence sub-line. Counts what the JOB names today, not what the card
 * judged — the line describes the bar being measured against, and a card that
 * predates a must-have should still say the bar exists. Omitted for a job that
 * names none, where there is no bar to describe.
 */
export function evidenceMeta(detail: ApplicantScoreDetail): string | undefined {
  const n = detail.job_must_have_count;
  if (n === 0) return undefined;
  return `Against the job's ${n} named must-have${n === 1 ? "" : "s"}`;
}

/** The count pill on Must-haves met, which is three different things. */
export function mustHaveCount(detail: ApplicantScoreDetail): string {
  if (detail.must_haves.length > 0) {
    const met = detail.must_haves.filter((m) => m.status === "evidenced").length;
    return `${met} of ${detail.must_haves.length}`;
  }
  // No "0 of N" for a card that predates the list: nothing was judged and
  // failed, the question was never put.
  return detail.job_must_have_count === 0 ? "None" : "-";
}

/**
 * One dimension: its name, a bar, the score out of 100, the reasoning, and the
 * CV span behind it.
 *
 * The design put a weight under each name. Cut — the job carries weight columns
 * but the scorecard does not record which weights produced it, so today's
 * numbers set beside an older score would misdescribe the figure above them.
 */
export function ScoredDimension({ dimension: d }: { dimension: ScoreDimensionRow }) {
  const label = DIMENSION_LABEL[d.dimension] ?? d.dimension;

  /*
   * A dimension the job stated nothing for shows NO number and NO bar.
   *
   * The model was still made to score it — all four are mandatory so scores
   * stay comparable between jobs — but it judged the CV against an empty
   * section, so the number is an invention. It is excluded from the overall
   * (see applyCvWeights), and rendering it here would put a figure on screen
   * that the headline score deliberately ignores. The reason is stated inline
   * rather than in a tooltip: three bars where every other job shows four
   * reads as a bug unless the fourth line says why.
   */
  if (d.unstated) {
    return (
      <div className="border-t border-[var(--ai-line-soft)] px-[22px] py-[18px] first:border-t-0">
        <div className="flex items-baseline justify-between gap-4">
          <h4 className="m-0 text-[13px] font-bold text-[var(--ai-t3)]">{label}</h4>
          <span className="text-[12px] font-semibold text-[var(--ai-t3)]">Not scored</span>
        </div>
        <p className="m-0 mt-3 text-[12.5px] leading-[1.65] text-[var(--ai-t3)] min-[840px]:pl-[216px]">
          This job lists no requirements, so there was nothing to judge the CV against. It is left
          out of the overall score rather than guessed at.
        </p>
      </div>
    );
  }

  const band = scoreBand(d.score);
  return (
    <div className="border-t border-[var(--ai-line-soft)] px-[22px] py-[18px] first:border-t-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 min-[840px]:grid-cols-[200px_minmax(0,1fr)_auto]">
        <h4 className="m-0 text-[13px] font-bold tracking-[-0.01em] text-[var(--ai-t1)]">
          {label}
        </h4>
        {/* Below the breakpoint there is no room for a 200px name column, so
            the track drops to a full-width row under the name/score pair
            rather than being dropped altogether. */}
        <span className="order-last col-span-2 block h-2 overflow-hidden rounded-full bg-[var(--ai-slate-tint)] min-[840px]:order-none min-[840px]:col-span-1">
          <span
            className="block h-full rounded-full"
            style={{ width: `${d.score}%`, background: band.stroke }}
          />
        </span>
        <span
          className="min-w-[62px] text-right font-heading text-[25px] font-extrabold leading-none tracking-[-0.03em] tabular-nums"
          style={{ color: band.ink }}
        >
          {d.score}
          <small className="ml-px text-[12px] font-bold tracking-normal text-[var(--ai-t3)]">
            /100
          </small>
        </span>
      </div>
      <div className="min-[840px]:pl-[216px]">
        {d.reasoning && (
          <p className="m-0 mt-3 text-[12.5px] leading-[1.65] text-[var(--ai-t2)]">{d.reasoning}</p>
        )}
        {d.quote && <DimQuote quote={d.quote} />}
      </div>
    </div>
  );
}

/**
 * One section of a pane: the design's `.card.cpad` with its `.chead`.
 *
 * Replaces DrawerLabel wherever a pane's sections became cards. The label was
 * an uppercase rule-and-caption that worked on a white body; on the inset body
 * the card's own edge does that job, and the design heads each card with a
 * 15px Sora title instead.
 *
 * `meta` is the right-aligned sub-line the design puts beside some titles
 * ("Answered 3 of 3 · 17 Sep"). Omitted rather than invented where we hold no
 * equivalent fact — same rule as ReviewSubhead's.
 */
export function PaneCard({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${CARD_SURFACE} px-[22px] py-5`}>
      <div className="mb-3.5 flex items-center justify-between gap-4">
        <h3 className="m-0 whitespace-nowrap font-heading text-[15px] font-bold tracking-[-0.02em] text-[var(--ai-t1)]">
          {title}
        </h3>
        {meta && (
          <span className="text-right text-[11px] font-medium text-[var(--ai-t3)]">{meta}</span>
        )}
      </div>
      {children}
    </section>
  );
}

export function DrawerLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mb-[9px] flex items-center gap-[9px] text-[10.5px] font-bold uppercase tracking-[0.1em] text-[var(--ai-t3)] after:h-px after:flex-1 after:bg-[var(--ai-line)] after:content-['']">
      {children}
    </p>
  );
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--ai-line-soft)] py-[9px] text-[13.5px]">
      <span className="text-[var(--ai-t3)]">{label}</span>
      <b className="font-bold text-[var(--ai-t1)]">{value}</b>
    </div>
  );
}

export const TIMELINE_NOTICE = "m-0 rounded-xl border px-3.5 py-2.5 text-[12px] leading-relaxed";

export function WorthALookBanner({
  row,
  dismissing,
  onDismissFlag,
}: {
  row: CompanyApplicantRow;
  dismissing: string | null;
  onDismissFlag: (id: string) => void;
}) {
  return (
    <div className="mb-5 flex items-center gap-3 rounded-2xl bg-remotiv-lime px-4 py-[13px]">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[rgba(20,16,32,0.1)] text-[#2F3A00]">
        <Flag className="size-[15px]" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <b className="block font-heading text-[13px] font-bold text-[#2F3A00]">Worth a look</b>
        {/* The design uses a second, lighter olive here. Held to one lime
            ink at reduced opacity instead — see the banner's colour note
            in the report: three olives would be three untokened hexes. */}
        <p className="m-0 mt-0.5 text-xs leading-[1.5] text-[#2F3A00]/70">
          {row.shortlist.reason?.trim() || "Met your auto-shortlist mark."}
        </p>
      </div>
      {/* Icon-only, per the design. The sentence that used to sit beside a
          text button — that dismissing clears the flag rather than hiding
          the person, and a materially better score re-flags them — has
          nowhere to go in this layout, so it becomes the button's title. */}
      <button
        type="button"
        disabled={dismissing === row.id}
        onClick={() => onDismissFlag(row.id)}
        aria-label="Dismiss flag"
        title="Clears the flag. A materially better score later flags them again."
        className="ml-auto grid size-[26px] shrink-0 place-items-center rounded-[9px] text-[#2F3A00]/70 transition-colors hover:bg-[rgba(20,16,32,0.1)] hover:text-[#2F3A00] disabled:opacity-40"
      >
        <X className="size-[13px]" strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function ApplicationCard({
  row,
  applied,
  onEmail,
}: {
  row: CompanyApplicantRow;
  applied: { main: string };
  onEmail: () => void;
}) {
  return (
    <PaneCard title="Application">
      <p className="m-0 text-[13px] leading-relaxed text-[var(--ai-t3)]">
        {/* "Added to", not "Applied to", on a manual row — the verb
            is the claim, and they did not apply. */}
        {row.added_manually ? "Added to" : "Applied to"}{" "}
        <b className="font-bold text-[var(--ai-t1)]">{row.job_title}</b> · {applied.main}
      </p>

      {/* The chip alone says how they arrived; this says what follows
          from it. The no-email decision is otherwise invisible, and
          this card is where someone lands before wondering why the
          candidate never replied. */}
      {row.added_manually && (
        <div className="mt-2.5 flex items-center gap-2">
          <AddedByTeamChip />
          <span className="min-w-0 text-[12px] leading-relaxed text-[var(--ai-t4)]">
            Not emailed - they didn't apply through the job board.
          </span>
        </div>
      )}

      {/* The design's `.acts`: the actions sit under a hairline rather
          than floating below the fact they act on. */}
      <div className="mt-4 flex gap-[9px] border-t border-[var(--ai-line-soft)] pt-4">
        {/* A real anchor, not window.open from an async handler — Safari
            blocks the latter. The route signs and 302-redirects. */}
        <a
          href={`/api/cv/company-application/${row.id}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!row.has_cv}
          onClick={(e) => {
            if (!row.has_cv) e.preventDefault();
          }}
          className={`flex flex-1 items-center justify-center gap-[7px] rounded-xl px-3 py-[11px] text-[13px] font-bold transition-colors ${
            row.has_cv
              ? "bg-remotiv-purple text-white shadow-[0_6px_18px_rgba(126,71,255,0.3)] hover:bg-[var(--ai-purple-hover)]"
              : "cursor-not-allowed bg-[var(--ai-inset)] text-[var(--ai-t4)]"
          }`}
        >
          <File className="size-[15px]" strokeWidth={1.9} />
          {cvLabel(row)}
        </a>
        {/* Opens the composer rather than handing off to the OS mail
            client. A mailto: sends from the recruiter's own address, which
            is the one thing the identity block exists to prevent — and it
            leaves no record on the applicant. */}
        <button
          type="button"
          onClick={onEmail}
          className="flex flex-1 items-center justify-center gap-[7px] rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[11px] text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
        >
          <Mail className="size-[15px]" strokeWidth={1.9} />
          Email
        </button>
        {/*
          A general Replace / Add CV button stood here and was REMOVED
          on purpose. Do not read its absence as an oversight, and do
          not put it back here.

          The gap it left did bite, in one specific shape: an applicant
          whose CV extracted to nothing — a scan, a photo, a PDF of
          images — had no way back to a scored state, because Re-score
          re-reads the stored text and the text is what is missing.
          That one state now has its own control: "Upload a readable
          CV" on the Review tab's score card, shown only when the
          stored text is under the scorer's floor (or there is no CV
          at all), driven by unscoredCardState. It calls the same
          attachApplicationCv this note always pointed at. A better CV
          arriving for an applicant who already scored still has no
          button — that remains the accepted trade.
        */}
      </div>

      {/* Says WHY the CV button is dead, rather than leaving a greyed
          control to be read as a bug. Only on expiry — "no CV" needs
          no excuse. */}
      {row.cv_expired && (
        <p className="m-0 mt-2.5 text-[11.5px] leading-relaxed text-[var(--ai-t4)]">
          CVs are deleted 24 months after the application. Everything else on this applicant is
          unaffected.
        </p>
      )}
    </PaneCard>
  );
}

export function ScreeningQuestionsCard({
  screening,
  screeningView,
}: {
  screening: Screening;
  screeningView: ScreeningCard;
}) {
  return (
    <PaneCard title="Screening questions">
      {screeningView === "failed" && (
        <p
          className={`${TIMELINE_NOTICE} border-[var(--ai-danger)]/30 bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]`}
        >
          The screening answers couldn&apos;t be loaded. That isn&apos;t the same as the candidate
          answering nothing - close and reopen to try again.
        </p>
      )}
      {screeningView === "loading" && (
        <div className="flex flex-col gap-3">
          <div className="h-[11px] w-2/3 animate-pulse rounded-full bg-[var(--ai-inset)]" />
          <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
        </div>
      )}
      {screening.status === "ready" && screening.answers.length > 0 && (
        <>
          {/* Provenance stated ONCE here rather than repeated on every
        pill. The pills then stay short enough to sit inline beside
        the answer, and this line can say the thing a pill never
        could — that nobody verified any of it. */}
          <p className="m-0 mb-2.5 text-[11.5px] leading-snug text-[var(--ai-t3)]">
            Answered by the candidate at apply time and checked against the thresholds you set.
            Self-reported - not verified by Remotiv.
          </p>
          <div className="flex flex-col gap-[9px]">
            {screening.answers.map((a) => (
              <div
                key={a.question_id}
                className="rounded-xl border border-[var(--ai-line)] px-[13px] py-[11px] transition-colors hover:border-[var(--ai-line-strong)] hover:bg-[var(--ai-inset)]"
              >
                <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs leading-snug text-[var(--ai-t3)]">
                  {a.question}
                  {/* Sits on the question, not the answer: "required" is
                a property of what the employer asked, and an
                unmatched essential is what turns a below-threshold
                answer into a listed missing requirement. */}
                  {a.essential && (
                    <span className="shrink-0 rounded-full bg-[var(--ai-purple-tint)] px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--ai-purple-ink)]">
                      Essential
                    </span>
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--ai-t1)]">
                  {a.answer_label || a.answer || "-"}
                  {/* The snapshot's own `matched` flag, scored at apply
                time — never re-derived here.

                Deliberately NOT green. A mint success pill reads as
                "Remotiv verified this", and nobody did: it is the
                candidate's own number compared to the employer's
                threshold. Neutral slate for met, muted amber for
                below — distinguishable, but neither endorses.

                NO pill at all when `scored` is false: the employer
                asked for the number without setting a threshold, so
                there was nothing to pass or fail. `matched` is false
                on those rows and would render "Below threshold",
                which is not a weaker claim than the truth — it is a
                different and wrong one. Absent on every snapshot
                written before the mode existed, so `!== false` keeps
                those rendering exactly as they always did. */}
                  {a.scored !== false && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-[2.5px] text-[10.5px] font-semibold ${
                        a.matched
                          ? "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]"
                          : "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]"
                      }`}
                    >
                      {a.matched ? "Meets threshold" : "Below threshold"}
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </PaneCard>
  );
}

export function DetailsCard({
  row,
  location,
  experienceText,
}: {
  row: CompanyApplicantRow;
  location: string;
  experienceText: string | null;
}) {
  return (
    <PaneCard title="Details">
      {/* Each row is conditional, so `last:border-b-0` lands on
          whichever row actually renders last — a `{cond && …}` that
          resolves false produces no DOM node, so :last-child stays
          correct. */}
      <div className="flex flex-col">
        {location && <DetailRow label="Location" value={location} />}
        {experienceText && <DetailRow label="Experience" value={experienceText} />}
        {row.notice_period && <DetailRow label="Notice period" value={row.notice_period} />}
        {row.availability && <DetailRow label="Availability" value={row.availability} />}
        {row.phone && <DetailRow label="Phone" value={row.phone} />}
        {row.linkedin_url && (
          <div className="flex items-center justify-between border-b border-[var(--ai-line-soft)] py-[9px] text-[13.5px] last:border-b-0">
            <span className="text-[var(--ai-t3)]">LinkedIn</span>
            <a
              href={row.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-bold text-remotiv-purple hover:underline"
            >
              Profile
              <ExternalLink className="size-3" strokeWidth={2} />
            </a>
          </div>
        )}
      </div>
    </PaneCard>
  );
}

export function MustHaveRows({ scoreDetail }: { scoreDetail: ApplicantScoreDetail }) {
  return (
    <>
      {scoreDetail.must_haves.map((mh) => (
        <EvidenceRow key={mh.item} tone={mh.status === "evidenced" ? "ok" : "warn"}>
          {mh.item}
          {mh.status === "not_found" && (
            <>
              {" - "}
              <b className="font-bold text-[var(--ai-t1)]">not evidenced</b>
            </>
          )}
          {mh.status === "evidenced" && mh.quote && <EvidenceQuote quote={mh.quote} />}
        </EvidenceRow>
      ))}
      {/* The one box whose empty state is not self-evident.
          Nothing on the card distinguishes "the job asks for
          none" from "written before the job asked" — only the
          job's count does, so it decides which is said. */}
      {scoreDetail.must_haves.length === 0 && (
        <EvidenceEmpty>
          {scoreDetail.job_must_have_count === 0
            ? "This job names no must-haves, so there was nothing to check the CV against."
            : `This score was written before the job named its ${scoreDetail.job_must_have_count === 1 ? "must-have" : `${scoreDetail.job_must_have_count} must-haves`}, so they were never checked. Re-scoring fills this in.`}
        </EvidenceEmpty>
      )}
    </>
  );
}
