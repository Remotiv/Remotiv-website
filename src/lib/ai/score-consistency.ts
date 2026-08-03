/**
 * Scorer consistency harness — Remotiv model-quality tooling.
 *
 * Scores the SAME application against the SAME job N times and reports how far
 * the answers drift. Variance is a property of the PROMPT, not the candidate:
 * if one CV scores 71 / 84 / 78 on three identical runs, no recruiter decision
 * built on that number means anything, and the rubric is what needs fixing.
 *
 * ── Why this file writes nothing ──────────────────────────────
 *
 * It calls `scoreCv` directly. That function is already pure — it takes an
 * application plus a job, calls the model, verifies the evidence and returns a
 * Scorecard. Every database write in the scoring path lives in the OTHER half,
 * `handleAiCvScore`, via `writeScoreRow`. Neither is imported here, so there is
 * no code path from this file to `application_scores` at all — a consistency
 * run cannot overwrite a candidate's real score or a reviewer's override, and
 * that holds by construction rather than by a flag someone might forget to set.
 *
 * Reusing `scoreCv` also means the prompt is never duplicated. A copied prompt
 * would drift from the shipped one within a release or two and the harness
 * would then be measuring a rubric that isn't in production. PROMPT_VERSION is
 * printed on every report so a run is always traceable to a specific rubric.
 *
 * NOT reachable from /ai-dashboard: this is a CLI module outside the app
 * router with no route, no server action and no export that any page imports.
 *
 * ── Running it ───────────────────────────────────────────────
 *
 *   npx tsx --env-file=.env.local src/lib/ai/score-consistency.ts --help
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { ScreeningAnswerSnapshot, ScreeningQuestion } from "@/lib/jobs";
import {
  PROMPT_VERSION,
  buildUserMessage,
  resolveScoringModel,
  scoreCv,
  type ScoreInput,
  type Scorecard,
} from "@/lib/ai/cv-scoring";

// ── Cost guard ───────────────────────────────────────────────

/** N applications x N runs is easy to fat-finger into a large bill. */
export const MAX_APPLICATIONS = 5;
export const MAX_RUNS = 10;
/** Hard ceiling on model calls per invocation, whatever the two above allow. */
export const MAX_TOTAL_CALLS = 30;
export const DEFAULT_RUNS = 3;

/**
 * Sonnet-tier list price, USD per million tokens.
 *
 * Hardcoding a price is a staleness trap, so treat the printed figure as an
 * order-of-magnitude check rather than an invoice: it exists to stop someone
 * launching a 30-call run without noticing, not to bill anyone. Override with
 * AI_PRICE_IN_PER_MTOK / AI_PRICE_OUT_PER_MTOK when the rate changes or when
 * AI_SCORING_MODEL points somewhere else.
 */
const PRICE_IN_PER_MTOK = Number(process.env.AI_PRICE_IN_PER_MTOK ?? 3);
const PRICE_OUT_PER_MTOK = Number(process.env.AI_PRICE_OUT_PER_MTOK ?? 15);

/** Rough tokens-per-character. Only ever used for the pre-run estimate; the
 *  report prints REAL token counts from the model's own usage numbers. */
const CHARS_PER_TOKEN = 4;

// ── Types ────────────────────────────────────────────────────

export type RunResult =
  | { ok: true; run: number; card: Scorecard; ms: number }
  | { ok: false; run: number; error: string; ms: number };

export type DimensionStat = {
  dimension: string;
  min: number;
  max: number;
  spread: number;
  stdDev: number;
};

