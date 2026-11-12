import type { ReactNode } from "react";
import { type CompanyApplicantRow, showsWorthALook } from "@/app/ai-dashboard/lib/applicant-types";
import {
  AddedByTeamChip,
  FlagReasonLine,
  fullName,
  getTint,
  initials,
  WorthALookChip,
} from "./_list-row-parts";

/**
 * One applicant in the Split list (Applicants Split, commit 4;
 * docs/design/Applicants_Split_v9.md, section 1 "List item data" and states
 * 2-5).
 *
 * ONE button, and nothing clickable inside it: a nested button is invalid HTML,
 * the parser closes the outer one early, and hydration fails (see the note on
 * WorthALookChip). Everything below is text or a mark.
 *
 * Second line, in order: the flag's reason on a Worth-a-look row; else the AI's
 * verdict when the model scored the CV; else the email. Location and years
 * show only when filled, and the whole line is hidden when both are empty,
 * never a "-". "Screening X/Y met" shows only when the job tested something,
 * and is neutral: self-reported answers never look verified (green).
 *
 * The score ring and the applied date come in from the client, which owns the
 * live ScoreRing and the hydration-safe clock (PageClock); this file only
 * places them.
 */

const ITEM =
  "group/split relative grid w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--ai-line-soft)] px-5 py-[13px] text-left transition-[background-color,box-shadow] last:border-b-0 hover:z-[2] hover:bg-[#FCFBFA] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-remotiv-purple";

const SECOND_LINE = "m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]";

/** The row's fill: selected wins over the flag's wash. */
function itemBackground(selected: boolean, flagged: boolean): string {
  if (selected) return "bg-[var(--ai-purple-tint)]";
  if (flagged) return "bg-remotiv-purple/[0.035]";
  return "bg-[var(--ai-surface)]";
}

/** "Lahore, Pakistan · 6 years", or null when neither is filled. */
export function locationLine(row: CompanyApplicantRow): string | null {
  const place = [row.city, row.country]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(", ");
  const years =
    row.years_experience == null
      ? ""
      : `${row.years_experience} ${row.years_experience === 1 ? "year" : "years"}`;
  const line = [place, years].filter(Boolean).join(" · ");
  return line || null;
}

export function SplitListItem({
  row,
  ring,
  applied,
  isTop,
  selected,
  onOpen,
}: {
  row: CompanyApplicantRow;
  /** The live score ring for this row, rendered by the client. */
  ring: ReactNode;
  /** "2d ago" / "Today", from the client's PageClock. */
  applied: string;
  /** In Review top 10 and scored 90 or more: see TOP_MATCH_MIN_SCORE. */
  isTop: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const tint = getTint(row.id);
  const flagged = showsWorthALook(row);
  const verdict = row.score.status === "scored" ? row.score.verdict : null;
  const where = locationLine(row);

  return (
    <button
      type="button"
      data-applicant-id={row.id}
      aria-pressed={selected}
      onClick={onOpen}
      className={`${ITEM} ${itemBackground(selected, flagged)}`}
    >
      {/* On for the selected and the flagged row; on hover for the rest. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple transition-opacity ${
          selected || flagged ? "opacity-100" : "opacity-0 group-hover/split:opacity-100"
        }`}
      />
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
        style={{
          background: tint.bg,
          color: tint.fg,
          boxShadow: isTop
            ? "0 0 0 2px var(--ai-surface), 0 0 0 3.5px #49D7A7"
            : "0 0 0 2px var(--ai-surface), 0 0 0 3.5px rgba(20,16,32,0.07)",
        }}
      >
        {initials(row.first_name, row.last_name, row.email)}
      </span>

      <span className="block min-w-0">
        <span className="flex min-w-0 items-center gap-2 text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
          <span className="min-w-0 truncate">{fullName(row)}</span>
          {isTop && (
            <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
              Top match
            </span>
          )}
          {flagged && <WorthALookChip />}
        </span>
        {flagged && <FlagReasonLine reason={row.shortlist.reason} />}
        {verdict ? (
          <span className="mb-0.5 mt-[3px] line-clamp-2 text-[12.5px] leading-[1.45] text-[var(--ai-t2)]">
            {verdict}
          </span>
        ) : (
          !flagged && <span className={`block ${SECOND_LINE}`}>{row.email}</span>
        )}
        {where && <span className="block truncate text-[12.5px] text-[var(--ai-t3)]">{where}</span>}
        <span className="mt-[7px] block text-[11.5px] text-[var(--ai-t3)]">
          Applied {applied}
          {row.screening && (
            <span className="font-semibold">
              {" "}
              · Screening {row.screening.met}/{row.screening.scored} met
            </span>
          )}
          {row.added_manually && (
            <>
              {" · "}
              <span className="inline-block align-middle">
                <AddedByTeamChip />
              </span>
            </>
          )}
        </span>
      </span>

      <span className="flex items-center self-center">{ring}</span>
    </button>
  );
}
