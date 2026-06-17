"use client";

import { Plus, X as XIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

// Style constants — byte-identical to the originals in _apply-modal.tsx so the
// wizard's new fields render with the same input/label chrome as the existing
// contact fields. Importing avoids drift if either file gets re-themed later.
export const INPUT_CLS =
  "w-full rounded-xl border border-black/10 bg-[#FAFAFA] px-4 py-3.5 text-base sm:text-[0.88rem] text-remotiv-text-dark outline-none transition-all placeholder:text-[#bbb] focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/15";
export const LABEL_CLS =
  "mb-1.5 block text-[0.72rem] font-semibold uppercase tracking-widest text-[#6b6b6b]";

const TEXTAREA_CLS =
  "w-full rounded-xl border border-black/10 bg-[#FAFAFA] px-4 py-3 text-base sm:text-[0.88rem] text-remotiv-text-dark outline-none transition-all placeholder:text-[#bbb] focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/15";

// ── Enum lists ──────────────────────────────────────────────
// Role category labels mirror the canonical list in
// src/app/admin/_components/move-to-talent-modal.tsx (the admin-side promote
// flow) so an admin reviewing an applicant sees the same option strings the
// applicant chose.
export const ROLE_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Engineer", label: "Engineer" },
  { value: "SDR", label: "SDR / Sales" },
  { value: "CS", label: "Customer Success" },
  { value: "Design", label: "Design & UX" },
  { value: "Data", label: "Data & AI" },
  { value: "DevOps", label: "DevOps & Cloud" },
  { value: "QA", label: "Quality Assurance" },
  { value: "Marketing", label: "Marketing & Growth" },
  { value: "Ops", label: "Business & Ops" },
  { value: "Finance", label: "Finance & Accounting" },
  { value: "Other", label: "Other" },
];

export const COUNTRIES: ReadonlyArray<string> = [
  "Pakistan",
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "Other",
];

// Server-side validators in /api/talent/route.ts treat these as the canonical
// label strings; matching exactly keeps the apply payload immediately
// interchangeable with a /become-a-talent submission.
export const AVAILABILITY_OPTIONS: ReadonlyArray<string> = [
  "Available Now",
  "Not Available",
];
export const WORK_TYPE_OPTIONS: ReadonlyArray<string> = [
  "Full-time",
  "Part-time",
  "Contract",
  "Any",
];
export const NOTICE_PERIOD_OPTIONS: ReadonlyArray<string> = [
  "Immediate",
  "2 Weeks",
  "1 Month",
  "Negotiable",
];
export const WORK_LOCATION_OPTIONS: ReadonlyArray<string> = [
  "Remote",
  "Hybrid",
  "Onsite",
];

// ── Work experience shape ───────────────────────────────────
// Mirrors /become-a-talent/page.tsx:117-129 so the submit payload is a
// drop-in replacement when /api/apply learns to read employment_history.
export type WorkExperience = {
  id: string;
  title: string;
  company: string;
  start: string;
  end: string;
  currentlyWorking: boolean;
  description: string;
  // Comma-separated free-text while editing; split into an array at submit
  // time (same pattern /become-a-talent uses at L805-808).
  skills: string;
};