export type ConsistencyReport = {
  applicationId: string;
  candidate: string;
  jobTitle: string;
  model: string;
  promptVersion: string;
  runs: RunResult[];
  /** Present only when at least two runs succeeded — one number has no spread. */
  stats: {
    scores: number[];
    min: number;
    max: number;
    spread: number;
    stdDev: number;
    mean: number;
    dimensions: DimensionStat[];
    /** Distinct verdict strings seen. 1 = stable. */
    distinctVerdicts: string[];
    verdictStable: boolean;
    /** Distinct missing_requirements SETS seen, order-insensitive. */
    distinctMissingSets: string[][];
    missingStable: boolean;
    /** Union minus intersection: requirements that appeared in some runs only. */
    unstableRequirements: string[];
    confidences: string[];
    confidenceStable: boolean;
    verifiedQuoteCounts: number[];
  } | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

// ── Stats ────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * POPULATION standard deviation, not sample.
 *
 * These runs are the entire set of observations we care about — we're not
 * inferring a property of some larger population from a sample of it — and at
 * n=3 the Bessel correction inflates the number by 22%, which would read as
 * worse consistency than was actually measured.
 */
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Order-insensitive, case-insensitive set key so "A, B" == "b, a". */
function setKey(items: string[]): string {
  return items
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(" | ");
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function summarise(cards: Scorecard[]): ConsistencyReport["stats"] {
  if (cards.length < 2) return null;

  const scores = cards.map((c) => c.overall_score);

  // Dimensions are compared BY NAME, not by position: the model returns them
  // in whatever order it likes, and a positional join would report drift that
  // is really just reordering.
  const dimensionNames = uniqueBy(
    cards.flatMap((c) => c.dimension_scores.map((d) => String(d.dimension))),
    (n) => n,
  );

  const dimensions: DimensionStat[] = dimensionNames.map((dimension) => {
    const values = cards
      .map((c) => c.dimension_scores.find((d) => String(d.dimension) === dimension))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => d.score);
    return {
      dimension,
      min: Math.min(...values),
      max: Math.max(...values),
      spread: Math.max(...values) - Math.min(...values),
      stdDev: round1(stdDev(values)),
    };
  });

  const distinctVerdicts = uniqueBy(
    cards.map((c) => c.verdict.trim()),
    (v) => v.toLowerCase(),
  );

  const missingSets = cards.map((c) => c.missing_requirements);
  const distinctMissingSets = uniqueBy(missingSets, setKey);

  // Which requirements the model only sometimes finds. A stable number with an
  // unstable requirement list is still a broken scorecard — the recruiter is
  // reading the list, not the arithmetic.
  const allRequirements = uniqueBy(
    missingSets.flat().map((r) => r.trim()),
    (r) => r.toLowerCase(),
  );
  const unstableRequirements = allRequirements.filter((req) => {
    const appearances = missingSets.filter((set) =>
      set.some((r) => r.trim().toLowerCase() === req.toLowerCase()),
    ).length;
    return appearances > 0 && appearances < missingSets.length;
  });

  const confidences = cards.map((c) => c.confidence as string);

  return {
    scores,
    min: Math.min(...scores),
    max: Math.max(...scores),
    spread: Math.max(...scores) - Math.min(...scores),
    stdDev: round1(stdDev(scores)),
    mean: round1(mean(scores)),
    dimensions,
    distinctVerdicts,
    verdictStable: distinctVerdicts.length === 1,
    distinctMissingSets,
    missingStable: distinctMissingSets.length === 1,
    unstableRequirements,
    confidences,
    confidenceStable: new Set(confidences).size === 1,
    verifiedQuoteCounts: cards.map((c) => c.evidence.length),
  };
}

// ── Loading (read-only) ──────────────────────────────────────

type Loaded = {
  applicationId: string;
  candidate: string;
  jobTitle: string;
  input: ScoreInput;
};

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run with `npx tsx --env-file=.env.local ...`",
    );
  }
  // Created directly rather than via @/lib/supabase/server, which also exports a
  // cookie-bound client and drags next/headers into a plain node process.
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Build a ScoreInput from a live application. SELECT only — this function is
 * the only database contact the harness makes, and it never writes.
 *
 * Mirrors the columns handleAiCvScore reads. That loader couldn't be reused
 * because it is welded to the write path; the duplication here is the SELECT
 * list, never the prompt.
 */
