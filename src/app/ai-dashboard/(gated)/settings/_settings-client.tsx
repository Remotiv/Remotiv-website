"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Eye, Lock, Plus } from "lucide-react";
import { isValidEmail } from "@/lib/validators";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  COMPANY_DESCRIPTION_MAX,
  COMPANY_INDUSTRIES,
  COMPANY_ROLE_LABELS,
  type CompanyRole,
} from "@/app/ai-dashboard/lib/company-roles";
import { LOGO_MAX_BYTES } from "./constants";
import {
  removeCompanyLogo,
  updateCompanyProfile,
  updateOwnAccount,
  updateRejectionEmailDefault,
} from "./actions";

// ── Shared control classes ───────────────────────────────────
// Identical to the wizard's, per the handoff: same border, radius, padding and
// focus ring. Not a Settings-only fork.
const INPUT_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors hover:border-[var(--ai-t4)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16] disabled:cursor-not-allowed disabled:border-[var(--ai-line)] disabled:bg-[var(--ai-inset)] disabled:text-[var(--ai-t3)]";
const INPUT_ERR_CLS =
  "border-[#E0524B] ring-[3px] ring-[#E0524B]/[0.14] focus:border-[#E0524B]";
const LABEL_CLS =
  "mb-[7px] block text-[11.5px] font-bold tracking-[0.01em] text-[var(--ai-t2)]";
const HINT_CLS = "mt-[7px] text-xs leading-[1.45] text-[var(--ai-t3)]";
const ERR_CLS = "mt-1.5 text-xs font-semibold text-[#C4362F]";

const CARD_CLS =
  "mb-4 overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)] last:mb-0";
const FOOT_CLS =
  "flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-3.5";
const BTN_CANCEL =
  "rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-[17px] py-2.5 text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-ink,#141020)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-[0.42] disabled:hover:border-[var(--ai-line-strong)] disabled:hover:bg-[var(--ai-surface)] disabled:hover:text-[var(--ai-t2)]";
const BTN_SAVE =
  "inline-flex items-center gap-2 rounded-[11px] border border-remotiv-purple bg-remotiv-purple px-[18px] py-2.5 text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[#6D38F0] disabled:cursor-not-allowed disabled:opacity-[0.42] disabled:shadow-none disabled:hover:bg-remotiv-purple";
const BTN_DARK =
  "inline-flex items-center gap-2 rounded-[11px] border border-[var(--ai-sidebar)] bg-[var(--ai-sidebar)] px-[18px] py-2.5 text-[13.5px] font-bold text-white transition-colors hover:border-remotiv-purple hover:bg-remotiv-purple disabled:cursor-not-allowed disabled:opacity-[0.42] disabled:hover:border-[var(--ai-sidebar)] disabled:hover:bg-[var(--ai-sidebar)]";

