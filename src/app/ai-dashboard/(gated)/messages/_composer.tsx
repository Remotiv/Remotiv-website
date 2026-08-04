"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Link2, Save, Send, X } from "lucide-react";
import { sendManualMessage } from "./actions";
import {
  BODY_MAX,
  SUBJECT_MAX,
  type ManualTemplate,
  type MessageRecipient,
} from "./types";

/**
 * The composer.
 *
 * One component, mounted by both the Messages page and the applicants drawer,
 * so the identity block and the validation rules cannot drift between the two
 * places a recruiter can start an email.
 */

const AVATAR_TINTS: ReadonlyArray<[string, string]> = [
  ["var(--ai-purple-tint)", "var(--ai-purple-ink)"],
  ["var(--ai-mint-tint)", "var(--ai-mint-ink)"],
  ["var(--ai-sky-tint)", "var(--ai-sky-ink)"],
  ["var(--ai-peach-tint)", "var(--ai-peach-ink)"],
  ["var(--ai-amber-tint)", "var(--ai-amber-ink)"],
  ["var(--ai-slate-tint)", "var(--ai-slate-ink)"],
];

/** Stable per record, never by array position — a re-sort must not recolour. */
export function tintFor(id: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

const FIELD_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors hover:border-[var(--ai-t4)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const FIELD_ERR_CLS =
  "border-[#E0524B] ring-[3px] ring-[#E0524B]/[0.14] focus:border-[#E0524B]";
const LABEL_CLS =
  "mb-[7px] block text-[11.5px] font-bold tracking-[0.01em] text-[var(--ai-t2)]";
const ERR_CLS = "mt-1.5 text-xs font-semibold text-[#C4362F]";

/** Client-side preview of the same substitution the server performs. */
function fillPlaceholders(
  text: string,
  recipient: MessageRecipient | null,
  companyName: string,
): string {
  if (!recipient) return text;
  const first = recipient.name.trim().split(/\s+/)[0] ?? "";
  return text
    .replace(/\{\{\s*candidate_first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*candidate_name\s*\}\}/gi, recipient.name)
    .replace(/\{\{\s*job_title\s*\}\}/gi, recipient.jobTitle)
    .replace(/\{\{\s*company_name\s*\}\}/gi, companyName);
}

export function Composer({
  open,
  onClose,
  companyName,
  replyToAddress,
  recipients,
  templates,
  presetApplicationId,
  isFollowUp,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  companyName: string;
  /** null → the company takes no replies, and the modal says so. */
  replyToAddress: string | null;
  recipients: MessageRecipient[];
  templates: ManualTemplate[];
  /** Pre-selects the recipient when opened from a row or the drawer. */
  presetApplicationId?: string | null;
  isFollowUp?: boolean;
  onSent: (info: { applicationId: string; subject: string; body: string }) => void;
}) {
  const [to, setTo] = useState("");
  const [templateId, setTemplateId] = useState("scratch");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toRef = useRef<HTMLSelectElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  // Reset on every open so a previous draft never leaks into a new message.
  useEffect(() => {
    if (!open) return;
    setTo(presetApplicationId ?? "");
    setTemplateId("scratch");
    setSubject("");
    setBody("");
    setErrors({});
    setBusy(false);
    const t = window.setTimeout(() => {
      if (presetApplicationId) subjectRef.current?.focus();
      else toRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [open, presetApplicationId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const recipient = useMemo(
    () => recipients.find((r) => r.applicationId === to) ?? null,
    [recipients, to],
  );

  /** Re-resolve an active template against a newly chosen candidate. */
  function applyTemplate(id: string, forRecipient: MessageRecipient | null) {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setSubject(fillPlaceholders(tpl.subject, forRecipient, companyName));
    setBody(fillPlaceholders(tpl.body, forRecipient, companyName));
  }

  function handleRecipient(next: string) {
    setTo(next);
    setErrors((prev) => ({ ...prev, to: "" }));
    if (templateId !== "scratch") {
      applyTemplate(
        templateId,
        recipients.find((r) => r.applicationId === next) ?? null,
      );
    }
  }

  async function handleSend() {
    if (!to) {
      setErrors({ to: "Choose who this email goes to." });
      toRef.current?.focus();
      return;
    }
    if (!subject.trim()) {
      setErrors({ subject: "Add a subject line." });
      subjectRef.current?.focus();
      return;
    }
    if (!body.trim()) {
      setErrors({ body: "Write a message before sending." });
      return;
    }

    setBusy(true);
    let result: Awaited<ReturnType<typeof sendManualMessage>>;
    try {
      result = await sendManualMessage({
        applicationId: to,
        subject: subject.trim(),
        body: body.trim(),
      });
    } catch {
      result = { success: false, error: "Couldn't send — please try again." };
    }
    setBusy(false);

    if (!result.success) {
      // Shown against the send button rather than as a toast: at the cap or on
      // a provider failure the recruiter has to decide what to do next, and a
      // message that fades after three seconds is not a decision point.
      setErrors({ send: result.error });
      return;
    }

    onSent({ applicationId: to, subject: subject.trim(), body: body.trim() });
    onClose();
  }

  if (!open) return null;

  const heroName = recipient?.name ?? "Choose an applicant";
  const heroEmail = recipient?.email ?? "Pick who this email goes to";
  const heroJob = recipient?.jobTitle ?? "Any role";
  const tint = recipient ? tintFor(recipient.applicationId) : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.5)] p-6 backdrop-blur-[5px]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="New message"
        className="relative flex max-h-[calc(var(--vh-full)*0.88)] w-full max-w-[580px] flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)]"
      >
        <div className="relative overflow-hidden bg-[var(--ai-sidebar)] px-[26px] py-[22px]">
          <span className="pointer-events-none absolute -right-[70px] -top-[90px] size-[250px] rounded-full bg-[radial-gradient(circle,rgba(126,71,255,0.55),transparent_68%)]" />
          <div className="relative z-[1] flex items-start justify-between gap-3.5">
            <div className="min-w-0">
              <p className="m-0 mb-[7px] text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
                {isFollowUp ? "Follow-up message" : "New message"}
              </p>
              <div className="flex min-w-0 items-center gap-[13px]">
                <span
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-bold shadow-[0_0_0_2px_var(--ai-sidebar),0_0_0_3.5px_rgba(255,255,255,0.2)]"
                  style={
                    tint
                      ? { background: tint[0], color: tint[1] }
                      : { background: "rgba(255,255,255,0.12)", color: "#fff" }
                  }
                >
                  {recipient ? initialsOf(recipient.name) : "+"}
                </span>
                <div className="min-w-0">
                  <p className="m-0 truncate font-heading text-[19px] font-extrabold leading-tight tracking-[-0.028em] text-white">
                    {heroName}
                  </p>
                  <p className="m-0 mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-white/50">
                    <span className="truncate">{heroEmail}</span>
                    <span className="size-[3px] shrink-0 rounded-full bg-white/30" />
                    <span className="truncate">{heroJob}</span>
                  </p>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.16] bg-white/[0.07] text-white/75 transition-colors hover:bg-white/[0.16] hover:text-white"
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-[26px] pb-6 pt-5">
          {/* The identity block. Above every input on purpose: the recruiter is
              not sending from their own address, and finding that out after
              writing the message is finding out too late. */}
          <div className="mb-[18px] rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-4 py-3.5">
            <div className="flex items-center gap-[11px] text-[13px] leading-relaxed text-[var(--ai-t3)]">
              <Send className="size-[15px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
              <span className="flex min-w-0 flex-wrap items-center gap-[7px]">
                The candidate sees this from
                <span className="inline-flex shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] py-[3px] pl-1 pr-[11px] text-[12.5px] font-bold text-[var(--ai-t1)]">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-remotiv-purple text-[9.5px] font-extrabold text-white">
                    {companyName.trim()[0]?.toUpperCase() ?? "R"}
                  </span>
                  {companyName}
                  {companyName.trim().toLowerCase() !== "remotiv" && (
                    <span className="font-medium text-[var(--ai-t3)]">(via Remotiv)</span>
                  )}
                </span>
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-[11px] border-t border-[var(--ai-line-soft)] pt-2.5 text-[13px] leading-relaxed text-[var(--ai-t3)]">
              <Link2 className="size-[15px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
              {replyToAddress ? (
                <span>
                  Replies go to{" "}
                  <b className="font-bold text-[var(--ai-t1)]">{replyToAddress}</b> — not to
                  your personal inbox.
                </span>
              ) : (
                <span>
                  Nobody receives replies to this — set a reply-to address in{" "}
                  <b className="font-bold text-[var(--ai-t1)]">Settings</b> if candidates
                  should be able to answer.
                </span>
              )}
            </div>
          </div>

          <div className="mb-4">
            <label className={LABEL_CLS} htmlFor="cp-to">
              To <span className="text-remotiv-purple">*</span>
            </label>
            <select
              id="cp-to"
              ref={toRef}
              value={to}
              onChange={(e) => handleRecipient(e.target.value)}
              className={`${FIELD_CLS} cursor-pointer appearance-none ${errors.to ? FIELD_ERR_CLS : ""}`}
            >
              <option value="">Choose an applicant…</option>
              {recipients.map((r) => (
                <option key={r.applicationId} value={r.applicationId}>
                  {r.name} — {r.jobTitle}
                </option>
              ))}
            </select>
            {errors.to && <p className={ERR_CLS}>{errors.to}</p>}
          </div>

          <div className="mb-4">
            <label className={LABEL_CLS} htmlFor="cp-template">
              Start from a template
            </label>
            <select
              id="cp-template"
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                if (e.target.value !== "scratch") applyTemplate(e.target.value, recipient);
                setErrors({});
              }}
              className={`${FIELD_CLS} cursor-pointer appearance-none`}
            >
              <option value="scratch">Write from scratch</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {templates.length === 0 && (
              <p className="mt-[7px] text-xs leading-snug text-[var(--ai-t3)]">
                No saved templates yet — write from scratch.
              </p>
            )}
          </div>

          <div className="mb-4">
            <label className={LABEL_CLS} htmlFor="cp-subject">
              Subject <span className="text-remotiv-purple">*</span>
            </label>
            <input
              id="cp-subject"
              ref={subjectRef}
              value={subject}
              maxLength={SUBJECT_MAX}
              placeholder="What is this email about?"
              onChange={(e) => {
                setSubject(e.target.value);
                setErrors((prev) => ({ ...prev, subject: "" }));
              }}
              className={`${FIELD_CLS} ${errors.subject ? FIELD_ERR_CLS : ""}`}
            />
            {errors.subject && <p className={ERR_CLS}>{errors.subject}</p>}
          </div>

          <div>
            <label className={LABEL_CLS} htmlFor="cp-body">
              Message <span className="text-remotiv-purple">*</span>
            </label>
            <textarea
              id="cp-body"
              value={body}
              maxLength={BODY_MAX}
              placeholder="Write your message…"
              onChange={(e) => {
                setBody(e.target.value);
                setErrors((prev) => ({ ...prev, body: "" }));
              }}
              className={`${FIELD_CLS} min-h-[168px] resize-y leading-relaxed ${errors.body ? FIELD_ERR_CLS : ""}`}
            />
            {errors.body && <p className={ERR_CLS}>{errors.body}</p>}
            <p className="mt-[7px] text-xs leading-snug text-[var(--ai-t3)]">
              Placeholders like{" "}
              <code className="rounded-[5px] bg-[var(--ai-purple-tint)] px-1.5 py-px font-mono text-[11.5px] font-semibold text-[var(--ai-purple-ink)]">
                {"{{candidate_first_name}}"}
              </code>{" "}
              and{" "}
              <code className="rounded-[5px] bg-[var(--ai-purple-tint)] px-1.5 py-px font-mono text-[11.5px] font-semibold text-[var(--ai-purple-ink)]">
                {"{{job_title}}"}
              </code>{" "}
              are filled in automatically.
            </p>
          </div>

          {errors.send && (
            <p className="mt-4 rounded-xl bg-[var(--ai-danger-tint)] px-3.5 py-3 text-[13px] font-semibold leading-snug text-[var(--ai-danger)]">
              {errors.send}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-[26px] py-3.5">
          <span className="flex items-center gap-2 text-xs leading-snug text-[var(--ai-t3)]">
            <Save className="size-3.5 shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
            Saved to this applicant&apos;s history
          </span>
          <div className="flex shrink-0 gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[17px] py-2.5 text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSend();
              }}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-[11px] border border-remotiv-purple bg-remotiv-purple px-[18px] py-2.5 text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)] disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:shadow-none"
            >
              <Send className="size-[15px]" strokeWidth={2} />
              {busy ? "Sending…" : "Send email"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