export function makeEmptyExperience(): WorkExperience {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `exp-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    title: "",
    company: "",
    start: "",
    end: "",
    currentlyWorking: false,
    description: "",
    skills: "",
  };
}

const MAX_SKILLS = 30;
const MAX_EXPERIENCES = 30;
const EXPERIENCE_DESC_MAX = 1000;

// ── Field wrapper ───────────────────────────────────────────

export function Field({
  label,
  required,
  optional,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className={LABEL_CLS}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-remotiv-purple">
            {" *"}
          </span>
        )}
        {optional && (
          <span className="ml-1 text-[0.65rem] font-medium normal-case tracking-normal text-[#bbb]">
            optional
          </span>
        )}
      </label>
      {children}
      {hint && <p className="mt-1 text-[0.7rem] text-gray-400">{hint}</p>}
    </div>
  );
}

// ── Pill radio group ────────────────────────────────────────

const PILL_BASE =
  "cursor-pointer rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors";
const PILL_SELECTED =
  "border-remotiv-purple bg-remotiv-purple/8 text-remotiv-purple";
const PILL_DEFAULT =
  "border-black/10 bg-white text-[#555] hover:border-remotiv-purple/30";

export function PillGroup({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<string>;
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex flex-wrap gap-2"
    >
      {options.map((o) => {
        const selected = value === o;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o)}
            className={cn(PILL_BASE, selected ? PILL_SELECTED : PILL_DEFAULT)}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

// ── Skill tag input ─────────────────────────────────────────

export function SkillTags({
  value,
  onChange,
  placeholder = "Add a skill, press Enter…",
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (value.includes(v)) {
      setDraft("");
      return;
    }
    if (value.length >= MAX_SKILLS) return;
    onChange([...value, v]);
    setDraft("");
  }

  function remove(tag: string) {
    onChange(value.filter((s) => s !== tag));
  }

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-1.5 rounded-xl border border-black/10 bg-[#FAFAFA] px-3 py-2 transition-colors focus-within:border-remotiv-purple focus-within:ring-2 focus-within:ring-remotiv-purple/15">
      {value.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 rounded-md bg-remotiv-purple/10 px-2 py-0.5 text-xs font-semibold text-remotiv-purple"
        >
          {s}
          <button
            type="button"
            onClick={() => remove(s)}
            aria-label={`Remove ${s}`}
            className="text-remotiv-purple/60 hover:text-remotiv-purple"
          >
            <XIcon className="size-3" strokeWidth={2.5} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length > 0) {
            remove(value[value.length - 1]);
          }
        }}
        onBlur={() => {
          if (draft.trim()) add(draft);
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        maxLength={50}
        className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm text-remotiv-text-dark outline-none placeholder:text-[#bbb]"
      />
    </div>
  );
}

// ── Experience list ─────────────────────────────────────────

export function ExperienceList({
  value,
  onChange,
}: {
  value: WorkExperience[];
  onChange: (v: WorkExperience[]) => void;
}) {
  function update(id: string, patch: Partial<WorkExperience>) {
    onChange(value.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function remove(id: string) {
    if (value.length <= 1) return;
    onChange(value.filter((e) => e.id !== id));
  }
  function add() {
    if (value.length >= MAX_EXPERIENCES) return;
    onChange([...value, makeEmptyExperience()]);
  }

  return (
    <div className="flex flex-col gap-4">
      {value.map((exp, idx) => (
        <div
          key={exp.id}
          className="relative rounded-xl border border-black/10 bg-[#FAFAFA]/50 p-4"
        >
          {value.length > 1 && (
            <button
              type="button"
              onClick={() => remove(exp.id)}
              aria-label={`Remove experience ${idx + 1}`}
              className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500"
            >
              <XIcon className="size-3.5" strokeWidth={2} />
            </button>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Job Title"
              required
              htmlFor={`exp-${exp.id}-title`}
            >
              <input
                id={`exp-${exp.id}-title`}
                type="text"
                value={exp.title}
                onChange={(e) => update(exp.id, { title: e.target.value })}
                placeholder="e.g. Senior Engineer"
                className={INPUT_CLS}
                maxLength={200}
              />
            </Field>
            <Field
              label="Company"
              required
              htmlFor={`exp-${exp.id}-company`}
            >
              <input
                id={`exp-${exp.id}-company`}
                type="text"
                value={exp.company}
                onChange={(e) => update(exp.id, { company: e.target.value })}
                placeholder="e.g. Acme Co."
                className={INPUT_CLS}
                maxLength={200}
              />
            </Field>
            <Field label="Start" htmlFor={`exp-${exp.id}-start`}>
              <input
                id={`exp-${exp.id}-start`}
                type="text"
                value={exp.start}
                onChange={(e) => update(exp.id, { start: e.target.value })}
                placeholder="e.g. Jan 2021"
                className={INPUT_CLS}
                maxLength={200}
              />
            </Field>
            <Field label="End" htmlFor={`exp-${exp.id}-end`}>
              <input
                id={`exp-${exp.id}-end`}
                type="text"
                value={exp.currentlyWorking ? "Present" : exp.end}
                onChange={(e) => update(exp.id, { end: e.target.value })}
                placeholder="e.g. Dec 2023"
                disabled={exp.currentlyWorking}
                className={cn(
                  INPUT_CLS,
                  exp.currentlyWorking && "cursor-not-allowed opacity-60",
                )}
                maxLength={200}
              />
            </Field>
          </div>
          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-[0.78rem] text-[#555]">
            <input
              type="checkbox"
              checked={exp.currentlyWorking}
              onChange={(e) =>
                update(exp.id, { currentlyWorking: e.target.checked })
              }
              className="size-4 rounded border-gray-300 text-remotiv-purple focus:ring-remotiv-purple"
            />
            I currently work here
          </label>
          <div className="mt-3">
            <Field
              label="Description"
              optional
              htmlFor={`exp-${exp.id}-description`}
            >
              <textarea
                id={`exp-${exp.id}-description`}
                rows={3}
                value={exp.description}
                onChange={(e) =>
                  update(exp.id, { description: e.target.value })
                }
                placeholder="What you owned, shipped, and the impact (metrics, scale, results)…"
                className={TEXTAREA_CLS}
                maxLength={EXPERIENCE_DESC_MAX}
              />
            </Field>
            {exp.description.length > 0 && (
              <p
                className={cn(
                  "mt-1 text-right text-[0.65rem]",
                  exp.description.length >= EXPERIENCE_DESC_MAX
                    ? "text-red-500"
                    : "text-gray-400",
                )}
                aria-live="polite"
              >
                {exp.description.length} / {EXPERIENCE_DESC_MAX}
              </p>
            )}
          </div>
          <div className="mt-3">
            <Field
              label="Skills used"
              optional
              htmlFor={`exp-${exp.id}-skills`}
            >
              <input
                id={`exp-${exp.id}-skills`}
                type="text"
                value={exp.skills}
                onChange={(e) => update(exp.id, { skills: e.target.value })}
                placeholder="React, Node.js, AWS (comma separated)"
                className={INPUT_CLS}
              />
            </Field>
          </div>
        </div>
      ))}
      {value.length < MAX_EXPERIENCES && (
        <button
          type="button"
          onClick={add}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-remotiv-purple/30 bg-remotiv-purple/5 px-3 py-2.5 text-xs font-semibold text-remotiv-purple transition-colors hover:bg-remotiv-purple/10"
        >
          <Plus className="size-3.5" strokeWidth={2} />
          Add another job
        </button>
      )}
    </div>
  );
}