async function loadApplication(
  supabase: ReturnType<typeof serviceClient>,
  applicationId: string,
): Promise<Loaded> {
  const { data: appData, error: appErr } = await supabase
    .from("job_applications")
    .select(
      "id, first_name, last_name, job_id, cv_text, screening_answers, years_experience, city, country, notice_period, availability",
    )
    .eq("id", applicationId)
    .maybeSingle();

  if (appErr) throw new Error(`application lookup failed: ${appErr.message}`);
  if (!appData) throw new Error(`application ${applicationId} not found`);

  const app = appData as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    job_id: string | null;
    cv_text: string | null;
    screening_answers: unknown;
    years_experience: number | null;
    city: string | null;
    country: string | null;
    notice_period: string | null;
    availability: string | null;
  };

  if (!app.job_id) throw new Error(`application ${applicationId} has no job_id`);

  const { data: jobData, error: jobErr } = await supabase
    .from("jobs")
    .select(
      "id, title, description, responsibilities, requirements, experience_level, category, screening_questions",
    )
    .eq("id", app.job_id)
    .maybeSingle();

  if (jobErr) throw new Error(`job lookup failed: ${jobErr.message}`);
  if (!jobData) throw new Error(`job ${app.job_id} no longer exists`);

  const job = jobData as {
    title: string | null;
    description: string | null;
    responsibilities: string | null;
    requirements: string | null;
    experience_level: string | null;
    category: string | null;
    screening_questions: unknown;
  };

  return {
    applicationId: app.id,
    candidate:
      [app.first_name, app.last_name].filter(Boolean).join(" ").trim() ||
      "(unnamed)",
    jobTitle: job.title ?? "(untitled job)",
    input: {
      cvText: app.cv_text ?? "",
      screeningAnswers: Array.isArray(app.screening_answers)
        ? (app.screening_answers as ScreeningAnswerSnapshot[])
        : [],
      candidate: {
        yearsExperience: app.years_experience,
        city: app.city,
        country: app.country,
        noticePeriod: app.notice_period,
        availability: app.availability,
      },
      job: {
        title: job.title ?? "",
        description: job.description,
        responsibilities: job.responsibilities,
        requirements: job.requirements,
        experienceLevel: job.experience_level,
        category: job.category,
        screeningQuestions: Array.isArray(job.screening_questions)
          ? (job.screening_questions as ScreeningQuestion[])
          : [],
      },
    },
  };
}

// ── Running ──────────────────────────────────────────────────

/**
 * Score one application `runs` times, SEQUENTIALLY.
 *
 * Not parallel on purpose: concurrent calls share a rate-limit bucket, and a
 * 429 retried at a different moment is a confound we'd then have to explain
 * away in the variance numbers. A consistency run is not a latency benchmark.
 */
