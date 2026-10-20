import "server-only";
import { createHash } from "node:crypto";
import { extractText, thinkingOffParams } from "@/lib/ai/model-params";
import { stripCodeFences } from "@/lib/ai/score-parsers";
import { AI_MATCHING_MODEL } from "@/lib/anthropic";
import type { LiveQuestionsClient } from "@/lib/interviews/live-questions";
import { logProviderCall } from "@/lib/queue/budgets";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * A job question's private scoring guide, written ONCE for the job and shared
 * by every candidate of it (migration 042, job_question_scoring_guides).
 *
 * ── Only where the recruiter left none ───────────────────────
 *
 * A job question with its own rubric is marked against that rubric, as it
 * always was. One without gets a guide here, the first time a live interview
 * of the job freezes its questions (live-question-freeze.ts), and the guide is
 * frozen into that session's scoring snapshot with guide_source 'ai'. Later
 * changes to the row never reach a session that already froze it.
 *
 * ── Once per wording, whoever asks first ─────────────────────
 *
 * Keyed by the job and the sha256 of the question's normalised wording, not by
 * interview_questions.id: a job save deletes and re-inserts its questions, so
 * ids change while the wording stays. The guide is read first; only a miss
 * calls the model, and the insert is "on conflict do nothing" followed by a
 * re-read, so two callers at once may both write a guide but only one lands,
 * and both return the one that landed.
 *
 * ── What the model sees ──────────────────────────────────────
 *
 * The job title, the question and its competency. Nothing about any
 * candidate. The guide is never sent to the interviewer provider or the
 * candidate.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * The question, the job text and the guide. A provider-call line carries the
 * model, timing and outcome.
 */

export const LIVE_GUIDE_PROMPT_VERSION = "live-guide-v1";

const MAX_TOKENS = 600;
const TIMEOUT_MS = 30_000;
const PART_MIN = 30;
const PART_MAX = 400;

type Service = ReturnType<typeof createServiceClient>;

/** The wording a guide is keyed by: case, spacing and Unicode forms set aside. */
export function questionSha256(text: string): string {
  const normal = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normal).digest("hex");
}

export const GUIDE_SYSTEM_PROMPT = `You write the private scoring guide an interview scorer uses for ONE interview question.

You are given the job title, the question, and the competency it assesses. You know nothing about any candidate and must not imagine one.

Write what a strong answer to this question contains and what a weak one looks like, in plain words a reviewer can apply consistently to every candidate:
- Strong: what the answer must show for this question and this job: a specific example, the candidate's own part, decisions and a result, as the question calls for.
- Weak: what falls short: staying general, describing the team's work without their own part, no result, or not answering what was asked.

Rules:
- Judge content only. Never mention fluency, accent, grammar, confidence of delivery or filler words.
- Never mention age, gender, nationality, religion, health, family or any personal or protected trait.
- One or two sentences for each part.

Return ONLY this JSON object, no prose, no code fence:
{ "strong": "what a strong answer shows", "weak": "what a weak answer looks like" }`;

export type GuideInput = {
  jobId: string;
  companyId: string;
  jobTitle: string | null;
  question: string;
  competency: string | null;
};

export type JobGuide = {
  guide: string;
  source: "ai" | "recruiter";
  /** True when this call wrote the stored row. */
  created: boolean;
  /** Model calls this request made: 0 when the guide was already stored. */
  calls: number;
};

export class LiveGuideError extends Error {
  readonly code: "bad_output" | "model_error" | "db_error";
  constructor(code: LiveGuideError["code"], message: string) {
    super(`live guide: ${message}`);
    this.name = "LiveGuideError";
    this.code = code;
  }
}

function parseGuide(raw: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(stripCodeFences(raw));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const clean = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const strong = clean((v as { strong?: unknown }).strong);
  const weak = clean((v as { weak?: unknown }).weak);
  if (strong.length < PART_MIN || weak.length < PART_MIN) return null;
  if (strong.length > PART_MAX || weak.length > PART_MAX) return null;
  return `Strong answer: ${strong} Weak answer: ${weak}`;
}

