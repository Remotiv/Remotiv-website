import "server-only";
import type { Job, ScreeningQuestion } from "@/lib/jobs";

/*
 * Formatters and the public projection, shared by the two renderings of this
 * route. Moved here unchanged when the page split — the Remotiv rendering
 * imports them instead of declaring them, so its OUTPUT is byte-identical while
 * the white-label rendering can reuse the same rules rather than growing a
 * second, drifting copy.
 */

// JOB-001 — the public-safe projection handed to client components. The full
// job row includes screening_questions[].ideal (the employer's pass answers)
// plus created_by / client_id / company_id; anything passed as a client-
// component prop is serialized into the RSC payload and readable in devtools,
// so those fields must never cross the boundary. The keep-list below is the
// verified consumer inventory of ApplyModal (the only client consumer):
//   job:      id, title, company, work_type, screening_questions
//   question: id, question, type, options, essential
// `essential` is retained deliberately — the modal renders its "Essential"
// badge, and it reveals weighting, not answers. numeric_mode is dropped: no
// client code reads it, and it hints at the scoring direction.
export type PublicScreeningQuestion = Pick<
  ScreeningQuestion,
  "id" | "question" | "type" | "options" | "essential"
>;

export type PublicJob = Pick<Job, "id" | "title" | "company" | "work_type"> & {
  screening_questions: PublicScreeningQuestion[];
};

export function toPublicJob(job: Job): PublicJob {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    work_type: job.work_type,
    screening_questions: (job.screening_questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      type: q.type,
      options: q.options,
      essential: q.essential,
    })),
  };
}

// ── Local formatting helpers (own copies — the list-client versions are
//    unexported + USD-only, so we don't import them) ──────────────
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function fmtSalary(min: number | null, max: number | null, currency: string | null): string {
  const cur = (currency ?? "").trim().toUpperCase() || "USD";
  const k = (n: number) => {
    if (n >= 1000) {
      const v = n / 1000;
      return `${Number.isInteger(v) ? v : v.toFixed(1)}k`;
    }
    return n.toLocaleString("en-US");
  };
  if (min != null && max != null) {
    return min === max ? `${cur} ${k(min)}` : `${cur} ${k(min)}–${k(max)}`;
  }
  if (min != null) return `${cur} from ${k(min)}`;
  if (max != null) return `${cur} up to ${k(max)}`;
  return "Competitive";
}

export function splitLines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// JSON.stringify does not escape "<", and this JSON-LD embeds database-authored
// values (description, title, company). A description containing "</script>"
// would terminate the inline script element and execute what follows. Unicode
// escapes keep the output valid JSON — JSON.parse and Google's structured-data
// parser read it unchanged — while making it inert inside <script>.
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
