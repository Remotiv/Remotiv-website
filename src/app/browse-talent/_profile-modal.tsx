"use client";

// Phase 4 Bundle C: extracted verbatim from _browse-client.tsx so the modal's
// ~400 LOC + JSX is code-split. Loaded via next/dynamic only when the user
// opens a candidate card. Behaviour is identical to the previous inline
// component — same focus trap, same hooks, same JSX, same handler contract.

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LazyPhoto } from "@/components/lazy-photo";
import {
  BtMatchBadge,
  ROLE_CFG,
  ensureHttpUrl,
  type Card,
  type EffectiveContact,
} from "./_browse-client";
import type { ProfileDetail } from "./actions";

export type ProfileModalProps = {
  c: Card;
  saved: boolean;
  tier?: "free" | "subscriber";
  isUnlocked: boolean;
  canUnlock: boolean;
  onUnlock: () => void;
  effectiveContact: EffectiveContact;
  onSave: () => void;
  onClose: () => void;
  onLocked: () => void;
  onViewCv: () => void;
  isUnlocking?: boolean;
  isSaving?: boolean;
  isViewingCv?: boolean;
  // Phase 4 Lean Projection: arrives from fetchProfileDetail once the modal
  // opens. While `detail` is null and `isLoadingDetail` is true, the modal
  // shows skeleton placeholders for the detail-only sections.
  detail?: ProfileDetail | null;
  isLoadingDetail?: boolean;
};

// Phase 4 Lean Projection skeletons. Pure CSS via Tailwind animate-pulse;
// no new dependency, no CSS-file edit. aria-hidden because content is
// transient and screen-reader-friendly text appears once data arrives.
function SummarySkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="h-4 w-3/4 animate-pulse rounded bg-gray-200" />
      <div className="h-4 w-full animate-pulse rounded bg-gray-200" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-gray-200" />
    </div>
  );
}

function ExperienceSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-1/2 animate-pulse rounded bg-gray-200" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-gray-200" />
          <div className="h-3 w-1/4 animate-pulse rounded bg-gray-200" />
        </div>
      ))}
    </div>
  );
}