export async function runConsistency(
  loaded: Loaded,
  runs: number,
): Promise<ConsistencyReport> {
  const results: RunResult[] = [];

  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    try {
      const card = await scoreCv(loaded.input);
      results.push({ ok: true, run, card, ms: Date.now() - started });
    } catch (err) {
      results.push({
        ok: false,
        run,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  }

  const cards = results.flatMap((r) => (r.ok ? [r.card] : []));
  const inputTokens = cards.reduce((sum, c) => sum + c.input_tokens, 0);
  const outputTokens = cards.reduce((sum, c) => sum + c.output_tokens, 0);

  return {
    applicationId: loaded.applicationId,
    candidate: loaded.candidate,
    jobTitle: loaded.jobTitle,
    model: resolveScoringModel(),
    promptVersion: PROMPT_VERSION,
    runs: results,
    stats: summarise(cards),
    inputTokens,
    outputTokens,
    costUsd:
      (inputTokens / 1_000_000) * PRICE_IN_PER_MTOK +
      (outputTokens / 1_000_000) * PRICE_OUT_PER_MTOK,
  };
}

// ── Reporting ────────────────────────────────────────────────

function bar(label: string): string {
  return `\n${label}\n${"─".repeat(Math.max(label.length, 60))}`;
}

function formatReport(report: ConsistencyReport, threshold: number): string {
  const lines: string[] = [];
  lines.push(bar(`${report.candidate} — ${report.jobTitle}`));
  lines.push(`application  ${report.applicationId}`);
  lines.push(`model        ${report.model}   prompt ${report.promptVersion}`);

  lines.push("\nPER RUN");
  for (const r of report.runs) {
    if (!r.ok) {
      lines.push(`  run ${r.run}   FAILED  ${r.error}`);
      continue;
    }
    const c = r.card;
    const dims = c.dimension_scores
      .map((d) => `${String(d.dimension)} ${d.score}`)
      .join("  ");
    lines.push(
      `  run ${r.run}   overall ${String(c.overall_score).padStart(3)}   ` +
        `confidence ${c.confidence.padEnd(6)} ` +
        `quotes verified ${c.evidence.length}   (${(r.ms / 1000).toFixed(1)}s)`,
    );
    lines.push(`          ${dims}`);
    lines.push(`          verdict: ${c.verdict || "(none)"}`);
  }

  const s = report.stats;
  if (!s) {
    lines.push("\nNot enough successful runs to measure variance.");
    return lines.join("\n");
  }

  lines.push("\nACROSS RUNS");
  lines.push(
    `  overall      min ${s.min}   max ${s.max}   spread ${s.spread}   ` +
      `sd ${s.stdDev}   mean ${s.mean}`,
  );
  for (const d of s.dimensions) {
    lines.push(
      `  ${d.dimension.padEnd(12)} min ${String(d.min).padStart(3)}   ` +
        `max ${String(d.max).padStart(3)}   spread ${String(d.spread).padStart(3)}   sd ${d.stdDev}`,
    );
  }

  lines.push(
    `\n  verdict      ${s.verdictStable ? "STABLE" : `UNSTABLE — ${s.distinctVerdicts.length} distinct`}`,
  );
  if (!s.verdictStable) {
    for (const v of s.distinctVerdicts) lines.push(`                 · ${v}`);
  }

  lines.push(
    `  missing reqs ${s.missingStable ? "STABLE" : `UNSTABLE — ${s.distinctMissingSets.length} distinct sets`}`,
  );
  for (const req of s.unstableRequirements) {
    lines.push(`                 ? ${req}   (appears in some runs only)`);
  }

  lines.push(
    `  confidence   ${s.confidenceStable ? `STABLE (${s.confidences[0]})` : `UNSTABLE — ${s.confidences.join(", ")}`}`,
  );
  lines.push(`  quotes       ${s.verifiedQuoteCounts.join(", ")}`);

  // The number is the number, but a stable score with an unstable verdict is
  // still a failure: the verdict is the line a recruiter actually reads.
  const numericFail = s.spread > threshold;
  const textFail = !s.verdictStable || !s.missingStable;
  lines.push(
    `\n  VERDICT: ${
      numericFail || textFail
        ? `TOO VARIABLE${numericFail ? ` — spread ${s.spread} > ${threshold}` : ""}${
            textFail ? " — narrative text is unstable" : ""
          }`
        : `consistent (spread ${s.spread} <= ${threshold}, text stable)`
    }`,
  );

  lines.push(
    `\n  tokens in ${report.inputTokens.toLocaleString()} · out ${report.outputTokens.toLocaleString()} · ~$${report.costUsd.toFixed(3)}`,
  );
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────

const USAGE = `
Scorer consistency check — scores the same CV N times and reports the drift.

  npx tsx --env-file=.env.local src/lib/ai/score-consistency.ts <application-id...> [options]

Options
  --runs N        times to score each application   (default ${DEFAULT_RUNS}, max ${MAX_RUNS})
  --threshold N   spread above which a scorer is "too variable"  (default 5)
  --yes           actually run. Without it, prints the cost estimate and stops.
  --json          machine-readable output
  --help

Caps: ${MAX_APPLICATIONS} applications, ${MAX_RUNS} runs each, ${MAX_TOTAL_CALLS} model calls total.

Writes NOTHING to the database. Calls scoreCv directly, so application_scores
is never touched — a run cannot overwrite a real score or a human override.

Example
  npx tsx --env-file=.env.local src/lib/ai/score-consistency.ts \\
    3f8e1c20-0000-0000-0000-000000000000 --runs 3 --yes
`;

type Args = {
  ids: string[];
  runs: number;
  threshold: number;
  confirm: boolean;
  json: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    ids: [],
    runs: DEFAULT_RUNS,
    threshold: 5,
    confirm: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes") out.confirm = true;
    else if (a === "--json") out.json = true;
    else if (a === "--runs") out.runs = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--threshold")
      out.threshold = Number.parseInt(argv[++i] ?? "", 10);
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else out.ids.push(a);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.ids.length === 0) {
    console.log(USAGE);
    return;
  }

  if (!Number.isInteger(args.runs) || args.runs < 2) {
    throw new Error("--runs must be a whole number of at least 2 — one run has no variance to measure.");
  }
  if (args.runs > MAX_RUNS) {
    throw new Error(`--runs is capped at ${MAX_RUNS}.`);
  }
  if (args.ids.length > MAX_APPLICATIONS) {
    throw new Error(
      `At most ${MAX_APPLICATIONS} applications per run (got ${args.ids.length}).`,
    );
  }
  const totalCalls = args.ids.length * args.runs;
  if (totalCalls > MAX_TOTAL_CALLS) {
    throw new Error(
      `${args.ids.length} applications x ${args.runs} runs = ${totalCalls} model calls, over the ${MAX_TOTAL_CALLS} cap.`,
    );
  }

  const supabase = serviceClient();

  // Load first so the estimate is built from the REAL prompt these runs will
  // send — buildUserMessage is the same function scoreCv uses — rather than
  // from a guessed average CV length.
  const loaded: Loaded[] = [];
  for (const id of args.ids) loaded.push(await loadApplication(supabase, id));

  const estInputTokens = loaded.reduce(
    (sum, l) =>
      sum + Math.ceil(buildUserMessage(l.input).length / CHARS_PER_TOKEN) * args.runs,
    0,
  );
  // Output is bounded by MAX_TOKENS in cv-scoring; assume the ceiling so the
  // estimate errs high rather than low.
  const estOutputTokens = totalCalls * 3000;
  const estCost =
    (estInputTokens / 1_000_000) * PRICE_IN_PER_MTOK +
    (estOutputTokens / 1_000_000) * PRICE_OUT_PER_MTOK;

  console.log(bar("CONSISTENCY RUN — ESTIMATE"));
  console.log(`  model        ${resolveScoringModel()}  ·  prompt ${PROMPT_VERSION}`);
  console.log(`  applications ${loaded.length}   runs each ${args.runs}   model calls ${totalCalls}`);
  for (const l of loaded) {
    console.log(`    · ${l.candidate} — ${l.jobTitle}`);
  }
  console.log(
    `  tokens       ~${estInputTokens.toLocaleString()} in · ~${estOutputTokens.toLocaleString()} out (worst case)`,
  );
  console.log(
    `  cost         ~$${estCost.toFixed(2)} at $${PRICE_IN_PER_MTOK}/$${PRICE_OUT_PER_MTOK} per Mtok`,
  );
  console.log("  writes       NONE — application_scores is not touched");

  if (!args.confirm) {
    console.log("\n  Nothing has been run. Re-run with --yes to spend this.\n");
    return;
  }

  console.log(`\n  Running ${totalCalls} model calls…`);

  const reports: ConsistencyReport[] = [];
  for (const l of loaded) {
    const report = await runConsistency(l, args.runs);
    reports.push(report);
    if (!args.json) console.log(formatReport(report, args.threshold));
  }

  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  const spent = reports.reduce((sum, r) => sum + r.costUsd, 0);
  const variable = reports.filter(
    (r) =>
      r.stats &&
      (r.stats.spread > args.threshold ||
        !r.stats.verdictStable ||
        !r.stats.missingStable),
  );
  console.log(bar("SUMMARY"));
  console.log(
    `  ${variable.length} of ${reports.length} applications exceeded the consistency bar.`,
  );
  console.log(`  actual spend ~$${spent.toFixed(3)}\n`);
}

// Only runs when invoked directly, so importing this module from a test or
// another script never triggers a paid run.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
