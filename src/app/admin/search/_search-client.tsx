"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Search as SearchIcon,
  FileText,
  Users,
  Mail,
  Phone,
  Briefcase,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { TopNav } from "@/app/admin/_components/top-nav";
import { type UserRole } from "@/app/admin/lib/roles";
import { searchCandidates, type SearchResults, type SearchHit } from "./actions";

const PLACEHOLDER =
  "Full Stack Developer Next.js 5 years Lahore";

function fmt(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function highlight(text: string | null, keywords: string[]): React.ReactNode {
  if (!text) return <span className="text-gray-300">—</span>;
  if (keywords.length === 0) return text;

  // Build a single regex that matches any keyword; case-insensitive.
  const pattern = keywords
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(re);

  return parts.map((part, i) => {
    if (re.test(part)) {
      return (
        <span
          key={`${part}-${i}`}
          className="rounded bg-[#7E47FF]/15 px-0.5 font-semibold text-[#7E47FF]"
        >
          {part}
        </span>
      );
    }
    return <span key={`${part}-${i}`}>{part}</span>;
  });
}

function ResultCard({
  hit,
  keywords,
}: {
  hit: SearchHit;
  keywords: string[];
}) {
  const isApp = hit.source === "application";
  // Applications search by name/email; talent links open the drawer directly via id.
  const href = isApp
    ? `/admin/applications?search=${encodeURIComponent(hit.email ?? hit.name)}`
    : `/admin/talent?id=${encodeURIComponent(hit.id)}`;

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            {isApp ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                <span className="size-1.5 rounded-full bg-blue-500" />
                Application
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#49D7A7]/10 px-2.5 py-1 text-xs font-semibold text-[#1a9e73]">
                <span className="size-1.5 rounded-full bg-[#49D7A7]" />
                Talent
              </span>
            )}
            <span className="text-[10px] uppercase tracking-widest text-gray-300">
              {hit.matchCount} match{hit.matchCount === 1 ? "" : "es"}
            </span>
          </div>

          <p className="truncate font-heading text-base font-bold text-gray-900">
            {highlight(hit.name, keywords)}
          </p>

          {hit.job_role && (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-gray-500">
              <Briefcase className="size-3 shrink-0" strokeWidth={2} />
              {highlight(hit.job_role, keywords)}
            </p>
          )}

          {hit.headline && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500">
              {highlight(hit.headline, keywords)}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500">
            {hit.email && (
              <span className="flex items-center gap-1.5">
                <Mail className="size-3" strokeWidth={2} />
                <span className="truncate">{highlight(hit.email, keywords)}</span>
              </span>
            )}
            {hit.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="size-3" strokeWidth={2} />
                {hit.phone}
              </span>
            )}
            {hit.created_at && (
              <span className="text-gray-300">Added {fmt(hit.created_at)}</span>
            )}
          </div>

          {hit.matchedKeywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {hit.matchedKeywords.map((k) => (
                <span
                  key={k}
                  className="rounded-full bg-[#7E47FF]/10 px-2 py-0.5 text-[10px] font-medium text-[#7E47FF]"
                >
                  {k}
                </span>
              ))}
            </div>
          )}
        </div>

        <Link
          href={href}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
        >
          <ExternalLink className="size-3.5" strokeWidth={2} />
          View
        </Link>
      </div>
    </div>
  );
}

export function SearchClient({
  email,
  userRole,
}: {
  email: string;
  userRole: UserRole;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const r = await searchCandidates(query);
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f8f4f1]">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-xl px-8 py-8">
        <div className="mb-6">
          <p className="text-xs text-gray-400">Smart Search</p>
          <h1 className="font-heading text-2xl font-bold text-gray-900">
            Search candidates
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Searches across applications (CV text, notes, contact details) and talent profiles.
          </p>
        </div>

        {/* Search bar */}
        <form
          onSubmit={handleSearch}
          className="mb-8 flex gap-3 rounded-2xl bg-white p-3 shadow-sm"
        >
          <div className="flex flex-1 items-center gap-3 rounded-xl bg-gray-50 px-4">
            <SearchIcon className="size-4 shrink-0 text-gray-400" strokeWidth={2} />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search candidates… e.g. ${PLACEHOLDER}`}
              className="h-12 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="flex shrink-0 items-center gap-2 rounded-xl bg-[#7E47FF] px-6 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" strokeWidth={2} />
                Searching…
              </>
            ) : (
              <>
                <SearchIcon className="size-4" strokeWidth={2} />
                Search
              </>
            )}
          </button>
        </form>

        {error && (
          <div className="mb-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        {/* Initial / empty state */}
        {!loading && !results && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
            <SearchIcon className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-sm font-semibold text-gray-700">
              Type a search query to begin
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Job titles, skills, locations, years of experience — all welcome.
            </p>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !results && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-gray-100 bg-white py-20 text-center">
            <Loader2 className="mb-3 size-8 animate-spin text-[#7E47FF]" strokeWidth={2} />
            <p className="text-sm text-gray-500">Scanning applications and profiles…</p>
          </div>
        )}

        {/* Results */}
        {results && (
          <>
            {results.applications.length === 0 && results.talent.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
                <SearchIcon className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
                <p className="font-heading text-sm font-semibold text-gray-700">
                  No candidates found for your search
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Try fewer or broader keywords.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
                {/* Applications column */}
                <section>
                  <div className="mb-4 flex items-center gap-2">
                    <FileText className="size-4 text-gray-500" strokeWidth={2} />
                    <h2 className="font-heading text-sm font-bold uppercase tracking-widest text-gray-500">
                      Applications ({results.applications.length})
                    </h2>
                  </div>
                  {results.applications.length === 0 ? (
                    <p className="rounded-2xl bg-white px-5 py-8 text-center text-xs text-gray-400 shadow-sm">
                      No matching applications
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {results.applications.map((hit) => (
                        <ResultCard key={`app-${hit.id}`} hit={hit} keywords={results.keywords} />
                      ))}
                    </div>
                  )}
                </section>

                {/* Talent column */}
                <section>
                  <div className="mb-4 flex items-center gap-2">
                    <Users className="size-4 text-gray-500" strokeWidth={2} />
                    <h2 className="font-heading text-sm font-bold uppercase tracking-widest text-gray-500">
                      Talent Profiles ({results.talent.length})
                    </h2>
                  </div>
                  {results.talent.length === 0 ? (
                    <p className="rounded-2xl bg-white px-5 py-8 text-center text-xs text-gray-400 shadow-sm">
                      No matching profiles
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {results.talent.map((hit) => (
                        <ResultCard key={`talent-${hit.id}`} hit={hit} keywords={results.keywords} />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