export default function ProfileModal({
  c,
  saved,
  tier = "free",
  isUnlocked,
  canUnlock,
  onUnlock,
  effectiveContact,
  onSave,
  onClose,
  onLocked,
  onViewCv,
  isUnlocking = false,
  isSaving = false,
  isViewingCv = false,
  detail = null,
  isLoadingDetail = false,
}: ProfileModalProps) {
  const cfg = ROLE_CFG[c.type];
  const [photoErrored, setPhotoErrored] = useState(false);
  const showPhoto = Boolean(c.photoUrl) && !photoErrored;

  // Phase 4 Lean Projection: degree, institution, experience now live on
  // `detail` (loaded lazily from fetchProfileDetail). `c.education` is the
  // legacy demo-data composite string ("Degree — Institution") — still
  // honoured for static preview/blurred cards that don't go through the
  // server fetch.
  let degree = "";
  let school = "";
  if (c.education) {
    const [d, s] = c.education.split("—");
    degree = d?.trim() ?? "";
    school = s?.trim() ?? "";
  } else {
    degree = detail?.degree ?? "";
    school = detail?.institution ?? "";
  }
  const hasEducation = Boolean(degree || school);
  const eduInline =
    c.education ?? [detail?.degree, detail?.institution].filter(Boolean).join(" — ");
  const detailExperience = detail?.experience ?? [];
  const hasExperienceArray = detailExperience.length > 0;
  // Summary: list payload still ships c.bio (= row.summary, list-redacted).
  // detail.summary is a freshly-redacted copy from fetchProfileDetail and is
  // preferred when present (more recent unlock state may apply).
  const summaryText = detail?.summary ?? c.bio ?? "";
  const hasSummary = !!summaryText;

  // Focus trap — keep Tab focus within the modal panel
  useEffect(() => {
    const modalEl = document.querySelector(
      '[role="dialog"][aria-labelledby="profile-modal-title"]',
    ) as HTMLElement | null;
    if (!modalEl) return;

    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(modalEl.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Focus the close button on open; restore focus to the triggering element on close.
  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null;

    const timer = setTimeout(() => {
      const closeButton = document.querySelector(
        '[role="dialog"][aria-labelledby="profile-modal-title"] [aria-label="Close profile"]',
      ) as HTMLElement | null;
      closeButton?.focus();
    }, 50);

    return () => {
      clearTimeout(timer);
      previousActiveElement?.focus?.();
    };
  }, []);

  return (
    <div
      className="bt-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div
        className="bt-modal-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-modal-title"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close profile"
          className="bt-modal-close-btn"
        >
          <X size={16} color="#666" />
        </button>
        <div className="bt-modal-scroll">
        {/* Phase 6 A1: "Admin Preview" banner removed — it was rendered for
            ALL subscribers (the condition was tier === "subscriber"), not just
            admins, so paying users were seeing "Admin Preview" on every modal
            open. If a true admin-only banner is ever wanted, thread isAdmin
            explicitly as a prop. */}
        <div className="bt-modal-header">
          <div>
            {showPhoto && c.photoUrl ? (
              <LazyPhoto
                src={c.photoUrl}
                alt={c.name}
                size={52}
                rounded="2xl"
                className="bt-modal-avatar-photo"
                onError={() => setPhotoErrored(true)}
              />
            ) : (
              <div
                className="bt-modal-avatar"
                style={{ background: cfg.bg, borderColor: cfg.b, color: cfg.c }}
              >
                {c.initials}
              </div>
            )}
          </div>
          <div className="bt-modal-meta">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <h2 id="profile-modal-title" className="bt-modal-name">{c.name}</h2>
              <BtMatchBadge score={c.score} />
            </div>
            <div className="bt-modal-role">{c.role}</div>
            <div className="bt-modal-info">
              <span aria-hidden="true">📍</span> {c.location} · {c.exp} experience{eduInline ? ` · ${eduInline}` : ""}
            </div>
            <div className="bt-profile-links">
              {c.github && (
                isUnlocked ? (
                  (() => {
                    const url = ensureHttpUrl(effectiveContact.github ?? c.github);
                    return url ? (
                      <a
                        className="bt-plink"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        GitHub
                      </a>
                    ) : (
                      <span className="bt-plink text-gray-400">GitHub unavailable</span>
                    );
                  })()
                ) : canUnlock ? (
                  <button type="button" className="bt-plink" onClick={onUnlock} title="Use 1 credit to unlock all contact details">
                    GitHub · 1 credit
                  </button>
                ) : (
                  <button type="button" className="bt-plink" onClick={onLocked}>GitHub</button>
                )
              )}
              {isUnlocked && effectiveContact.linkedin ? (
                (() => {
                  const url = ensureHttpUrl(effectiveContact.linkedin);
                  return url ? (
                    <a
                      className="bt-plink"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      LinkedIn
                    </a>
                  ) : (
                    <span className="bt-plink text-gray-400">LinkedIn unavailable</span>
                  );
                })()
              ) : canUnlock ? (
                <button type="button" className="bt-plink" onClick={onUnlock} title="Use 1 credit to unlock all contact details">
                  LinkedIn · 1 credit
                </button>
              ) : (
                <button type="button" className="bt-plink" onClick={onLocked}>LinkedIn</button>
              )}
              {isUnlocked && effectiveContact.cvUrl ? (
                <button
                  type="button"
                  className="bt-plink"
                  onClick={onViewCv}
                  disabled={isViewingCv}
                  style={{ minWidth: 100 }}
                >
                  {isViewingCv ? <Loader2 className="h-4 w-4 animate-spin" /> : "Resume ✦"}
                </button>
              ) : canUnlock ? (
                <button
                  type="button"
                  className="bt-plink"
                  onClick={onUnlock}
                  title="Use 1 credit to unlock all contact details"
                  disabled={isUnlocking}
                  style={{ minWidth: 120 }}
                >
                  {isUnlocking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Resume · 1 credit"}
                </button>
              ) : (
                <button type="button" className="bt-plink" onClick={onLocked}>Resume ✦</button>
              )}
            </div>
          </div>
        </div>

        <div className="bt-modal-body">
          {/* Phase 4 Lean Projection: summary normally renders from c.bio
              (still in list payload). detail.summary, when present, is
              preferred — it's a freshly-redacted server copy. The skeleton
              path only triggers when neither has resolved yet (rare; only
              if a future change removes summary from the list query). */}
          {hasSummary ? (
            <>
              <h3 className="bt-modal-sec-title">Summary</h3>
              <p
                style={{
                  margin: "0 0 20px",
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: "0.85rem",
                  color: "#555",
                  lineHeight: 1.7,
                  whiteSpace: "pre-line",
                }}
              >
                {summaryText}
              </p>
            </>
          ) : isLoadingDetail ? (
            <>
              <h3 className="bt-modal-sec-title">Summary</h3>
              <div style={{ marginBottom: 20 }}>
                <SummarySkeleton />
              </div>
            </>
          ) : null}

          <h3 className="bt-modal-sec-title">Experience</h3>
          <div style={{ marginBottom: 20 }}>
            {isLoadingDetail && !hasExperienceArray ? (
              <ExperienceSkeleton />
            ) : hasExperienceArray ? (
              detailExperience.map((exp, i) => (
                <div key={`${exp.company}-${i}`} className="bt-exp-item">
                  <div className="bt-exp-logo">🏢</div>
                  <div style={{ flex: 1 }}>
                    <div className="bt-exp-title">{exp.title}</div>
                    <div className="bt-exp-company">{exp.company}</div>
                    <div className="bt-exp-dates">{exp.dates}</div>
                    <div className="bt-exp-skills">
                      {(exp.skills ?? []).map((s, j) => (
                        <span key={`${s}-${j}`} className="bt-exp-skill">{s}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p
                style={{
                  margin: 0,
                  padding: "16px 18px",
                  border: "1px dashed rgba(0,0,0,0.1)",
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: "0.82rem",
                  color: "#aaa",
                  textAlign: "center",
                }}
              >
                No work experience added
              </p>
            )}
          </div>

          {hasEducation && (
            <>
              <h3 className="bt-modal-sec-title">Education</h3>
              <div style={{ marginBottom: 20 }}>
                <div className="bt-edu-row">
                  {degree && <div className="bt-edu-degree">{degree}</div>}
                  {school && <div className="bt-edu-school">{school}</div>}
                </div>
              </div>
            </>
          )}

          <h3 className="bt-modal-sec-title">Skills</h3>
          <div className="bt-modal-skills">
            {c.skills.map((s) => (
              <span key={s} className="bt-modal-skill">{s}</span>
            ))}
          </div>

          <h3 className="bt-modal-sec-title">Open To</h3>
          <div className="bt-open-to" style={{ marginBottom: 20 }}>
            {c.fullTime && (
              <span className="bt-ot-tag" style={{ color: "#49D7A7", borderColor: "rgba(73,215,167,.3)", background: "rgba(73,215,167,.08)" }}>
                Full-time
              </span>
            )}
            {c.partTime && (
              <span className="bt-ot-tag" style={{ color: "#34d399", borderColor: "rgba(52,211,153,.3)", background: "rgba(52,211,153,.07)" }}>
                Part-time
              </span>
            )}
            {c.contract && (
              <span className="bt-ot-tag" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,.3)", background: "rgba(167,139,250,.07)" }}>
                Contract
              </span>
            )}
            {c.remote && (
              <span className="bt-ot-tag" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,.3)", background: "rgba(167,139,250,.07)" }}>
                Remote
              </span>
            )}
            {c.hybrid && (
              <span className="bt-ot-tag" style={{ color: "#fb923c", borderColor: "rgba(251,146,60,.3)", background: "rgba(251,146,60,.07)" }}>
                Hybrid
              </span>
            )}
            {c.onsite && (
              <span className="bt-ot-tag" style={{ color: "#60a5fa", borderColor: "rgba(96,165,250,.3)", background: "rgba(96,165,250,.07)" }}>
                Onsite
              </span>
            )}
          </div>

          {isUnlocked ? (
            <div className="bt-unlocked-box">
              <div className="bt-unlocked-head">
                <span aria-hidden>🔓</span>
                <div>
                  <div className="bt-unlocked-title">Contact Details</div>
                  <div className="bt-unlocked-sub">Contact details unlocked</div>
                </div>
              </div>
              <div className="bt-unlocked-rows">
                {effectiveContact.email && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">Email</span>
                    <a href={`mailto:${effectiveContact.email}`} className="bt-unlocked-link">{effectiveContact.email}</a>
                  </div>
                )}
                {effectiveContact.phone && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">Phone</span>
                    <a href={`tel:${effectiveContact.phone}`} className="bt-unlocked-link">{effectiveContact.phone}</a>
                  </div>
                )}
                {effectiveContact.linkedin && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">LinkedIn</span>
                    {(() => {
                      const url = ensureHttpUrl(effectiveContact.linkedin);
                      return url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="bt-unlocked-link"
                        >
                          {effectiveContact.linkedin}
                        </a>
                      ) : (
                        <span className="bt-unlocked-link text-gray-400">LinkedIn unavailable</span>
                      );
                    })()}
                  </div>
                )}
                {effectiveContact.cvUrl && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">CV</span>
                    <button
                      type="button"
                      onClick={onViewCv}
                      className="bt-unlocked-link"
                      disabled={isViewingCv}
                      style={{ minWidth: 88 }}
                    >
                      {isViewingCv ? <Loader2 className="h-4 w-4 animate-spin" /> : "View CV"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bt-locked-box">
              <div className="bt-locked-icon" aria-hidden="true">🔒</div>
              <div>
                <h3 className="bt-locked-title">Unlock Full Contact Details</h3>
                <div className="bt-locked-sub">
                  {/* Phase 6 A4: aligned "CV" wording across both branches
                      (was "references" on the free tier). Matches the rest of
                      the codebase (cv_url, cv_path, signed-URL flow). */}
                  {tier === "subscriber"
                    ? "Use 1 credit to reveal phone, email, LinkedIn, and CV"
                    : "Subscribe to view phone, email, LinkedIn, and CV"}
                </div>
              </div>
            </div>
          )}

          <div className="bt-modal-actions">
            {!isUnlocked && (
              canUnlock ? (
                <button
                  type="button"
                  className="bt-btn-unlock"
                  onClick={() => onUnlock()}
                  disabled={isUnlocking}
                  style={{ minWidth: 200 }}
                >
                  {isUnlocking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Unlock contact · 1 credit"
                  )}
                </button>
              ) : tier === "free" ? (
                <button
                  type="button"
                  className="bt-btn-unlock"
                  onClick={() => { onClose(); onLocked(); }}
                >
                  Subscribe to Unlock
                </button>
              ) : (
                <div className="bt-out-of-credits">
                  <p>You&apos;ve used all your credits this month.</p>
                  <button
                    type="button"
                    className="bt-btn-unlock"
                    onClick={() => { onClose(); onLocked(); }}
                  >
                    Upgrade to Pro for 300 credits/month
                  </button>
                </div>
              )
            )}
            <button
              type="button"
              className={cn("bt-btn-save-modal", saved && "saved")}
              onClick={onSave}
              disabled={isSaving}
              style={{ minWidth: 140 }}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : saved ? "♥ Saved" : "♡ Save Profile"}
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
