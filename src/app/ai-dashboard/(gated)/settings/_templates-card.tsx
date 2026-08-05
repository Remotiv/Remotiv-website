"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BellOff, Check, Plus, X } from "lucide-react";
import { PLACEHOLDER_KEYS } from "@/lib/email/candidate/render";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import {
  createManualTemplate,
  previewTemplate,
  revertTemplate,
  saveTemplate,
} from "./template-actions";
import { PREVIEW_SAMPLE, type TemplateRow } from "./template-types";

const CARD_CLS =
  "mb-4 overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)] last:mb-0";
const FIELD_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors hover:border-[var(--ai-t4)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const FIELD_ERR_CLS =
  "border-[#E0524B] ring-[3px] ring-[#E0524B]/[0.14] focus:border-[#E0524B]";
const LABEL_CLS =
  "mb-[7px] block text-[11.5px] font-bold tracking-[0.01em] text-[var(--ai-t2)]";

export function TemplatesCard({
  rows: initialRows,
  role,
  onToast,
}: {
  rows: TemplateRow[];
  role: CompanyRole;
  onToast: (message: string) => void;
}) {
  const canEdit = role === "owner" || role === "admin";
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleNew() {
    setCreating(true);
    const result = await createManualTemplate();
    setCreating(false);
    if (!result.success) {
      onToast(result.error);
      return;
    }
    // The row is written server-side; refresh brings it back with its key so
    // the editor opens on the real record rather than an optimistic stand-in.
    onToast("New template created — give it a subject and a message");
    router.refresh();
  }

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  const groups = useMemo(
    () =>
      [
        { key: "automatic" as const, label: "Automatic" },
        { key: "manual" as const, label: "Written by you" },
      ].map((g) => ({ ...g, items: rows.filter((r) => r.group === g.key) })),
    [rows],
  );

  const open = rows.find((r) => r.key === openKey) ?? null;

  return (
    <section className={CARD_CLS}>
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <div>
          <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
            Email templates
          </h2>
          <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
            What candidates receive. Edit any of these or keep Remotiv&apos;s wording.
          </p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-purple-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-purple-ink)]">
          Owners &amp; admins
        </span>
      </div>

      <div className="mt-[18px]">
        {groups.map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.key}>
              <div className="border-y border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-[9px] text-[10px] font-extrabold uppercase tracking-[0.13em] text-[var(--ai-t3)]">
                {g.label}
              </div>
              {g.items.map((t) => {
                // Read-only roles get no Edit affordance at all, not a
                // disabled one — the mock left every row clickable.
                const interactive = canEdit && t.editable;
                const Row = interactive ? "button" : "div";
                return (
                  <Row
                    key={t.key}
                    {...(interactive
                      ? { type: "button" as const, onClick: () => setOpenKey(t.key) }
                      : {})}
                    className={`group relative flex w-full items-center gap-3.5 border-b border-[var(--ai-line-soft)] bg-[var(--ai-surface)] px-6 py-[13px] text-left last:border-b-0 ${
                      interactive ? "cursor-pointer hover:bg-[#FCFBFA]" : ""
                    } ${t.sending ? "" : "opacity-[0.55]"}`}
                  >
                    {interactive && (
                      <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple opacity-0 transition-opacity group-hover:opacity-100" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
                        {t.name}
                      </span>
                      <span
                        className={`mt-[3px] block text-xs leading-snug ${t.sending ? "text-[var(--ai-t3)]" : "font-semibold text-[var(--ai-t4)]"}`}
                      >
                        {t.sending ? t.trigger : "Not sending — turned off"}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold ${
                        t.customised
                          ? "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]"
                          : "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]"
                      }`}
                    >
                      {t.customised ? "Customised" : "Remotiv default"}
                    </span>
                    {interactive && (
                      <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] font-bold text-remotiv-purple">
                        Edit
                        <ArrowRight
                          className="size-3.5 transition-transform group-hover:translate-x-[3px]"
                          strokeWidth={2.2}
                        />
                      </span>
                    )}
                  </Row>
                );
              })}
            </div>
          ),
        )}
      </div>

      {canEdit ? (
        <div className="border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-3.5">
          {/* Composer templates only — the automatic set is the product's
              lifecycle, not something a company extends. */}
          <button
            type="button"
            onClick={() => {
              void handleNew();
            }}
            disabled={creating}
            className="inline-flex items-center gap-2 rounded-xl border-[1.5px] border-dashed border-[var(--ai-line-strong)] bg-transparent px-4 py-2.5 text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-solid hover:border-remotiv-purple hover:bg-[var(--ai-purple-tint)] hover:text-remotiv-purple disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="size-[15px]" strokeWidth={2.4} />
            {creating ? "Creating…" : "New template"}
          </button>
        </div>
      ) : (
        <p className="m-0 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-3.5 text-xs leading-snug text-[var(--ai-t3)]">
          Only owners and admins can change what candidates receive.
        </p>
      )}

      {open && (
        <TemplateEditor
          template={open}
          onClose={() => setOpenKey(null)}
          onSaved={(next) => {
            setRows((prev) => prev.map((r) => (r.key === next.key ? next : r)));
            setOpenKey(null);
          }}
          onRemoved={(key) => {
            setRows((prev) => prev.filter((r) => r.key !== key));
            setOpenKey(null);
          }}
          onToast={onToast}
        />
      )}
    </section>
  );
}

function TemplateEditor({
  template,
  onClose,
  onSaved,
  onRemoved,
  onToast,
}: {
  template: TemplateRow;
  onClose: () => void;
  onSaved: (next: TemplateRow) => void;
  onRemoved: (key: string) => void;
  onToast: (message: string) => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The preview, rendered SERVER-side through the same renderCopy the sender
   * uses. Debounced rather than per-keystroke: it is a round trip, and the
   * point is fidelity, not immediacy.
   */
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(
    null,
  );
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  /** Which field a placeholder chip inserts into. */
  const [lastFocus, setLastFocus] = useState<"subject" | "body">("body");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => subjectRef.current?.focus(), 60);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      window.clearTimeout(t);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      previewTemplate({ subject, body })
        .then((next) => {
          if (!cancelled) setPreview(next);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [subject, body]);

  const isDefault =
    subject === template.defaultSubject && body === template.defaultBody;

  /** Insert at the caret of whichever field was last focused, then restore it. */
  function insertToken(token: string) {
    const el = lastFocus === "subject" ? subjectRef.current : bodyRef.current;
    if (!el) return;
    const value = lastFocus === "subject" ? subject : body;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
    if (lastFocus === "subject") setSubject(next);
    else setBody(next);
    setError(null);
    window.requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function handleSave() {
    setBusy(true);
    let result: Awaited<ReturnType<typeof saveTemplate>>;
    try {
      result = await saveTemplate({ event: template.key, subject, body });
    } catch {
      result = { success: false, error: "Couldn't save — please try again." };
    }
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    const customised = template.ownAuthored ? true : !isDefault;
    onSaved({
      ...template,
      name: template.ownAuthored ? subject.slice(0, 60) || template.name : template.name,
      subject,
      body,
      customised,
    });
    onToast(
      !template.ownAuthored && isDefault
        ? `“${template.name}” restored to Remotiv default`
        : `“${template.name}” saved`,
    );
  }

  async function handleRevert() {
    setBusy(true);
    let result: Awaited<ReturnType<typeof revertTemplate>>;
    try {
      result = await revertTemplate(template.key);
    } catch {
      result = { success: false, error: "Couldn't revert — please try again." };
    }
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    if (template.ownAuthored) {
      onRemoved(template.key);
      onToast(`“${template.name}” deleted`);
      return;
    }
    onSaved({
      ...template,
      subject: template.defaultSubject,
      body: template.defaultBody,
      customised: false,
    });
    onToast(`“${template.name}” restored to Remotiv default`);
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(20,16,32,0.5)] p-6 backdrop-blur-[5px]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={template.name}
        className="relative flex max-h-[calc(var(--vh-full)*0.88)] w-full max-w-[600px] flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)]"
      >
        <div className="relative overflow-hidden bg-[var(--ai-sidebar)] px-[26px] py-[22px]">
          <span className="pointer-events-none absolute -right-[70px] -top-[90px] size-[250px] rounded-full bg-[radial-gradient(circle,rgba(126,71,255,0.55),transparent_68%)]" />
          <div className="relative z-[1] flex items-start justify-between gap-3.5">
            <div className="min-w-0">
              <p className="m-0 mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
                {template.group === "automatic" ? "Automatic email" : "Composer template"}
              </p>
              <p className="m-0 font-heading text-xl font-extrabold leading-tight tracking-[-0.028em] text-white">
                {template.name}
              </p>
              <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-white/50">
                {template.sending ? template.trigger : "Not sending — turned off"}
              </p>
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
          {!template.sending && (
            <div className="mb-[17px] flex items-start gap-3 rounded-[13px] border border-[rgba(224,160,32,0.28)] bg-[var(--ai-amber-tint)] px-[15px] py-3.5">
              <BellOff
                className="mt-px size-4 shrink-0 text-[var(--ai-amber-ink)]"
                strokeWidth={2}
              />
              <p className="m-0 text-[12.5px] leading-normal text-[var(--ai-amber-ink)]">
                <b className="font-bold">This event is turned off.</b> You can edit the
                wording now, but nothing sends until the event is switched back on.
              </p>
            </div>
          )}

          <div className="mb-4">
            <label className={LABEL_CLS} htmlFor="tpl-subject">
              Subject <span className="text-remotiv-purple">*</span>
            </label>
            <input
              id="tpl-subject"
              ref={subjectRef}
              value={subject}
              onFocus={() => setLastFocus("subject")}
              onChange={(e) => {
                setSubject(e.target.value);
                setError(null);
              }}
              className={`${FIELD_CLS} ${error ? FIELD_ERR_CLS : ""}`}
            />
          </div>

          <div>
            <label className={LABEL_CLS} htmlFor="tpl-body">
              Message <span className="text-remotiv-purple">*</span>
            </label>
            <textarea
              id="tpl-body"
              ref={bodyRef}
              value={body}
              onFocus={() => setLastFocus("body")}
              onChange={(e) => {
                setBody(e.target.value);
                setError(null);
              }}
              className={`${FIELD_CLS} min-h-[172px] resize-y leading-relaxed ${error ? FIELD_ERR_CLS : ""}`}
            />
          </div>

          <div className="mt-[13px] rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
            <p className="m-0 mb-2 text-[11.5px] font-semibold text-[var(--ai-t3)]">
              Available placeholders — click to insert
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDER_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => insertToken(`{{${k}}}`)}
                  className="rounded-lg border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-2.5 py-1 font-mono text-[11px] font-semibold text-[var(--ai-purple-ink)] transition-colors hover:border-remotiv-purple hover:bg-remotiv-purple hover:text-white"
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-[13px] rounded-[14px] border border-[var(--ai-line)] px-[17px] py-[15px]">
            <p className="m-0 mb-2.5 flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t3)] after:h-px after:flex-1 after:bg-[var(--ai-line)] after:content-['']">
              Preview
            </p>
            <p className="m-0 mb-2 text-[13.5px] font-bold leading-snug tracking-[-0.01em] text-[var(--ai-t1)]">
              {preview ? preview.subject || "(no subject)" : "…"}
            </p>
            <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-[1.65] text-[var(--ai-t2)]">
              {preview ? preview.body || "(empty message)" : "…"}
            </p>
            <p className="m-0 mt-[11px] border-t border-dashed border-[var(--ai-line)] pt-2.5 text-[11.5px] leading-snug text-[var(--ai-t4)]">
              This is what we send, rendered by the sender itself — sample candidate
              Fatima Khan, Senior Frontend Engineer.
            </p>
          </div>

          {error && (
            <p className="m-0 mt-4 rounded-xl bg-[var(--ai-danger-tint)] px-3.5 py-3 text-[13px] font-semibold leading-snug text-[var(--ai-danger)]">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-[26px] py-3.5">
          {/* A company-authored template has no default behind it, so there is
              nothing to revert TO — the same delete becomes "Delete template". */}
          <button
            type="button"
            onClick={() => {
              void handleRevert();
            }}
            disabled={(!template.customised && !template.ownAuthored) || busy}
            className={`border-none bg-transparent p-0 text-left text-[12.5px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              template.ownAuthored
                ? "text-[var(--ai-danger)] hover:opacity-80"
                : "text-[var(--ai-t3)] hover:text-remotiv-purple disabled:hover:text-[var(--ai-t3)]"
            }`}
          >
            {template.ownAuthored ? "Delete template" : "Revert to Remotiv default"}
          </button>
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
                void handleSave();
              }}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-[11px] border border-remotiv-purple bg-remotiv-purple px-[18px] py-2.5 text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)] disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:shadow-none"
            >
              <Check className="size-[15px]" strokeWidth={2.4} />
              {busy ? "Saving…" : "Save template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
