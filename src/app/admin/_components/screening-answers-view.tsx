"use client";

import {
  AlertTriangle,
  Check,
  CircleCheck,
  CircleDashed,
  Minus,
  X,
} from "lucide-react";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";

export type ScreeningSummary = {
  kind: "none" | "fail" | "partial" | "ok";
  matched: number;
  total: number;
};

// Pure summary of a screening-answer snapshot. none = no questions; fail = any
// essential missed; partial = some non-essential missed; ok = all matched.
export function summarizeScreening(
  answers: ScreeningAnswerSnapshot[] | undefined | null,
): ScreeningSummary {
  if (!answers || answers.length === 0) return { kind: "none", matched: 0, total: 0 };
  // Questions the employer set no threshold on (numeric_mode 'none') are not
  // tests, so they are excluded from BOTH sides of the count — leaving them in
  // `total` alone reported "2/3 matched" for a candidate who matched both of
  // the two thresholds that existed. `scored` is absent on every snapshot
  // written before the mode existed, so those still count.
  const tested = answers.filter((a) => a.scored !== false);
  if (tested.length === 0) return { kind: "none", matched: 0, total: 0 };
  const total = tested.length;
  const matched = tested.filter((a) => a.matched).length;
  const failedEssential = tested.some((a) => a.essential && !a.matched);
  let kind: ScreeningSummary["kind"] = "ok";
  if (failedEssential) kind = "fail";
  else if (matched < total) kind = "partial";
  return { kind, matched, total };
}

/**
 * A numeric ideal, with the operator it was actually tested with.
 *
 * The operator was hardcoded to "≥", which became a lie the moment maximum
 * questions shipped: "at most 3000" displayed as "≥ 3000", the inverse of the
 * threshold the candidate was judged against.
 *
 * The mode is read from the SNAPSHOT rather than the job, because the job's
 * question can be re-typed afterwards and the snapshot is what the candidate
 * was actually scored against.
 *
 * Absent mode means the row predates the modes, and that is not a guess: until
 * then /api/apply's only numeric branch was `a >= ideal`, so those rows were
 * scored as minimums as a matter of fact. "≥" is therefore correct for them,
 * and the fallback needs no hedging in the UI.
 *
 * 'none' never reaches here — those rows are untested and the ideal is hidden.
 */
function numericIdealText(a: ScreeningAnswerSnapshot): string {
  return `${a.numeric_mode === "max" ? "≤" : "≥"} ${a.ideal}`;
}

const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold";
const PILL_TONE: Record<ScreeningSummary["kind"], string> = {
  ok: "text-emerald-700 bg-emerald-50",
  partial: "text-amber-700 bg-amber-50",
  fail: "text-red-700 bg-red-50",
  none: "text-gray-400 bg-gray-50",
};

// Compact badge for table rows + the mobile card.
export function ScreeningBadge({ answers }: { answers: ScreeningAnswerSnapshot[] }) {
  const s = summarizeScreening(answers);
  const cls = `${PILL_BASE} ${PILL_TONE[s.kind]}`;

  if (s.kind === "none") {
    return (
      <span className={cls}>
        <Minus className="size-3.5" strokeWidth={2} /> No answers
      </span>
    );
  }
  if (s.kind === "fail") {
    return (
      <span className={cls}>
        <AlertTriangle className="size-3.5" strokeWidth={2} /> Essential failed
      </span>
    );
  }
  if (s.kind === "partial") {
    return (
      <span className={cls}>
        <CircleDashed className="size-3.5" strokeWidth={2} /> {s.matched}/{s.total} matched
      </span>
    );
  }
  return (
    <span className={cls}>
      <CircleCheck className="size-3.5" strokeWidth={2} /> {s.matched}/{s.total} matched
    </span>
  );
}

function summaryLabel(s: ScreeningSummary): string {
  if (s.kind === "fail") return "Essential failed";
  return `${s.matched}/${s.total} matched`;
}

// Detail-panel section. Returns null when the application has no screening
// answers (question-less jobs), so no empty section renders.
export function ScreeningAnswersView({
  answers,
}: {
  answers: ScreeningAnswerSnapshot[];
}) {
  if (!answers || answers.length === 0) return null;
  const s = summarizeScreening(answers);

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
          Screening answers
        </p>
        <span className={`${PILL_BASE} ${PILL_TONE[s.kind]}`}>{summaryLabel(s)}</span>
      </div>

      <div className="flex flex-col gap-2">
        {answers.map((a) => {
          // Collected, never tested — no threshold, so no verdict and no way to
          // fail an essential.
          const untested = a.scored === false;
          const failedEssential = !untested && a.essential && !a.matched;
          const answerText = a.answer_label ?? (a.answer || "—");
          const idealText =
            a.type === "numeric" ? numericIdealText(a) : (a.ideal_label ?? a.ideal);
          return (
            <div
              key={a.question_id}
              className={`rounded-xl px-3.5 py-3 ${
                failedEssential ? "border border-red-200 bg-red-50" : "bg-gray-50"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-800">{a.question}</span>
                  {a.essential && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">
                      Essential
                    </span>
                  )}
                </div>
                {untested ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-gray-400">
                    <Minus className="size-3.5" strokeWidth={2.5} /> No threshold
                  </span>
                ) : a.matched ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-600">
                    <Check className="size-3.5" strokeWidth={2.5} /> Match
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-red-500">
                    <X className="size-3.5" strokeWidth={2.5} /> No match
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>
                  Answer: <span className="font-semibold text-gray-800">{answerText}</span>
                </span>
                {!untested && (
                  <span>
                    Ideal: <span className="font-medium text-gray-600">{idealText}</span>
                  </span>
                )}
              </div>

              {failedEssential && (
                <div className="mt-2 flex items-center gap-1 text-xs font-semibold text-red-600">
                  <AlertTriangle className="size-3.5" strokeWidth={2} /> Failed an essential
                  requirement
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
