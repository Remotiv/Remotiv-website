"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Plus, UserCheck, X } from "lucide-react";
import {
  moveApplicationToTalent,
  type JobApplication,
} from "@/app/admin/applications/actions";

// ── Option sets ───────────────────────────────────────────────
// Values mirror the strings written by /become-a-talent so the resulting
// talent profile is interchangeable with one created via the public form.

const ROLE_CATEGORIES = [
  { value: "Engineer",  label: "Engineer" },
  { value: "SDR",       label: "SDR / Sales" },
  { value: "CS",        label: "Customer Success" },
  { value: "Design",    label: "Design & UX" },
  { value: "Data",      label: "Data & AI" },
  { value: "DevOps",    label: "DevOps & Cloud" },
  { value: "QA",        label: "Quality Assurance" },
  { value: "Marketing", label: "Marketing & Growth" },
  { value: "Ops",       label: "Business & Ops" },
  { value: "Finance",   label: "Finance & Accounting" },
  { value: "Other",     label: "Other" },
] as const;

const AVAILABILITY_OPTIONS = [
  { value: "Available Now",   label: "Available Now" },
  { value: "Not Available",   label: "Not Currently Available" },
] as const;

const WORK_TYPE_OPTIONS = [
  { value: "Full-time", label: "Full-time" },
  { value: "Part-time", label: "Part-time" },
  { value: "Contract",  label: "Contract" },
  { value: "Any",       label: "Open to Any" },
] as const;

const NOTICE_PERIOD_OPTIONS = [
  { value: "Immediate",  label: "Immediate" },
  { value: "2 Weeks",    label: "2 Weeks" },
  { value: "1 Month",    label: "1 Month" },
  { value: "Negotiable", label: "Negotiable" },
] as const;

const WORK_LOCATION_OPTIONS = [
  { value: "Remote", label: "Remote Only" },
  { value: "Hybrid", label: "Open to Hybrid" },
  { value: "Onsite", label: "Open to Onsite" },
] as const;

// ── Shared classNames ─────────────────────────────────────────

const INPUT_CLS =
  "w-full h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none transition-colors focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";

const TEXTAREA_CLS =
  "w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-gray-800 outline-none transition-colors focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";

const LABEL_CLS = "mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500";

const REQ_MARK = <span className="ml-0.5 text-red-500">*</span>;

// ── Types ─────────────────────────────────────────────────────

type EmploymentDraft = {
  id: number;
  title: string;
  company: string;
  dates: string;
  description: string;
};

// ── Pieces ────────────────────────────────────────────────────

function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <span className={LABEL_CLS}>
        {label}
        {required && REQ_MARK}
      </span>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

type RadioOption = { value: string; label: string };

