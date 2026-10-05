import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Navbar } from "@/components/navbar";
import { canonicalUrl } from "@/lib/seo";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  isRemotePublic,
  isTalentPublic,
  REMOTE_VISIBILITY_COLUMNS,
  type RemoteVisibilityFields,
  TALENT_VISIBILITY_COLUMNS,
  type TalentVisibilityFields,
} from "@/lib/talent-visibility";

// Force SSR — these pages depend on DB state and we want fresh approval
// status on every request rather than risk stale cache leaking unapproved
// rows.
export const dynamic = "force-dynamic";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type PageProps = {
  params: Promise<{ id: string }>;
};

type UnifiedProfile = {
  sourceTable: "talent_profiles" | "hire_remote_profiles";
  id: string;
  fullName: string;
  firstName: string;
  lastName: string | null;
  roleLabel: string;
  location: string;
  bio: string;
  skills: string[];
  yearsExperience: number | null;
  availability: string | null;
  workType: string | null;
  workLocation: string | null;
  salaryRange: string | null;
  photoUrl: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  education: string | null;
  languages: string[];
  portfolio: Array<{ title: string; url: string }>;
  employmentHistory: Array<{
    title: string;
    company: string;
    duration: string;
  }>;
  claimedAt: string | null;
  userId: string | null;
};

// Light contact-info redactor. Strips email/phone-shaped patterns that
// may have leaked into bio/summary text fields. Mirrors the spirit of
// /browse-talent's redaction (we don't want indexable PII).
function redactContact(text: string): string {
  return text
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      "[contact via Remotiv]",
    )
    .replace(/(\+?\d[\d\s()-]{7,}\d)/g, "[contact via Remotiv]");
}

