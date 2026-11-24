import { useId } from "react";
import {
  hiringChallengesLength,
  LIVE_HIRING_CHALLENGES_MAX,
  type LiveInterviewMinutes,
  type LiveInterviewMode,
} from "@/app/ai-dashboard/lib/job-types";
import {
  AI_VIDEO_CHALLENGES_HELPER,
  AI_VIDEO_CHALLENGES_LABEL,
  AI_VIDEO_LENGTH_LABEL,
  AI_VIDEO_LENGTH_OPTIONS,
  AI_VIDEO_MODE_CARDS,
  AI_VIDEO_MODE_HEADING,
  AI_VIDEO_MODE_SUB,
  aiVideoLengthHint,
} from "./ai-video-copy";

/**
 * The AI Video Interview's mode, length and hiring challenges (#45, #46), on
 * the wizard's Interview questions step. Nothing renders while AI Video
 * Interview is off for the job; the challenges box only in AI-Guided.
 *
 * The cards are native radio inputs inside their labels, so arrow keys, Tab
 * and screen readers treat them as one radio group. A focused radio keeps the
 * site's keyboard outline, and its card also takes the wizard's input ring.
 *
 * The server checks every value again (liveInterviewPatch, job-types.ts).
 */

const CARD_CLS =
  "flex cursor-pointer flex-col gap-1 rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-3.5 transition-colors has-[:checked]:border-remotiv-purple has-[:checked]:bg-[var(--ai-purple-tint)] has-[:focus-visible]:border-remotiv-purple has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-remotiv-purple/[0.16]";
const FIELD_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const LABEL_CLS = "mb-[7px] block text-xs font-semibold text-[var(--ai-t2)]";
const HINT_CLS = "mt-[7px] text-xs leading-relaxed text-[var(--ai-t3)]";

export function LiveInterviewSettings({
  enabled,
  mode,
  minutes,
  challenges,
  onModeChange,
  onMinutesChange,
  onChallengesChange,
}: {
  /** AI Video Interview is on for this job. */
  enabled: boolean;
  mode: LiveInterviewMode;
  minutes: LiveInterviewMinutes;
  challenges: string;
  onModeChange: (mode: LiveInterviewMode) => void;
  onMinutesChange: (minutes: LiveInterviewMinutes) => void;
  onChallengesChange: (text: string) => void;
}) {
  const id = useId();
  if (!enabled) return null;
  const headingId = `${id}-mode-heading`;
  const subId = `${id}-mode-sub`;
  const lengthId = `${id}-length`;
  const lengthHintId = `${id}-length-hint`;
  const challengesId = `${id}-challenges`;
  const challengesHelpId = `${id}-challenges-help`;
  const challengesCountId = `${id}-challenges-count`;
  const used = hiringChallengesLength(challenges);

  return (
    <section className="mb-5 border-b border-[var(--ai-line)] pb-5" data-live-interview-settings>
      <fieldset className="m-0 border-0 p-0" aria-describedby={subId}>
        <legend
          id={headingId}
          className="m-0 mb-[5px] p-0 font-heading text-[15px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]"
        >
          {AI_VIDEO_MODE_HEADING}
        </legend>
        <p id={subId} className="m-0 mb-3 text-xs leading-relaxed text-[var(--ai-t3)]">
          {AI_VIDEO_MODE_SUB}
        </p>
        <div className="grid grid-cols-1 gap-3 min-[525px]:grid-cols-2">
          {AI_VIDEO_MODE_CARDS.map((card) => (
            <label key={card.value} className={CARD_CLS}>
              <span className="flex items-center gap-2.5">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={card.value}
                  checked={mode === card.value}
                  onChange={() => onModeChange(card.value)}
                  className="size-4 shrink-0 accent-[var(--remotiv-purple,#7E47FF)]"
                />
                <span className="text-[13.5px] font-bold text-[var(--ai-t1)]">{card.title}</span>
              </span>
              <span className="text-[12.5px] font-semibold text-[var(--ai-t2)]">
                {card.tagline}
              </span>
              <span className="text-xs leading-relaxed text-[var(--ai-t3)]">{card.detail}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4">
        <label htmlFor={lengthId} className={LABEL_CLS}>
          {AI_VIDEO_LENGTH_LABEL}
        </label>
        <select
          id={lengthId}
          value={minutes}
          aria-describedby={lengthHintId}
          onChange={(e) => onMinutesChange(Number(e.target.value) === 60 ? 60 : 30)}
          className={FIELD_CLS}
        >
          {AI_VIDEO_LENGTH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p id={lengthHintId} className={HINT_CLS}>
          {aiVideoLengthHint(minutes)}
        </p>
      </div>

      {mode === "ai_guided" && (
        <div className="mt-4">
          <label htmlFor={challengesId} className={LABEL_CLS}>
            {AI_VIDEO_CHALLENGES_LABEL}
          </label>
          <textarea
            id={challengesId}
            value={challenges}
            maxLength={LIVE_HIRING_CHALLENGES_MAX}
            aria-describedby={`${challengesHelpId} ${challengesCountId}`}
            onChange={(e) => onChallengesChange(e.target.value)}
            className={`${FIELD_CLS} min-h-24 resize-y leading-relaxed`}
          />
          <div className="mt-[7px] flex items-start justify-between gap-3">
            <p id={challengesHelpId} className="m-0 text-xs leading-relaxed text-[var(--ai-t3)]">
              {AI_VIDEO_CHALLENGES_HELPER}
            </p>
            <span
              id={challengesCountId}
              aria-live="polite"
              className="shrink-0 text-xs tabular-nums text-[var(--ai-t3)]"
            >
              {used}/{LIVE_HIRING_CHALLENGES_MAX}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
