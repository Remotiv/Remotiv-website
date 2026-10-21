"use client";

import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/app/ai-dashboard/lib/applicant-types";
import { countLabel } from "./counts-state";

/**
 * The stage-filter strip: All, one chip per pipeline stage, and the Flagged
 * filter that composes with whichever chip is on.
 *
 * Extracted from _applicants-client.tsx so the rendered markup can be asserted
 * directly (stage-tabs.test.ts renders it through react-dom/server). The whole
 * strip moved, container included, because the scroll container and the chips
 * are one claim: chips that cannot compress inside a box that cannot widen.
 */

/**
 * Stages deliberately given no chip.
 *
 * **Empty, and that is the point.** The chips used to be a hand-written list of
 * four, which silently dropped Screening, Offer and Rejected — a recruiter
 * could move someone to Screening through the stage select and then had no way
 * to filter them back out. Deriving the strip from `PIPELINE_STAGES` means a
 * stage can only be missing if it is named here, on purpose, with a reason.
 */
const TAB_STAGE_EXCLUSIONS: ReadonlyArray<PipelineStage> = [];

/** Every stage, in pipeline order, minus the documented exclusions. */
export const TAB_STAGES: ReadonlyArray<PipelineStage> = PIPELINE_STAGES.filter(
  (stage) => !TAB_STAGE_EXCLUSIONS.includes(stage),
);

export function StageTabs({
  tab,
  total,
  stageCounts,
  updating,
  flaggedOnly,
  flaggedCount,
  onSelectStage,
  onToggleFlagged,
}: {
  tab: "all" | PipelineStage;
  total: number | null;
  stageCounts: Record<PipelineStage, number | null>;
  updating: boolean;
  flaggedOnly: boolean;
  flaggedCount: number | null;
  /** Null clears the stage filter — the All chip. */
  onSelectStage: (stage: PipelineStage | null) => void;
  onToggleFlagged: () => void;
}) {
  return (
    // Eight chips are wider than a phone. The strip scrolls WITHIN itself
    // (max-w-full + overflow-x-auto) so it can never widen the page, and every
    // chip is shrink-0 so they scroll instead of compressing.
    <div className="flex max-w-full overflow-x-auto rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
      <TabButton
        stage="all"
        on={tab === "all"}
        count={total}
        updating={updating}
        onClick={() => onSelectStage(null)}
      >
        All
      </TabButton>
      {TAB_STAGES.map((stage) => (
        <TabButton
          key={stage}
          stage={stage}
          on={tab === stage}
          count={stageCounts[stage]}
          updating={updating}
          onClick={() => onSelectStage(stage)}
        >
          {PIPELINE_STAGE_LABELS[stage]}
        </TabButton>
      ))}

      {/* A FILTER, not a stage — it composes with whichever chip is on,
          because "flagged, in Screening" is a question worth asking. Its
          badge is the server aggregate, not filtered.length. */}
      <button
        type="button"
        aria-pressed={flaggedOnly}
        onClick={onToggleFlagged}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-[6px] text-[12.5px] font-semibold transition-colors ${
          flaggedOnly
            ? "border-[var(--ai-sidebar)] bg-[var(--ai-sidebar)] text-white"
            : "border-[var(--ai-line-strong)] bg-[var(--ai-surface)] text-[var(--ai-t2)] hover:text-[var(--ai-t1)]"
        }`}
      >
        Flagged
        {typeof flaggedCount === "number" && flaggedCount > 0 && (
          <span
            className={`rounded-full px-[6px] py-px text-[10.5px] font-bold tabular-nums ${
              flaggedOnly ? "bg-white/20 text-white" : "bg-remotiv-purple/10 text-remotiv-purple"
            }`}
          >
            {flaggedCount}
          </span>
        )}
      </button>
    </div>
  );
}

function TabButton({
  stage,
  on,
  count,
  updating,
  onClick,
  children,
}: {
  /**
   * The value this chip filters on, published to the DOM so a test asserts the
   * filter target rather than the label — a chip wired to the wrong stage then
   * fails instead of passing on matching text.
   */
  stage: PipelineStage | "all";
  on: boolean;
  /** A server count. Null is unknown — drawn as an em dash, never as 0. */
  count: number | null;
  /** The figure is being re-read. Dimmed so it does not read as current. */
  updating: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-stage={stage}
      onClick={onClick}
      className={`flex shrink-0 items-center gap-[7px] rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors ${
        on
          ? "bg-[var(--ai-sidebar)] text-white shadow-[0_3px_10px_rgba(20,16,32,0.2)]"
          : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
      }`}
    >
      {children}
      <span
        aria-busy={updating}
        className={`rounded-full px-1.5 py-px text-[10.5px] font-bold tabular-nums transition-opacity ${
          on ? "bg-white/20 text-white" : "bg-black/[0.07]"
        } ${updating ? "opacity-50" : ""}`}
      >
        {countLabel(count)}
      </span>
    </button>
  );
}
