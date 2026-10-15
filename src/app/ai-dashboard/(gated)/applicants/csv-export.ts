import {
  type ApplicantScore,
  PIPELINE_STAGE_LABELS,
  type PipelineStage,
} from "@/app/ai-dashboard/lib/applicant-types";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";

/**
 * The CSV of the applicants page, as a pure function.
 *
 * Extracted from the client component on purpose. The export's screening
 * column is no longer in the list payload, so it has to be fetched before a
 * file can be written — and the rule is that a failed or incomplete fetch
 * produces NO file rather than a file with blank cells. That rule has to be
 * enforced somewhere a test can execute, and the component is not it: there is
 * no DOM test runner here, so anything left in the component could only be
 * checked by matching source text, which proves nothing about behaviour.
 *
 * So every decision that can be wrong — escaping, the column order, the
 * screening arithmetic, and above all the completeness check — lives here.
 * The component keeps only the Blob and the anchor click.
 */

/**
 * The most applicants one export may cover.
 *
 * The same number as the list's page size, because the button exports the
 * current page: the label says "Export page" and the filename names it. It is
 * enforced on the server read as well, so the screening jsonb can never be
 * pulled for the whole table through the export path.
 */
export const CSV_EXPORT_MAX = 20;

/** RFC-4180 escaping: quote the field and double any embedded quotes. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const HEADER = [
  "Candidate",
  "Email",
  "Job",
  "Stage",
  "AI score",
  "Score status",
  "Confidence",
  "Screening",
  "Applied",
];

/**
 * One exported applicant, named explicitly rather than taken as a
 * CompanyApplicantRow.
 *
 * `name` arrives already resolved because the table's own name resolution is a
 * display concern that lives with the table. Everything else here is a value
 * this module formats, so the formatting is what the tests pin.
 */
export type CsvApplicant = {
  id: string;
  name: string;
  email: string;
  job_title: string;
  stage: PipelineStage;
  score: ApplicantScore;
  created_at: string;
};

export type CsvResult = { ok: true; csv: string } | { ok: false; missing: string[] };

/**
 * The screening column, counted over TESTED questions only on both sides.
 *
 * A numeric_mode 'none' question has no threshold to meet, so counting it in
 * the denominator would report "2/3 thresholds met" for a candidate who met
 * both of the two that existed. `scored` is ABSENT on every snapshot written
 * before that flag existed, and absent means scored — so old rows read exactly
 * as they always did.
 */
function screeningCell(answers: ScreeningAnswerSnapshot[]): string {
  const tested = answers.filter((a) => a.scored !== false);
  if (answers.length === 0) return "No questions";
  if (tested.length === 0) return "No thresholds set";
  const met = tested.filter((a) => a.matched).length;
  return `${met}/${tested.length} thresholds met`;
}

/**
 * Build the CSV, or refuse.
 *
 * Refuses when any applicant's screening answers are absent from `answers`.
 * An absent entry is NOT an empty one: a candidate who answered three
 * questions and a candidate who was asked none both have to be reported
 * honestly, and "" or "No questions" in place of an unknown turns a failed
 * read into a factual claim about the applicant. The caller writes no file
 * when this returns ok: false.
 *
 * Note this cannot be satisfied by the partial map that the list's score read
 * returns on failure — that read degrades to "pending", which is a legitimate
 * state for a score and has no equivalent for a question that was asked.
 */
export function buildApplicantsCsv(
  applicants: CsvApplicant[],
  answers: Record<string, ScreeningAnswerSnapshot[]>,
): CsvResult {
  const missing = applicants.filter((a) => !Array.isArray(answers[a.id])).map((a) => a.id);
  if (missing.length > 0) return { ok: false, missing };

  const lines = [
    HEADER.map(csvCell).join(","),
    ...applicants.map((a) =>
      [
        a.name,
        a.email,
        a.job_title,
        PIPELINE_STAGE_LABELS[a.stage],
        a.score.status === "scored" && a.score.overall != null ? String(a.score.overall) : "",
        a.score.adjusted ? "Adjusted" : a.score.status,
        a.score.confidence ?? "",
        screeningCell(answers[a.id]),
        new Date(a.created_at).toISOString().slice(0, 10),
      ]
        .map(csvCell)
        .join(","),
    ),
  ];

  // BOM so Excel reads UTF-8 names correctly.
  return { ok: true, csv: `﻿${lines.join("\r\n")}` };
}