// JSON.stringify does not escape "<", and this JSON-LD embeds candidate-authored
// values (fullName, bio, skills, location). A bio containing "</script>" would
// terminate the inline script element and execute what follows. Unicode escapes
// keep the output valid JSON — JSON.parse and Google's structured-data parser
// read it unchanged — while making it inert inside <script>.
function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function normalisePakistan(row: Record<string, unknown>): UnifiedProfile {
  const firstName = (row.first_name as string | null) ?? "";
  const lastName = (row.last_name as string | null) ?? null;
  const photoUrl = (() => {
    const path = ((row.photo_path as string | null) ?? "").trim();
    if (!path) return (row.avatar_url as string | null) ?? null;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    return base
      ? `${base}/storage/v1/object/public/talent_photos/${path}`
      : null;
  })();

  const fullName = `${firstName} ${lastName ?? ""}`.trim();
  const city = row.city as string | null;
  const country = row.country as string | null;
  const location = [city, country].filter(Boolean).join(", ");
  const salaryMin = row.salary_min as number | null;
  const salaryMax = row.salary_max as number | null;
  const salaryRange = (() => {
    if (!salaryMin && !salaryMax) return null;
    const fmt = (n: number) => `PKR ${(n / 1000).toFixed(0)}k`;
    if (salaryMin && salaryMax) {
      return `${fmt(salaryMin)}–${fmt(salaryMax)}/mo`;
    }
    return `${fmt(salaryMin ?? salaryMax ?? 0)}/mo`;
  })();
  const skills = Array.isArray(row.skills)
    ? (row.skills as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];

  const employmentHistory = Array.isArray(row.experience)
    ? (row.experience as unknown[])
        .filter(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null,
        )
        .map((e) => ({
          title: String(e.title ?? e.role ?? ""),
          company: String(e.company ?? ""),
          duration: String(e.duration ?? e.dates ?? ""),
        }))
        .filter((e) => e.title || e.company)
    : [];

  return {
    sourceTable: "talent_profiles",
    id: row.id as string,
    fullName,
    firstName,
    lastName,
    roleLabel:
      (row.job_title as string | null) ??
      (row.role_category as string | null) ??
      "Professional",
    location,
    bio: redactContact((row.summary as string | null) ?? ""),
    skills,
    yearsExperience: (row.years_experience as number | null) ?? null,
    availability: (row.availability as string | null) ?? null,
    workType: (row.work_type as string | null) ?? null,
    workLocation: (row.work_location as string | null) ?? null,
    salaryRange,
    photoUrl,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    githubUrl: (row.github_url as string | null) ?? null,
    education: null,
    languages: [],
    portfolio: [],
    employmentHistory,
    claimedAt: (row.claimed_at as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
  };
}

function normaliseRemote(row: Record<string, unknown>): UnifiedProfile {
  const firstName = (row.first_name as string | null) ?? "";
  const lastName = (row.last_name as string | null) ?? null;
  const photoUrl = (() => {
    const path = ((row.photo_path as string | null) ?? "").trim();
    if (!path) return null;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    return base
      ? `${base}/storage/v1/object/public/talent_photos/${path}`
      : null;
  })();

  const fullName = `${firstName} ${lastName ?? ""}`.trim();
  const city = row.city as string | null;
  const country = row.country as string | null;
  const timeZone = row.time_zone as string | null;
  const location = [city, country, timeZone].filter(Boolean).join(" · ");
  const hourlyRate = row.hourly_rate as number | null;
  const salaryRange = hourlyRate ? `$${hourlyRate}/hr` : null;
  const skills = Array.isArray(row.skills)
    ? (row.skills as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];
  const languages = Array.isArray(row.languages)
    ? (row.languages as unknown[])
        .filter(
          (l): l is Record<string, unknown> =>
            typeof l === "object" && l !== null,
        )
        .map((l) => String(l.name ?? ""))
        .filter(Boolean)
    : [];
  const portfolio = Array.isArray(row.portfolio)
    ? (row.portfolio as unknown[])
        .filter(
          (p): p is Record<string, unknown> =>
            typeof p === "object" && p !== null,
        )
        .map((p) => ({
          title: String(p.title ?? p.name ?? ""),
          url: String(p.url ?? ""),
        }))
        .filter((p) => p.url && p.url.startsWith("http"))
    : [];
  const employmentHistory = Array.isArray(row.employment_history)
    ? (row.employment_history as unknown[])
        .filter(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null,
        )
        .map((e) => ({
          title: String(e.title ?? ""),
          company: String(e.company ?? ""),
          duration: String(e.dates ?? e.duration ?? ""),
        }))
        .filter((e) => e.title || e.company)
    : [];

  const eduRow =
    row.education && typeof row.education === "object"
      ? (row.education as Record<string, unknown>)
      : null;
  const education = eduRow
    ? [eduRow.degree, eduRow.institution].filter(Boolean).join(" — ") || null
    : null;

  return {
    sourceTable: "hire_remote_profiles",
    id: row.id as string,
    fullName,
    firstName,
    lastName,
    roleLabel:
      ((row.job_titles as string | null) ?? "").split(",")[0].trim() ||
      "Professional",
    location,
    bio: redactContact((row.bio as string | null) ?? ""),
    skills,
    yearsExperience: null,
    availability: (row.availability as string | null) ?? null,
    workType: (row.work_type as string | null) ?? null,
    workLocation: null,
    salaryRange,
    photoUrl,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    githubUrl: null,
    education,
    languages,
    portfolio,
    employmentHistory,
    claimedAt: (row.claimed_at as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
  };
}

/**
 * Three outcomes, not two.
 *
 * The visibility predicate used to live inside these queries, so a hidden row
 * and an id that never existed both came back as `null` and the page could not
 * tell them apart. Fetching by id alone and testing the predicate in memory is
 * what makes the owner-gated unavailable state possible. `ownerUserId` is the
 * only thing carried out of a hidden row: no name, no photo, nothing rendered.
 */
type ProfileState =
  | { kind: "public"; profile: UnifiedProfile }
  | { kind: "hidden"; ownerUserId: string | null }
  | { kind: "missing" };

async function fetchProfileState(id: string): Promise<ProfileState> {
  if (!UUID_REGEX.test(id)) return { kind: "missing" };

  const supabase = createServiceClient();

  const { data: pakRow } = await supabase
    .from("talent_profiles")
    .select(
      `id, first_name, last_name, city, country, job_title, role_category, years_experience, summary, skills, availability, work_type, work_location, salary_min, salary_max, photo_path, avatar_url, linkedin_url, github_url, user_id, claimed_at, experience, ${TALENT_VISIBILITY_COLUMNS}`,
    )
    .eq("id", id)
    .maybeSingle();

  if (pakRow) {
    const row = pakRow as Record<string, unknown>;
    return isTalentPublic(row as TalentVisibilityFields)
      ? { kind: "public", profile: normalisePakistan(row) }
      : { kind: "hidden", ownerUserId: (row.user_id as string | null) ?? null };
  }

  const { data: remoteRow } = await supabase
    .from("hire_remote_profiles")
    .select(
      `id, first_name, last_name, city, country, time_zone, job_titles, bio, hourly_rate, hours_per_week, work_type, availability, photo_path, linkedin_url, skills, employment_history, education, languages, portfolio, user_id, claimed_at, ${REMOTE_VISIBILITY_COLUMNS}`,
    )
    .eq("id", id)
    .maybeSingle();

  if (remoteRow) {
    const row = remoteRow as Record<string, unknown>;
    return isRemotePublic(row as RemoteVisibilityFields)
      ? { kind: "public", profile: normaliseRemote(row) }
      : { kind: "hidden", ownerUserId: (row.user_id as string | null) ?? null };
  }

  return { kind: "missing" };
}

/**
 * True only when the caller is signed in as the person whose profile this is.
 * A hidden profile is a 404 for everyone else, so a stranger holding an id
 * cannot learn that the row exists.
 */
async function viewerOwnsHiddenProfile(ownerUserId: string | null): Promise<boolean> {
  if (!ownerUserId) return false;
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  return !!user && user.id === ownerUserId;
}

/**
 * Shown to the owner of a hidden profile, and to nobody else.
 *
 * Carries no name, no photo, no profile field of any kind, and no reason. The
 * reason is deliberately absent: "paused for a privacy review" invites a
 * question this page cannot answer, and the state may have several causes.
 * Anyone who is not the owner never reaches this and sees a 404 instead.
 */
function ProfileNotListed() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-remotiv-bg font-sans">
        <div className="mx-auto max-w-2xl px-4 py-24 text-center">
          <h1 className="font-heading text-2xl font-bold text-gray-900 md:text-3xl">
            This profile isn&apos;t currently listed.
          </h1>
          <p className="mt-3 text-base text-gray-600">
            It may be listed again later. Nothing else is shown at this address.
          </p>
          <Link
            href="/talent/dashboard"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-remotiv-purple px-6 py-3 text-sm font-bold text-white hover:opacity-90"
          >
            Go to your dashboard
          </Link>
        </div>
      </main>
    </>
  );
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const state = await fetchProfileState(id);

  if (state.kind !== "public") {
    // Identical metadata for hidden and missing, so the tab title cannot be
    // used to tell a paused profile from an id that never existed.
    return {
      title: "Profile not found — Remotiv",
      robots: { index: false, follow: false },
    };
  }
  const profile = state.profile;

  const title = `${profile.fullName} — ${profile.roleLabel} | Remotiv`;
  const description = profile.bio
    ? `${profile.bio.slice(0, 155).replace(/\s+/g, " ").trim()}…`
    : `${profile.fullName} is a vetted ${profile.roleLabel} on Remotiv. Hire top remote talent in hours, not weeks.`;

  const url = `/talent/${profile.id}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Remotiv",
      locale: "en_US",
      type: "profile",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    // A public profile may be indexed. Only profiles that pass the shared
    // visibility predicate reach this branch: a paused, archived, unapproved or
    // non-public-status profile takes the branch above, which stays noindex
    // whether it renders the owner's "not currently listed" page or a 404, so
    // the robots directive cannot tell a stranger a hidden profile from a
    // missing one. The signup forms tell applicants an approved page can appear
    // in search engines, and the sitemap advertises exactly this set.
    robots: { index: true, follow: true },
  };
}

export default async function TalentProfilePage({ params }: PageProps) {
  const { id } = await params;
  const state = await fetchProfileState(id);

  if (state.kind === "missing") {
    notFound();
  }

  if (state.kind === "hidden") {
    // The owner gets told their profile is not listed. Everyone else gets the
    // same 404 as a nonexistent id, so holding a link reveals nothing. Most of
    // the hidden population is unclaimed and therefore has no owner who can
    // sign in, so this branch will rarely render - a claim invitation, not a
    // page, is what reaches those people.
    if (!(await viewerOwnsHiddenProfile(state.ownerUserId))) {
      notFound();
    }
    return <ProfileNotListed />;
  }

  const profile = state.profile;

  const personLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.fullName,
    jobTitle: profile.roleLabel,
    url: canonicalUrl(`/talent/${profile.id}`),
    ...(profile.photoUrl ? { image: profile.photoUrl } : {}),
    ...(profile.bio ? { description: profile.bio.slice(0, 500) } : {}),
    ...(profile.skills.length > 0 ? { knowsAbout: profile.skills } : {}),
    ...(profile.location
      ? {
          address: {
            "@type": "PostalAddress",
            addressLocality: profile.location,
          },
        }
      : {}),
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: canonicalUrl("/"),
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Find Talent",
        item: canonicalUrl("/browse-talent"),
      },
      {
        "@type": "ListItem",
        position: 3,
        name: profile.fullName,
        item: canonicalUrl(`/talent/${profile.id}`),
      },
    ],
  };

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-remotiv-bg font-sans">
        <article className="mx-auto max-w-4xl px-4 py-12 md:px-6 md:py-16">
          {!profile.claimedAt && !profile.userId && (
            <aside className="mb-8 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200 md:p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 text-amber-700"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="font-heading text-sm font-bold text-amber-900">
                      Is this your profile?
                    </p>
                    <p className="mt-0.5 text-xs text-amber-800 md:text-sm">
                      Claim it to control what&apos;s visible and edit your details.
                    </p>
                  </div>
                </div>
                <Link
                  href={`/talent/login?profile_id=${profile.id}&source_table=${profile.sourceTable}`}
                  className="shrink-0 rounded-full bg-amber-900 px-4 py-2 text-center text-xs font-bold text-amber-50 hover:bg-amber-950 md:text-sm"
                >
                  Claim profile →
                </Link>
              </div>
            </aside>
          )}
          <header className="flex flex-col items-start gap-6 md:flex-row md:items-center">
            <div className="shrink-0">
              {profile.photoUrl ? (
                <Image
                  src={profile.photoUrl}
                  alt={profile.fullName}
                  width={128}
                  height={128}
                  className="rounded-2xl object-cover"
                  priority
                />
              ) : (
                <div className="flex h-32 w-32 items-center justify-center rounded-2xl bg-remotiv-purple/10 font-heading text-3xl font-bold text-remotiv-purple">
                  {profile.firstName.charAt(0).toUpperCase()}
                  {(profile.lastName ?? "").charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-heading text-3xl font-bold text-gray-900 md:text-4xl">
                {profile.fullName}
              </h1>
              <p className="mt-2 text-lg text-gray-600">{profile.roleLabel}</p>
              {profile.location && (
                <p className="mt-1 text-sm text-gray-500">{profile.location}</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {profile.availability && (
                  <span className="rounded-full bg-remotiv-green/15 px-3 py-1 text-xs font-semibold text-remotiv-green">
                    {profile.availability}
                  </span>
                )}
                {profile.workType && (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                    {profile.workType}
                  </span>
                )}
                {profile.workLocation && (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                    {profile.workLocation}
                  </span>
                )}
                {profile.salaryRange && (
                  <span className="rounded-full bg-remotiv-purple/10 px-3 py-1 text-xs font-semibold text-remotiv-purple">
                    {profile.salaryRange}
                  </span>
                )}
              </div>
            </div>
          </header>

          {profile.bio && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                About
              </h2>
              <p className="mt-3 whitespace-pre-line text-base leading-relaxed text-gray-800">
                {profile.bio}
              </p>
            </section>
          )}

          {profile.skills.length > 0 && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                Skills
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {profile.skills.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-200"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </section>
          )}

          {profile.employmentHistory.length > 0 && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                Experience
              </h2>
              <ul className="mt-3 space-y-3">
                {profile.employmentHistory.map((job) => (
                  <li
                    key={`${job.title}-${job.company}-${job.duration}`}
                    className="rounded-2xl bg-white p-4 ring-1 ring-gray-100"
                  >
                    <p className="font-heading font-bold text-gray-900">
                      {job.title}
                    </p>
                    <p className="text-sm text-gray-600">{job.company}</p>
                    {job.duration && (
                      <p className="mt-1 text-xs text-gray-400">
                        {job.duration}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {profile.education && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                Education
              </h2>
              <p className="mt-3 text-base text-gray-800">{profile.education}</p>
            </section>
          )}

          {profile.languages.length > 0 && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                Languages
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {profile.languages.map((l) => (
                  <span
                    key={l}
                    className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-gray-700 ring-1 ring-gray-200"
                  >
                    {l}
                  </span>
                ))}
              </div>
            </section>
          )}

          {profile.portfolio.length > 0 && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                Portfolio
              </h2>
              <ul className="mt-3 space-y-2">
                {profile.portfolio.map((p) => (
                  <li key={p.url}>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-semibold text-remotiv-purple hover:underline"
                    >
                      {p.title || p.url} →
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(profile.linkedinUrl || profile.githubUrl) && (
            <section className="mt-10">
              <h2 className="font-heading text-sm font-semibold uppercase tracking-widest text-gray-500">
                Find online
              </h2>
              <p className="mt-2 text-xs text-gray-500">
                Subscribe to access direct links and contact information.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {profile.linkedinUrl && (
                  <Link
                    href="/pricing"
                    className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-gray-700 ring-1 ring-gray-200 hover:ring-remotiv-purple"
                  >
                    LinkedIn →
                  </Link>
                )}
                {profile.githubUrl && (
                  <Link
                    href="/pricing"
                    className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-gray-700 ring-1 ring-gray-200 hover:ring-remotiv-purple"
                  >
                    GitHub →
                  </Link>
                )}
              </div>
            </section>
          )}

          <section className="mt-12 rounded-2xl bg-remotiv-purple p-6 text-white">
            <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-heading text-xl font-bold">
                  Want to hire {profile.firstName}?
                </h2>
                <p className="mt-1 text-sm text-white/85">
                  Subscribe to unlock CV download and direct contact.
                </p>
              </div>
              <Link
                href="/pricing"
                className="shrink-0 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-remotiv-purple hover:bg-white/95"
              >
                See pricing →
              </Link>
            </div>
          </section>
        </article>
      </main>

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw string
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(personLd) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw string
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbLd) }}
      />
    </>
  );
}
