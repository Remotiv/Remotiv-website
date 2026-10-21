import type { PipelineStage } from "./applicant-types";

/**
 * Stage-pill styling, and what happens to a stage this build has never heard of.
 *
 * `job_applications.pipeline_stage` is a CHECK-constrained text column and
 * `PIPELINE_STAGES` is a copy of that constraint. A row can therefore arrive
 * carrying a value this build does not know — and until this module existed,
 * indexing the pill map with it returned undefined, which the Applicants pills
 * then dereferenced (`.cls`) into a TypeError that took the whole row list
 * down. Both shapes resolve through a function here instead.
 *
 * Two shapes on purpose, because the two pages are built differently:
 * Applicants needs a tint plus a dot colour, Overview interpolates one flat
 * class string. A single shape would force one of them to carry a field it
 * never renders.
 *
 * Pure data and lookups: no React, no "use client", no server imports — which
 * is what lets stage-tabs.test.ts drive an unknown stage straight through it.
 */

export type StagePill = { cls: string; dot: string };

/** Neutral, and deliberately not Applied's tint — an unknown stage must not read as Applied. */
export const UNKNOWN_STAGE_PILL: StagePill = {
  cls: "bg-black/[0.06] text-[var(--ai-t3)]",
  dot: "bg-[var(--ai-t4)]",
};

const APPLICANT_STAGE_PILL: Record<PipelineStage, StagePill> = {
  applied: {
    cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    dot: "bg-[var(--ai-t4)]",
  },
  screening: {
    cls: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
    dot: "bg-[var(--ai-amber-dot)]",
  },
  shortlisted: {
    cls: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
    dot: "bg-remotiv-green",
  },
  interview: {
    cls: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
    dot: "bg-[#4C8DD9]",
  },
  offer: {
    cls: "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]",
    dot: "bg-remotiv-purple",
  },
  // Hired is the only solid fill.
  hired: {
    cls: "bg-remotiv-green text-[var(--ai-mint-ink)]",
    dot: "bg-[var(--ai-mint-ink)]",
  },
  rejected: {
    cls: "bg-[#FBEAE8] text-[#B02A24]",
    dot: "bg-[#E0524B]",
  },
};

/**
 * The Applicants pills: a tint class and a dot class, both always present.
 *
 * `Object.hasOwn`, not `??`: these maps are plain objects and inherit from
 * `Object.prototype`, so `APPLICANT_STAGE_PILL["__proto__"]` is the prototype
 * object and `["toString"]` is a function — both truthy, so `??` would not
 * fire and `.cls` would then interpolate the literal "undefined" into a
 * className. Own-key only.
 */
export function stagePill(stage: string): StagePill {
  return Object.hasOwn(APPLICANT_STAGE_PILL, stage)
    ? APPLICANT_STAGE_PILL[stage as PipelineStage]
    : UNKNOWN_STAGE_PILL;
}

export const UNKNOWN_OVERVIEW_STAGE_PILL = "bg-black/[0.06] text-[var(--ai-t3)]";

const OVERVIEW_STAGE_PILL: Record<PipelineStage, string> = {
  applied: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
  screening: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
  shortlisted: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
  interview: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
  offer: "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]",
  hired: "bg-remotiv-green text-[var(--ai-mint-ink)]",
  rejected: "bg-[#FBEAE8] text-[#B02A24]",
};

/**
 * The Overview pill: one class string, interpolated into `className`.
 *
 * Without the fallback an unknown stage emitted the literal "undefined" as a
 * class name — unstyled rather than crashed, which is quieter and so easier to
 * ship without noticing.
 */
export function overviewStagePill(stage: string): string {
  return Object.hasOwn(OVERVIEW_STAGE_PILL, stage)
    ? OVERVIEW_STAGE_PILL[stage as PipelineStage]
    : UNKNOWN_OVERVIEW_STAGE_PILL;
}