function RadioGroup({
  options,
  value,
  onChange,
  name,
}: {
  options: ReadonlyArray<RadioOption>;
  value: string;
  onChange: (v: string) => void;
  name: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label
          key={o.value}
          // `relative` is critical: without it, the `sr-only` radio input
          // becomes positioned against the next-positioned ancestor (the
          // dialog), which makes browser focus-into-view scroll the modal
          // body back to the top on every click — hiding sections below
          // Notice Period until the user re-scrolls.
          className={`relative flex cursor-pointer items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-semibold ${
            value === o.value
              ? "border-[#49D7A7] bg-[#49D7A7]/8 text-[#1a9e73]"
              : "border-gray-200 bg-white text-gray-600 hover:border-[#49D7A7]/40"
          }`}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          <span
            className={`size-3 rounded-full border ${
              value === o.value ? "border-[#49D7A7] bg-[#49D7A7]" : "border-gray-300"
            }`}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function SkillsInput({
  skills,
  onChange,
}: {
  skills: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const v = raw.trim();
    if (!v || skills.includes(v) || skills.length >= 30) return;
    onChange([...skills, v]);
    setDraft("");
  }

  function remove(tag: string) {
    onChange(skills.filter((s) => s !== tag));
  }

  return (
    <div
      className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 transition-colors focus-within:border-[#7E47FF] focus-within:ring-2 focus-within:ring-[#7E47FF]/20"
      onClick={(e) => {
        const target = e.currentTarget.querySelector("input");
        if (target) target.focus();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const target = e.currentTarget.querySelector("input");
          if (target) target.focus();
        }
      }}
      role="presentation"
    >
      {skills.map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 rounded-md bg-[#7E47FF]/10 px-2 py-0.5 text-xs font-semibold text-[#7E47FF]"
        >
          {s}
          <button
            type="button"
            onClick={() => remove(s)}
            aria-label={`Remove ${s}`}
            className="text-[#7E47FF]/60 hover:text-[#7E47FF]"
          >
            <X className="size-3" strokeWidth={2.5} />
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
          } else if (e.key === "Backspace" && !draft && skills.length > 0) {
            remove(skills[skills.length - 1]);
          }
        }}
        onBlur={() => {
          if (draft.trim()) add(draft);
        }}
        placeholder={skills.length === 0 ? "Type a skill and press Enter…" : ""}
        className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm text-gray-800 outline-none placeholder:text-gray-400"
      />
    </div>
  );
}

function ApplicantCard({ app }: { app: JobApplication }) {
  return (
    <div className="rounded-2xl border border-[#7E47FF]/15 bg-[#7E47FF]/5 px-5 py-4">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-[#7E47FF]">
        Moving to Talent
      </p>
      <p className="font-heading text-base font-bold text-gray-900">
        {app.first_name} {app.last_name}
      </p>
      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-gray-600 sm:grid-cols-2">
        <p>
          <span className="text-gray-400">Email:</span>{" "}
          <span className="font-medium">{app.email}</span>
        </p>
        {app.phone && (
          <p>
            <span className="text-gray-400">Phone:</span>{" "}
            <span className="font-medium">{app.phone}</span>
          </p>
        )}
        {app.linkedin_url && (
          <p>
            <span className="text-gray-400">LinkedIn:</span>{" "}
            <a
              href={app.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#0A66C2] hover:underline"
            >
              View profile
            </a>
          </p>
        )}
        {app.cv_url && (
          <p className="flex items-center gap-1.5">
            <span className="text-gray-400">CV:</span>
            <a
              href={app.cv_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-[#7E47FF] hover:underline"
            >
              <ExternalLink className="size-3" strokeWidth={2} />
              View CV
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────

export function MoveToTalentModal({
  app,
  onClose,
  onSuccess,
}: {
  app: JobApplication;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  // Profile fields
  const [jobTitle, setJobTitle]               = useState("");
  const [roleCategory, setRoleCategory]       = useState("");
  const [yearsExp, setYearsExp]               = useState<string>("");
  const [industry, setIndustry]               = useState("");
  const [degree, setDegree]                   = useState("");
  const [institution, setInstitution]         = useState("");
  const [skills, setSkills]                   = useState<string[]>([]);
  const [summary, setSummary]                 = useState("");

  // Work prefs
  const [availability, setAvailability]   = useState<string>("");
  const [workType, setWorkType]           = useState<string>("");
  const [noticePeriod, setNoticePeriod]   = useState<string>("");
  const [workLocation, setWorkLocation]   = useState<string>("");

  // Compensation
  const [salaryMin, setSalaryMin] = useState<string>("");
  const [salaryMax, setSalaryMax] = useState<string>("");

  // Employment history
  const [employment, setEmployment] = useState<EmploymentDraft[]>([]);

  // Submission state
  const [error, setError]         = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Dirty + submitting tracked in refs so toggling them never triggers a
  // re-render of the form. (A useState-based dirty flag was the source of a
  // freeze: it re-fired the keydown effect on every first edit and forced
  // every RadioGroup to re-render when only one had actually changed.)
  const dirtyRef = useRef(false);
  const submittingRef = useRef(false);
  submittingRef.current = submitting;

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  const attemptClose = useCallback(() => {
    if (submittingRef.current) return;
    if (dirtyRef.current) {
      const ok = window.confirm(
        "Discard changes? Any data you entered will be lost.",
      );
      if (!ok) return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") attemptClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [attemptClose]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Centralized dirty-tracking: a single effect watches every form field and
  // flips the ref once any of them change. This lets us pass raw `setX` setters
  // straight to children — no per-render closure rebuilds, no markDirty calls
  // on the click hot path.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    dirtyRef.current = true;
  }, [
    jobTitle, roleCategory, yearsExp, industry, degree, institution,
    skills, summary, availability, workType, noticePeriod, workLocation,
    salaryMin, salaryMax, employment,
  ]);

  function addEmploymentEntry() {
    markDirty();
    setEmployment((prev) => [
      ...prev,
      { id: Date.now(), title: "", company: "", dates: "", description: "" },
    ]);
  }

  function updateEmployment(id: number, patch: Partial<EmploymentDraft>) {
    markDirty();
    setEmployment((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function removeEmployment(id: number) {
    markDirty();
    setEmployment((prev) => prev.filter((e) => e.id !== id));
  }

  // Parse-on-submit: salary numbers, years
  const parsed = useMemo(() => {
    const yrs = Number.parseInt(yearsExp, 10);
    const min = salaryMin.trim() ? Number.parseInt(salaryMin, 10) : null;
    const max = salaryMax.trim() ? Number.parseInt(salaryMax, 10) : null;
    return {
      years_experience: Number.isFinite(yrs) ? yrs : NaN,
      salary_min: min !== null && Number.isFinite(min) ? min : null,
      salary_max: max !== null && Number.isFinite(max) ? max : null,
    };
  }, [yearsExp, salaryMin, salaryMax]);

  function validate(): string | null {
    if (!jobTitle.trim())     return "Job Title is required.";
    if (!roleCategory)        return "Role Category is required.";
    if (!Number.isFinite(parsed.years_experience) || parsed.years_experience < 0) {
      return "Years of Experience must be 0 or greater.";
    }
    if (!industry.trim())     return "Industry is required.";
    if (!degree.trim())       return "Degree is required.";
    if (!institution.trim())  return "Institution is required.";
    if (!availability)        return "Availability is required.";
    if (!workType)            return "Work Type is required.";
    if (!noticePeriod)        return "Notice Period is required.";
    if (
      parsed.salary_min !== null &&
      parsed.salary_max !== null &&
      parsed.salary_min > parsed.salary_max
    ) {
      return "Salary minimum cannot exceed maximum.";
    }
    return null;
  }

  async function handleSubmit() {
    setError(null);
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSubmitting(true);

    const cleanedEmployment = employment
      .map((e) => ({
        title:       e.title.trim(),
        company:     e.company.trim(),
        dates:       e.dates.trim(),
        description: e.description.trim(),
      }))
      .filter((e) => e.title || e.company || e.dates || e.description);

    const result = await moveApplicationToTalent(app.id, {
      job_title:        jobTitle.trim(),
      role_category:    roleCategory,
      years_experience: parsed.years_experience,
      industry:         industry.trim(),
      degree:           degree.trim(),
      institution:      institution.trim(),
      skills,
      summary:          summary.trim(),
      employment_history: cleanedEmployment,
      availability,
      work_type:        workType,
      notice_period:    noticePeriod,
      work_location:    workLocation,
      salary_min:       parsed.salary_min,
      salary_max:       parsed.salary_max,
    });

    setSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    onSuccess("Profile moved to Talent. Approve in /admin/talent to publish.");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:p-8">
      <button
        type="button"
        aria-label="Close modal"
        onClick={attemptClose}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-to-talent-title"
        className="relative my-4 flex w-full max-w-[720px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        style={{ maxHeight: "90vh" }}
      >
        {/* Header */}
        <div className="relative shrink-0 border-b border-gray-100 bg-white px-6 py-5">
          <button
            type="button"
            onClick={attemptClose}
            disabled={submitting}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2
            id="move-to-talent-title"
            className="font-heading text-lg font-bold text-gray-900"
          >
            Move to Talent Network
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Fill in the missing profile details. The application stays in Applications;
            this only creates a new pending Talent profile.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <ApplicantCard app={app} />

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Professional Profile */}
          <Section title="Professional Profile">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Job Title / Role" required>
                <input
                  type="text"
                  value={jobTitle}
                  onChange={(e) => { markDirty(); setJobTitle(e.target.value); }}
                  placeholder="e.g. Senior Frontend Engineer"
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Role Category" required>
                <select
                  value={roleCategory}
                  onChange={(e) => { markDirty(); setRoleCategory(e.target.value); }}
                  className={INPUT_CLS}
                >
                  <option value="">Select category…</option>
                  {ROLE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Years of Experience" required>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={yearsExp}
                  onChange={(e) => { markDirty(); setYearsExp(e.target.value); }}
                  placeholder="e.g. 5"
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Industry" required>
                <input
                  type="text"
                  value={industry}
                  onChange={(e) => { markDirty(); setIndustry(e.target.value); }}
                  placeholder="e.g. Software & Technology"
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Degree" required>
                <input
                  type="text"
                  value={degree}
                  onChange={(e) => { markDirty(); setDegree(e.target.value); }}
                  placeholder="e.g. BSc Computer Science"
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Institution" required>
                <input
                  type="text"
                  value={institution}
                  onChange={(e) => { markDirty(); setInstitution(e.target.value); }}
                  placeholder="e.g. NUST"
                  className={INPUT_CLS}
                />
              </Field>
            </div>

            <div className="mt-4">
              <Field label="Skills" hint="Press Enter or comma to add.">
                <SkillsInput
                  skills={skills}
                  onChange={(v) => { markDirty(); setSkills(v); }}
                />
              </Field>
            </div>

            <div className="mt-4">
              <Field label="Professional Summary">
                <textarea
                  rows={4}
                  value={summary}
                  onChange={(e) => { markDirty(); setSummary(e.target.value); }}
                  placeholder="Short bio — experience, specialism, and what they're looking for."
                  className={TEXTAREA_CLS}
                />
              </Field>
            </div>
          </Section>

          {/* Work Preferences */}
          <Section title="Work Preferences">
            <div className="flex flex-col gap-4">
              <Field label="Availability" required>
                <RadioGroup
                  options={AVAILABILITY_OPTIONS}
                  value={availability}
                  onChange={setAvailability}
                  name="mtt-availability"
                />
              </Field>
              <Field label="Work Type" required>
                <RadioGroup
                  options={WORK_TYPE_OPTIONS}
                  value={workType}
                  onChange={setWorkType}
                  name="mtt-work-type"
                />
              </Field>
              <Field label="Notice Period" required>
                <RadioGroup
                  options={NOTICE_PERIOD_OPTIONS}
                  value={noticePeriod}
                  onChange={setNoticePeriod}
                  name="mtt-notice-period"
                />
              </Field>
              <Field label="Work Location">
                <RadioGroup
                  options={WORK_LOCATION_OPTIONS}
                  value={workLocation}
                  onChange={setWorkLocation}
                  name="mtt-work-location"
                />
              </Field>
            </div>
          </Section>

          {/* Compensation */}
          <Section title="Compensation (optional)">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Salary Min ($/month)">
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={salaryMin}
                  onChange={(e) => { markDirty(); setSalaryMin(e.target.value); }}
                  placeholder="e.g. 2000"
                  className={INPUT_CLS}
                />
              </Field>
              <Field label="Salary Max ($/month)">
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={salaryMax}
                  onChange={(e) => { markDirty(); setSalaryMax(e.target.value); }}
                  placeholder="e.g. 4000"
                  className={INPUT_CLS}
                />
              </Field>
            </div>
          </Section>

          {/* Employment History */}
          <Section title="Employment History (optional)">
            {employment.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                No entries yet. Add as many as you like.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {employment.map((entry, idx) => (
                  <div
                    key={entry.id}
                    className="relative rounded-xl border border-gray-200 bg-gray-50/40 px-4 py-3"
                  >
                    <button
                      type="button"
                      onClick={() => removeEmployment(entry.id)}
                      aria-label={`Remove entry ${idx + 1}`}
                      className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                    >
                      <X className="size-3.5" strokeWidth={2} />
                    </button>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Title">
                        <input
                          type="text"
                          value={entry.title}
                          onChange={(e) => updateEmployment(entry.id, { title: e.target.value })}
                          placeholder="e.g. Senior Engineer"
                          className={INPUT_CLS}
                        />
                      </Field>
                      <Field label="Company">
                        <input
                          type="text"
                          value={entry.company}
                          onChange={(e) => updateEmployment(entry.id, { company: e.target.value })}
                          placeholder="e.g. Acme Co."
                          className={INPUT_CLS}
                        />
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label="Dates">
                        <input
                          type="text"
                          value={entry.dates}
                          onChange={(e) => updateEmployment(entry.id, { dates: e.target.value })}
                          placeholder="e.g. Jan 2021 — Present"
                          className={INPUT_CLS}
                        />
                      </Field>
                    </div>
                    <div className="mt-3">
                      <Field label="Description">
                        <textarea
                          rows={2}
                          value={entry.description}
                          onChange={(e) => updateEmployment(entry.id, { description: e.target.value })}
                          placeholder="What they owned, shipped, and the impact."
                          className={TEXTAREA_CLS}
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addEmploymentEntry}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#7E47FF]/30 bg-[#7E47FF]/5 px-3 py-2.5 text-xs font-semibold text-[#7E47FF] transition-colors hover:bg-[#7E47FF]/10"
            >
              <Plus className="size-3.5" strokeWidth={2} />
              Add Employment Entry
            </button>
          </Section>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-100 bg-white px-6 py-4">
          <button
            type="button"
            onClick={attemptClose}
            disabled={submitting}
            className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 rounded-xl bg-[#49D7A7] px-5 py-2.5 text-sm font-semibold text-[#1a4f3a] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <UserCheck className="size-4" strokeWidth={2.5} />
            {submitting ? "Moving…" : "Move to Talent"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
        {title}
      </p>
      {children}
    </section>
  );
}