type CompanyForm = {
  name: string;
  contact_name: string;
  candidate_reply_email: string;
  website: string;
  industry: string;
  description: string;
};
type AccountForm = {
  email: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

const EMPTY_PASSWORDS = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

function initialOf(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? "?";
}

/** Strip the scheme for display only — the stored value keeps it. */
function hostOf(website: string): string {
  return website.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function SettingsClient({
  role,
  company,
  account,
  sendRejectionDefault,
  stats,
}: {
  role: CompanyRole;
  company: CompanyForm & { logoUrl: string | null; slug: string | null };
  account: { email: string };
  sendRejectionDefault: boolean;
  stats: { liveRoles: number; applicants: number; seatsUsed: number };
}) {
  const router = useRouter();

  // The company's OWN public list, not the whole board. /jobs alone shows every
  // company's roles — handing that to a customer as their "careers link" shows
  // them their competitors. Falls back to /jobs only if the row somehow has no
  // slug, which would otherwise produce a link to `?company=` and no filter.
  const careersPath = company.slug
    ? `/jobs?company=${encodeURIComponent(company.slug)}`
    : "/jobs";

  // Owner/admin edit the company profile; everyone else reads it. The server
  // action re-checks this — a disabled input is a courtesy, not a permission.
  const canEditCompany = role === "owner" || role === "admin";

  // Saved on toggle rather than behind a Save button: it is a single boolean
  // with nothing to validate and no other field to be consistent with, so a
  // footer would only add a way to leave it half-applied. Flipped optimistically
  // and reverted if the action fails, so the switch never shows a state the
  // database doesn't hold.
  const [rejectDefault, setRejectDefault] = useState(sendRejectionDefault);
  const [rejectBusy, setRejectBusy] = useState(false);

  async function saveRejectionDefault(next: boolean) {
    setRejectBusy(true);
    setRejectDefault(next);
    const res = await updateRejectionEmailDefault(next);
    setRejectBusy(false);
    if (!res.success) {
      setRejectDefault(!next);
      showToast(res.error);
      return;
    }
    showToast(next ? "New jobs will send rejections" : "Default turned off");
  }

  // Only the editable form fields. `company` also carries slug + logoUrl,
  // which are not part of this form — seeding state from the whole object put
  // them into the dirty comparison and into the save payload.
  const initialCompanyForm: CompanyForm = {
    name: company.name,
    contact_name: company.contact_name,
    candidate_reply_email: company.candidate_reply_email,
    website: company.website,
    industry: company.industry,
    description: company.description,
  };
  const [coSaved, setCoSaved] = useState<CompanyForm>(initialCompanyForm);
  const [co, setCo] = useState<CompanyForm>(initialCompanyForm);
  const [coErr, setCoErr] = useState<Record<string, string>>({});
  const [coBusy, setCoBusy] = useState(false);

  const [acSaved, setAcSaved] = useState<AccountForm>({
    email: account.email,
    ...EMPTY_PASSWORDS,
  });
  const [ac, setAc] = useState<AccountForm>({
    email: account.email,
    ...EMPTY_PASSWORDS,
  });
  const [acErr, setAcErr] = useState<Record<string, string>>({});
  const [acBusy, setAcBusy] = useState(false);

  const [logoUrl, setLogoUrl] = useState<string | null>(company.logoUrl);
  const [logoBusy, setLogoBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Each card owns its own dirty state. There is no page-level save bar and
  // there must not be one — the two cards are different scopes with different
  // permissions, and they post to different endpoints.
  const coDirty = (Object.keys(co) as Array<keyof CompanyForm>).some(
    (k) => co[k] !== coSaved[k],
  );
  const acDirty = (Object.keys(ac) as Array<keyof AccountForm>).some(
    (k) => ac[k] !== acSaved[k],
  );

  function setCoField<K extends keyof CompanyForm>(key: K, value: CompanyForm[K]) {
    setCo((prev) => ({ ...prev, [key]: value }));
    setCoErr((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  function setAcField<K extends keyof AccountForm>(key: K, value: AccountForm[K]) {
    setAc((prev) => ({ ...prev, [key]: value }));
    setAcErr((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function saveCompany() {
    if (!co.name.trim()) {
      setCoErr({ name: "Company name can't be empty." });
      return;
    }
    if (co.website.trim() && !/^https?:\/\/.+\..+/.test(co.website.trim())) {
      setCoErr({ website: "Enter a full URL, starting with https://" });
      return;
    }
    // Blank is allowed and means "replies go to Remotiv"; anything else has to
    // be a real address. Same predicate the action re-checks server-side.
    if (
      co.candidate_reply_email.trim() &&
      !isValidEmail(co.candidate_reply_email)
    ) {
      setCoErr({
        candidate_reply_email:
          "Enter a valid email address, or leave it blank to take no replies.",
      });
      return;
    }
    if (co.description.length > COMPANY_DESCRIPTION_MAX) {
      setCoErr({
        description: `Description is over the ${COMPANY_DESCRIPTION_MAX.toLocaleString()} character limit.`,
      });
      return;
    }

    setCoBusy(true);
    let result: Awaited<ReturnType<typeof updateCompanyProfile>>;
    try {
      result = await updateCompanyProfile(co);
    } catch {
      result = { success: false, error: "Couldn't save — please try again." };
    }
    setCoBusy(false);

    if (!result.success) {
      showToast(result.error);
      return;
    }
    setCoSaved(co);
    showToast("Company profile saved");
    router.refresh();
  }

  async function saveAccount() {
    const email = ac.email.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAcErr({ email: "Enter a valid email address." });
      return;
    }
    const wantsPassword = Boolean(
      ac.currentPassword || ac.newPassword || ac.confirmPassword,
    );
    if (wantsPassword) {
      if (!ac.currentPassword) {
        setAcErr({ currentPassword: "Enter your current password to set a new one." });
        return;
      }
      if (ac.newPassword.length < 8) {
        setAcErr({ newPassword: "Use at least 8 characters." });
        return;
      }
      if (ac.newPassword !== ac.confirmPassword) {
        setAcErr({ confirmPassword: "Passwords don't match." });
        return;
      }
    }

    setAcBusy(true);
    let result: Awaited<ReturnType<typeof updateOwnAccount>>;
    try {
      result = await updateOwnAccount(ac);
    } catch {
      result = { success: false, error: "Couldn't save — please try again." };
    }
    setAcBusy(false);

    if (!result.success) {
      showToast(result.error);
      return;
    }

    // ORDER MATTERS: clear the password fields BEFORE snapshotting, so the
    // baseline is the cleared state. Snapshotting first would capture the
    // submitted password, which lets Cancel write it back into the visible
    // form and leaves the card permanently dirty. This was a real bug.
    const cleared: AccountForm = { email, ...EMPTY_PASSWORDS };
    setAc(cleared);
    setAcSaved(cleared);
    showToast("Account updated");
    router.refresh();
  }

  async function handleLogoFile(file: File | null) {
    if (!file) return;
    // Cheap client-side guard so an obviously-wrong file never leaves the
    // browser. The route re-checks size AND sniffs the bytes regardless.
    if (file.size > LOGO_MAX_BYTES) {
      showToast("That file is over 5MB. Try a smaller image.");
      return;
    }
    setLogoBusy(true);
    try {
      const body = new FormData();
      body.append("logo", file);
      const res = await fetch("/api/ai-dashboard/company-logo", {
        method: "POST",
        body,
      });
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) {
        showToast(json.error ?? "Upload failed. Please try again.");
        return;
      }
      setLogoUrl(json.url ?? null);
      showToast("Logo updated");
      router.refresh();
    } catch {
      showToast("Upload failed. Please try again.");
    } finally {
      setLogoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleLogoRemove() {
    setLogoBusy(true);
    try {
      const result = await removeCompanyLogo();
      if (!result.success) {
        showToast(result.error);
        return;
      }
      setLogoUrl(null);
      showToast("Logo removed — letter fallback in use");
      router.refresh();
    } finally {
      setLogoBusy(false);
    }
  }

  const heroName = co.name.trim() || "Your company";
  const heroHost = hostOf(co.website) || "No website set";
  const letter = initialOf(co.name);

  return (
    <PageContainer>
      <div className="mb-[22px] flex flex-col items-start justify-between gap-6 min-[900px]:flex-row min-[900px]:items-end min-[900px]:gap-8">
        <div>
          <h1 className="m-0 font-heading text-[44px] font-extrabold leading-none tracking-[-0.04em] text-[var(--ai-t1)]">
            Settings
          </h1>
          <p className="mt-3 max-w-[620px] text-[15px] leading-[1.55] text-[var(--ai-t2)]">
            Your company profile is{" "}
            <span className="relative z-0 inline-block px-[5px] font-bold text-[var(--ai-t1)]">
              <span
                aria-hidden
                className="absolute inset-y-[4%] -left-[3px] -right-[3px] -z-10 rotate-[-1.2deg] rounded-[3px] bg-remotiv-lime"
              />
              public on every job post
            </span>{" "}
            — your account below is only ever visible to you.
          </p>
        </div>
        <div className="flex shrink-0 gap-3 pb-1">
          <Link
            href={careersPath}
            className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-5 py-[13px] text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
          >
            <Eye className="size-4" strokeWidth={1.9} />
            Preview
          </Link>
          <Link
            href="/ai-dashboard/jobs/new"
            className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-[14px] border border-remotiv-purple bg-remotiv-purple px-[22px] py-[13px] text-sm font-bold text-white shadow-[0_8px_24px_rgba(126,71,255,0.3)] transition-colors hover:bg-[#6D38F0]"
          >
            <Plus className="size-4" strokeWidth={2.4} />
            New job
          </Link>
        </div>
      </div>

      {/* Dark hero — a LIVE preview of the public company profile. Logo, name,
          website and industry mirror the form below as you type; that mirroring
          is the point of the hero, not decoration. Every <p> sets its own
          colour: the design system's global `p { color:#444 }` beats inherited
          white on a dark surface. */}
      <div className="relative mb-[30px] grid grid-cols-1 items-center gap-[34px] overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] px-[30px] py-7 shadow-[0_18px_46px_rgba(20,16,32,0.24)] min-[1120px]:grid-cols-[minmax(0,1fr)_1px_auto]">
        <span
          aria-hidden
          className="pointer-events-none absolute -right-[10%] -top-[120%] h-[340%] w-[70%]"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(126,71,255,0.45), transparent 62%)",
          }}
        />
        <div className="relative z-[1] min-w-0">
          <p className="m-0 mb-4 text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/40">
            Public company profile
          </p>
          <div className="flex min-w-0 items-center gap-4">
            <span className="flex size-[60px] shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/[0.14] bg-white/10 font-heading text-2xl font-extrabold tracking-[-0.03em] text-white">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt=""
                  className="size-full object-cover"
                />
              ) : (
                letter
              )}
            </span>
            <div className="min-w-0">
              <p className="m-0 truncate font-heading text-[26px] font-extrabold leading-[1.15] tracking-[-0.035em] text-white">
                {heroName}
              </p>
              <p className="m-0 mt-[7px] flex flex-wrap items-center gap-2.5 text-[13px] text-white/50">
                <span className="font-semibold text-remotiv-green">{heroHost}</span>
                {co.industry && (
                  <>
                    <span className="size-[3px] shrink-0 rounded-full bg-white/30" />
                    <span>{co.industry}</span>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2.5">
            <Link
              href={careersPath}
              className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-xl bg-remotiv-green px-5 py-3 text-[13.5px] font-bold text-[var(--ai-mint-ink)] transition-colors hover:bg-[var(--ai-mint-hover,#3BC495)]"
            >
              <ArrowRight className="size-[15px]" strokeWidth={2.2} />
              View public page
            </Link>
            <button
              type="button"
              onClick={() => {
                // Absolute URL — this is pasted into emails and job ads, where
                // a relative path is useless.
                void navigator.clipboard
                  ?.writeText(`${window.location.origin}${careersPath}`)
                  .then(() => showToast("Careers link copied to clipboard"))
                  .catch(() => showToast("Couldn't copy the link"));
              }}
              className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-xl border border-white/[0.14] bg-white/[0.08] px-5 py-3 text-[13.5px] font-semibold text-white transition-colors hover:bg-white/[0.16]"
            >
              Copy careers link
            </button>
          </div>
        </div>
        <div className="relative z-[1] hidden h-[132px] self-center bg-white/[0.12] min-[1120px]:block" />
        <div className="relative z-[1] flex flex-wrap gap-[34px]">
          <HeroStat
            label="Live roles"
            value={String(stats.liveRoles)}
            sub="on remotiv.work/jobs"
          />
          <HeroStat
            label="Applicants"
            value={String(stats.applicants)}
            sub="total received"
          />
          <HeroStat label="Team" value={String(stats.seatsUsed)} sub="seats used" />
        </div>
      </div>

      {/* The form column is capped at 900px while the hero stays full width.
          A 1560px-wide text input is unusable; the asymmetry is intentional. */}
      <div className="max-w-[900px]">
        {!canEditCompany && (
          <div className="mb-4 flex items-start gap-[11px] rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-4 py-[13px]">
            <Lock className="mt-px size-[17px] shrink-0 text-[var(--ai-t3)]" strokeWidth={1.9} />
            <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t2)]">
              <b className="font-bold text-[var(--ai-t1)]">
                Company profile is read-only for your role.
              </b>{" "}
              Owners and admins can edit it — ask one of them on the{" "}
              <Link href="/ai-dashboard/team" className="font-semibold text-remotiv-purple hover:underline">
                Team page
              </Link>
              . Your own account below is still yours to change.
            </p>
          </div>
        )}

        {/* ── Card 1: Company profile ── */}
        <section className={CARD_CLS}>
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
                Company profile
              </h2>
              <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
                This is what candidates see on your job posts.
              </p>
            </div>
            <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-purple-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-purple-ink)]">
              Owners &amp; admins
            </span>
          </div>

          <div className="px-6 pb-[22px] pt-[18px]">
            <div className="flex items-center gap-4">
              <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-[var(--ai-purple-tint)] font-heading text-[22px] font-extrabold tracking-[-0.03em] text-[var(--ai-purple-ink)]">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="" className="size-full object-cover" />
                ) : (
                  letter
                )}
              </span>
              <div>
                {canEditCompany && (
                  <div className="mb-[7px] flex gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(e) => {
                        void handleLogoFile(e.target.files?.[0] ?? null);
                      }}
                    />
                    <button
                      type="button"
                      disabled={logoBusy}
                      onClick={() => fileRef.current?.click()}
                      className="rounded-[10px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-[7px] text-[12.5px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {logoBusy ? "Working…" : "Upload logo"}
                    </button>
                    {logoUrl && (
                      <button
                        type="button"
                        disabled={logoBusy}
                        onClick={() => {
                          void handleLogoRemove();
                        }}
                        className="border-none bg-transparent px-1 py-[7px] text-[12.5px] font-bold text-[var(--ai-t3)] transition-colors hover:text-[#C4362F] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
                <p className="text-xs leading-[1.45] text-[var(--ai-t3)]">
                  PNG or JPG, up to 5MB. Square works best.
                </p>
              </div>
            </div>

            <div className="my-[18px] border-t border-[var(--ai-line-soft)]" />

            <div className="mb-4">
              <label className={LABEL_CLS} htmlFor="co-name">
                Company name <span className="text-remotiv-purple">*</span>
              </label>
              <input
                id="co-name"
                value={co.name}
                disabled={!canEditCompany}
                onChange={(e) => setCoField("name", e.target.value)}
                className={`${INPUT_CLS} ${coErr.name ? INPUT_ERR_CLS : ""}`}
              />
              {coErr.name && <p className={ERR_CLS}>{coErr.name}</p>}
              {/* Real count, not a placeholder. Dropped entirely at zero rather
                  than printing "all 0 live job posts". */}
              {stats.liveRoles > 0 && (
                <p className={HINT_CLS}>
                  Changing this updates the name on{" "}
                  <b className="font-bold text-[var(--ai-t2)]">
                    all {stats.liveRoles} live job post
                    {stats.liveRoles === 1 ? "" : "s"}
                  </b>
                  .
                </p>
              )}
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3.5 min-[820px]:grid-cols-2">
              <div>
                <label className={LABEL_CLS} htmlFor="co-contact">
                  Contact name
                </label>
                <input
                  id="co-contact"
                  value={co.contact_name}
                  disabled={!canEditCompany}
                  onChange={(e) => setCoField("contact_name", e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="co-industry">
                  Industry
                </label>
                <select
                  id="co-industry"
                  value={co.industry}
                  disabled={!canEditCompany}
                  onChange={(e) => setCoField("industry", e.target.value)}
                  className={`${INPUT_CLS} cursor-pointer appearance-none`}
                >
                  <option value="">Not set</option>
                  {COMPANY_INDUSTRIES.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-4">
              <label className={LABEL_CLS} htmlFor="co-site">
                Website
              </label>
              <input
                id="co-site"
                value={co.website}
                placeholder="https://"
                disabled={!canEditCompany}
                onChange={(e) => setCoField("website", e.target.value)}
                className={`${INPUT_CLS} ${coErr.website ? INPUT_ERR_CLS : ""}`}
              />
              {coErr.website && <p className={ERR_CLS}>{coErr.website}</p>}
            </div>

            <div className="mb-4">
              <label className={LABEL_CLS} htmlFor="co-reply">
                Where candidate replies go
              </label>
              <input
                id="co-reply"
                type="email"
                value={co.candidate_reply_email}
                placeholder="careers@yourcompany.com"
                disabled={!canEditCompany}
                onChange={(e) => setCoField("candidate_reply_email", e.target.value)}
                className={`${INPUT_CLS} ${coErr.candidate_reply_email ? INPUT_ERR_CLS : ""}`}
              />
              {coErr.candidate_reply_email && (
                <p className={ERR_CLS}>{coErr.candidate_reply_email}</p>
              )}
              <p className={HINT_CLS}>
                Candidates replying to your emails reach this address. Leave it
                blank and they can&apos;t reply to you at all — replies go to an
                unmonitored address and nobody reads them.
              </p>
            </div>

            <div>
              <div className="mb-[7px] flex items-baseline justify-between gap-3">
                <label className={`${LABEL_CLS} mb-0`} htmlFor="co-about">
                  About the company
                </label>
                <span className="text-[11.5px] font-semibold tabular-nums text-[var(--ai-t4)]">
                  {co.description.length.toLocaleString("en-US")} /{" "}
                  {COMPANY_DESCRIPTION_MAX.toLocaleString("en-US")}
                </span>
              </div>
              <textarea
                id="co-about"
                value={co.description}
                disabled={!canEditCompany}
                onChange={(e) => setCoField("description", e.target.value)}
                className={`${INPUT_CLS} min-h-[88px] resize-y leading-[1.55] ${coErr.description ? INPUT_ERR_CLS : ""}`}
              />
              {coErr.description && <p className={ERR_CLS}>{coErr.description}</p>}
              <p className={HINT_CLS}>
                Shown to candidates and used as context by your AI recruiter.
              </p>
            </div>
          </div>

          {canEditCompany && (
            <div className={FOOT_CLS}>
              <span
                className={`flex items-center gap-[7px] text-[12.5px] font-semibold text-[var(--ai-t3)] transition-opacity ${coDirty ? "opacity-100" : "opacity-0"}`}
              >
                <span className="size-1.5 rounded-full bg-[var(--ai-amber-dot)]" />
                Unsaved changes
              </span>
              <div className="ml-auto flex gap-2.5">
                <button
                  type="button"
                  disabled={!coDirty || coBusy}
                  onClick={() => {
                    setCo(coSaved);
                    setCoErr({});
                    showToast("Changes discarded");
                  }}
                  className={BTN_CANCEL}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!coDirty || coBusy}
                  onClick={() => {
                    void saveCompany();
                  }}
                  className={BTN_SAVE}
                >
                  <Check className="size-[15px]" strokeWidth={2.4} />
                  {coBusy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* ── Card 2: Your account ── */}
        <section className={CARD_CLS}>
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
                Your account
              </h2>
              <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
                Only you can see or change this.
              </p>
            </div>
            <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-mint-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-[var(--ai-mint-ink)]">
              Just you
            </span>
          </div>

          <div className="px-6 pb-[22px] pt-[18px]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="m-0 mb-[3px] text-sm font-bold text-[var(--ai-t1)]">
                  Your role
                </p>
                <p className="m-0 text-xs text-[var(--ai-t3)]">
                  Roles are managed on the{" "}
                  <Link
                    href="/ai-dashboard/team"
                    className="font-semibold text-remotiv-purple hover:underline"
                  >
                    Team page
                  </Link>
                  .
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--ai-purple-tint)] px-3 py-[5px] text-xs font-bold text-[var(--ai-purple-ink)]">
                <span className="size-[5px] rounded-full bg-remotiv-purple" />
                {COMPANY_ROLE_LABELS[role]}
              </span>
            </div>

            <div className="my-[18px] border-t border-[var(--ai-line-soft)]" />

            <div>
              <label className={LABEL_CLS} htmlFor="ac-email">
                Login email <span className="text-remotiv-purple">*</span>
              </label>
              <input
                id="ac-email"
                type="email"
                value={ac.email}
                onChange={(e) => setAcField("email", e.target.value)}
                className={`${INPUT_CLS} ${acErr.email ? INPUT_ERR_CLS : ""}`}
              />
              {acErr.email && <p className={ERR_CLS}>{acErr.email}</p>}
              <p className={HINT_CLS}>This is the address you sign in with.</p>
            </div>

            <div className="my-[18px] border-t border-[var(--ai-line-soft)]" />

            <p className="m-0 mb-1 text-sm font-bold tracking-[-0.01em] text-[var(--ai-t1)]">
              Change password
            </p>
            <p className="m-0 mb-3.5 text-xs leading-[1.45] text-[var(--ai-t3)]">
              Leave these blank to keep your current password.
            </p>

            <div className="mb-4">
              <label className={LABEL_CLS} htmlFor="ac-cur">
                Current password
              </label>
              <input
                id="ac-cur"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={ac.currentPassword}
                onChange={(e) => setAcField("currentPassword", e.target.value)}
                className={`${INPUT_CLS} ${acErr.currentPassword ? INPUT_ERR_CLS : ""}`}
              />
              {acErr.currentPassword && <p className={ERR_CLS}>{acErr.currentPassword}</p>}
            </div>

            <div className="grid grid-cols-1 gap-3.5 min-[820px]:grid-cols-2">
              <div>
                <label className={LABEL_CLS} htmlFor="ac-new">
                  New password
                </label>
                <input
                  id="ac-new"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={ac.newPassword}
                  onChange={(e) => setAcField("newPassword", e.target.value)}
                  className={`${INPUT_CLS} ${acErr.newPassword ? INPUT_ERR_CLS : ""}`}
                />
                {acErr.newPassword && <p className={ERR_CLS}>{acErr.newPassword}</p>}
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="ac-conf">
                  Confirm new password
                </label>
                <input
                  id="ac-conf"
                  type="password"
                  autoComplete="new-password"
                  value={ac.confirmPassword}
                  onChange={(e) => setAcField("confirmPassword", e.target.value)}
                  className={`${INPUT_CLS} ${acErr.confirmPassword ? INPUT_ERR_CLS : ""}`}
                />
                {acErr.confirmPassword && <p className={ERR_CLS}>{acErr.confirmPassword}</p>}
              </div>
            </div>
          </div>

          <div className={FOOT_CLS}>
            <span
              className={`flex items-center gap-[7px] text-[12.5px] font-semibold text-[var(--ai-t3)] transition-opacity ${acDirty ? "opacity-100" : "opacity-0"}`}
            >
              <span className="size-1.5 rounded-full bg-[var(--ai-amber-dot)]" />
              Unsaved changes
            </span>
            <div className="ml-auto flex gap-2.5">
              <button
                type="button"
                disabled={!acDirty || acBusy}
                onClick={() => {
                  setAc(acSaved);
                  setAcErr({});
                  showToast("Changes discarded");
                }}
                className={BTN_CANCEL}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!acDirty || acBusy}
                onClick={() => {
                  void saveAccount();
                }}
                className={BTN_DARK}
              >
                {acBusy ? "Saving…" : "Update account"}
              </button>
            </div>
          </div>
        </section>

        {/* ── Card 3: Candidate email ── */}
        <section className={CARD_CLS}>
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <h2 className="m-0 mb-[5px] font-heading text-lg font-extrabold tracking-[-0.025em] text-[var(--ai-t1)]">
                Candidate email
              </h2>
              <p className="m-0 text-[13px] leading-[1.5] text-[var(--ai-t3)]">
                What candidates hear from you automatically.
              </p>
            </div>
          </div>

          <div className="px-6 pb-[22px] pt-[18px]">
            <div className="rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-[13px]">
              <div className="flex items-start gap-3">
                <div className="min-w-0">
                  <p className="m-0 text-[13.5px] font-semibold text-[var(--ai-t1)]">
                    Automated rejection emails on new jobs
                  </p>
                  <p className="m-0 mt-1 text-xs leading-relaxed text-[var(--ai-t3)]">
                    The starting value for every job you post from now on. It
                    doesn&apos;t change jobs that are already live — switch those on
                    one at a time from the job&apos;s own edit screen.
                  </p>
                </div>
                <span className="ml-auto pt-0.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rejectDefault}
                    aria-label="Automated rejection emails on new jobs"
                    disabled={!canEditCompany || rejectBusy}
                    onClick={() => {
                      void saveRejectionDefault(!rejectDefault);
                    }}
                    className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-[0.42] ${
                      rejectDefault ? "bg-remotiv-green" : "bg-[var(--ai-line-strong)]"
                    }`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform ${
                        rejectDefault ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                </span>
              </div>
            </div>

            <p className="m-0 mt-3 text-xs leading-[1.5] text-[var(--ai-t3)]">
              Rejections are sent two days after you move someone to Rejected.
              Moving them back out before then cancels the email. The only other
              automatic email is the confirmation every candidate gets when they
              apply — no other stage sends anything.
            </p>
          </div>
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-[13px] bg-[var(--ai-sidebar)] px-[19px] py-[13px] text-[13.5px] font-semibold text-white shadow-[0_18px_44px_rgba(0,0,0,0.34)]">
          <Check className="size-4 shrink-0 text-remotiv-green" strokeWidth={2.4} />
          {toast}
        </div>
      )}
    </PageContainer>
  );
}

function HeroStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div>
      <p className="m-0 mb-2.5 whitespace-nowrap text-[11.5px] font-semibold text-white/50">
        {label}
      </p>
      <div className="font-heading text-[30px] font-extrabold leading-none tracking-[-0.035em] text-white">
        {value}
      </div>
      <p className="m-0 mt-2.5 whitespace-nowrap text-[11.5px] text-white/[0.36]">
        {sub}
      </p>
    </div>
  );
}