async function writeGuide(
  client: LiveQuestionsClient,
  input: GuideInput,
): Promise<{ guide: string; calls: number; input_tokens: number; output_tokens: number }> {
  const content = [
    `## Job title\n${(input.jobTitle ?? "").trim() || "(not given)"}`,
    `## Competency\n${(input.competency ?? "").trim() || "(not given)"}`,
    `## Question\n${input.question.trim()}`,
  ].join("\n\n");
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  // One retry on a reply that is not the schema, as the scorers do.
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    calls += 1;
    let text: string;
    try {
      const response = await client.messages.create(
        {
          model: AI_MATCHING_MODEL,
          max_tokens: MAX_TOKENS,
          ...thinkingOffParams(AI_MATCHING_MODEL),
          system: GUIDE_SYSTEM_PROMPT,
          messages: [{ role: "user", content }],
        },
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      text = response.content.some((b) => b.type === "text")
        ? extractText(response, AI_MATCHING_MODEL)
        : "";
      logProviderCall({
        jobType: "live_guide",
        provider: "anthropic",
        model: AI_MATCHING_MODEL,
        durationMs: Date.now() - started,
        remainingAtStartMs: null,
        outcome: "ok",
      });
    } catch {
      logProviderCall({
        jobType: "live_guide",
        provider: "anthropic",
        model: AI_MATCHING_MODEL,
        durationMs: Date.now() - started,
        remainingAtStartMs: null,
        outcome: "error",
      });
      throw new LiveGuideError("model_error", "the model call failed");
    }
    const guide = parseGuide(text);
    if (guide) return { guide, calls, input_tokens: inputTokens, output_tokens: outputTokens };
  }
  throw new LiveGuideError("bad_output", "the reply was not a usable guide, twice");
}

async function readGuide(
  service: Service,
  input: GuideInput,
  sha: string,
): Promise<{ guide: string; source: "ai" | "recruiter" } | null> {
  const { data, error } = await service
    .from("job_question_scoring_guides")
    .select("guide, source")
    .eq("job_id", input.jobId)
    .eq("company_id", input.companyId)
    .eq("question_sha256", sha)
    .maybeSingle();
  if (error) throw new LiveGuideError("db_error", `read failed (${error.code ?? "db"})`);
  return (data as { guide: string; source: "ai" | "recruiter" } | null) ?? null;
}

/**
 * The job's guide for this question: the stored one, or a new one written,
 * stored and read back. Every caller for the same job and wording gets the
 * same guide.
 */
export async function ensureJobQuestionGuide(
  service: Service,
  input: GuideInput,
  deps: { client: LiveQuestionsClient },
): Promise<JobGuide> {
  const sha = questionSha256(input.question);
  const stored = await readGuide(service, input, sha);
  if (stored) return { ...stored, created: false, calls: 0 };

  const written = await writeGuide(deps.client, input);
  const { data: landed, error } = await service
    .from("job_question_scoring_guides")
    .upsert(
      {
        job_id: input.jobId,
        company_id: input.companyId,
        question_sha256: sha,
        source: "ai",
        guide: written.guide,
        competency: input.competency,
        ai_model: AI_MATCHING_MODEL,
        prompt_version: LIVE_GUIDE_PROMPT_VERSION,
        input_tokens: written.input_tokens,
        output_tokens: written.output_tokens,
      },
      { onConflict: "job_id,question_sha256", ignoreDuplicates: true },
    )
    .select("guide");
  if (error) throw new LiveGuideError("db_error", `write failed (${error.code ?? "db"})`);
  const created = ((landed ?? []) as unknown[]).length > 0;
  // Another caller may have landed first: the stored row is the guide, never ours.
  const now = await readGuide(service, input, sha);
  if (!now) throw new LiveGuideError("db_error", "the guide was not there after writing it");
  console.log(
    `[live-guide] job ${input.jobId}: ${created ? "wrote" : "lost the race for"} a guide, calls ${written.calls}, tokens ${written.input_tokens}/${written.output_tokens}`,
  );
  return { ...now, created, calls: written.calls };
}
