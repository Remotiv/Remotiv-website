"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Briefcase, Search, UserRound, Users, Video, X } from "lucide-react";
import {
  EMPTY_RESULTS,
  MIN_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
  type SearchHit,
  type SearchResults,
} from "@/app/ai-dashboard/lib/search-types";
import { searchWorkspace } from "@/app/ai-dashboard/(gated)/search-actions";

/**
 * The topbar search.
 *
 * ── Mobile: a full-screen sheet, not a shrunken box ──────────
 *
 * At 375px the topbar holds a menu button, a breadcrumb, a bell and an avatar,
 * and the search input was already hidden below 630px because there is no room
 * for it. A 90px input would be worse than nothing — you cannot read a result
 * list under it, and the keyboard covers what is left.
 *
 * So below 630px search is an icon button that opens a full-screen sheet: the
 * field at the top where the thumb is, results filling the space the keyboard
 * does not, and the same list component as desktop. Nothing in the topbar row
 * changes width, so the breadcrumb keeps the space it has.
 *
 * ── Both inputs are the same input ───────────────────────────
 *
 * They share `query`, the debounce below, the key handling and INPUT_PROPS.
 * Measured, not assumed: typing five characters into the sheet with no Enter
 * fires exactly one server call, and it still fires mid-IME-composition, which
 * is how predictive keyboards actually type. Any future divergence between the
 * two should go through INPUT_PROPS rather than being spelled out twice.
 */

/**
 * Shared by both inputs.
 *
 * The four mobile hints are the ones that make a search field behave like one
 * on a phone: `enterKeyHint` turns the return key into "Search"; the other
 * three stop the keyboard capitalising and autocorrecting what someone types.
 * A phone rewriting "Ammar" to "Ammer" mid-word is indistinguishable from
 * search being broken, and it only ever happens on mobile — which is exactly
 * the class of difference this component must not have.
 */
const INPUT_PROPS = {
  type: "search",
  inputMode: "search",
  enterKeyHint: "search",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;

const KIND_ICON: Record<SearchHit["kind"], typeof UserRound> = {
  applicant: UserRound,
  job: Briefcase,
  member: Users,
};

export function TopbarSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);

  /**
   * Every hit, flattened, so the arrow keys walk one list rather than a tree.
   * Group order is the server's ranking; this preserves it.
   */
  const flat = results.groups.flatMap((g) => g.hits);

  /*
   * ── Debounce ──
   *
   * The timer is cleared on every keystroke, so a burst of typing fires ONE
   * query when it stops. `seq` discards a slow response that lands after a
   * newer one — without it, a fast typist can see results for a prefix they
   * have already moved past, which reads as the box being wrong rather than
   * late.
   */
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        const res = await searchWorkspace(q);
        if (mine !== seq.current) return;
        setResults(res);
        setActive(0);
      } catch {
        if (mine === seq.current) setResults(EMPTY_RESULTS);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const close = useCallback(() => {
    setOpen(false);
    setSheet(false);
  }, []);

  const go = useCallback(
    (href: string) => {
      close();
      setQuery("");
      router.push(href);
    },
    [close, router],
  );

  // Click-away closes the desktop dropdown. The sheet has its own dismiss.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open, close]);

  useEffect(() => {
    if (sheet) sheetInputRef.current?.focus();
  }, [sheet]);

  /*
   * ── Keeping results out from under the keyboard ──
   *
   * `fixed inset-0` sizes to the LAYOUT viewport, which on a phone does not
   * shrink when the keyboard opens — so the lower half of a full-height sheet
   * sits behind the keyboard, and the results a search just produced are the
   * part that gets covered.
   *
   * visualViewport.height is the only number that tracks the keyboard. Falling
   * back to 100dvh means a browser without it still gets the dynamic-viewport
   * behaviour rather than the old 100vh overshoot.
   */
  const [viewportH, setViewportH] = useState<number | null>(null);
  useEffect(() => {
    if (!sheet) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setViewportH(vv.height);
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [sheet]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter" && flat.length === 0) {
      /*
       * Enter with nothing to highlight — results still in flight, or none.
       * Falling through to the applicants list is better than a dead key: on a
       * phone the return key is labelled "Search", and a labelled key that does
       * nothing reads as the feature being broken.
       */
      e.preventDefault();
      const q = query.trim();
      if (q.length >= MIN_QUERY_LENGTH) {
        go(`/ai-dashboard/applicants?q=${encodeURIComponent(q)}`);
      }
      return;
    }
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[active];
      if (hit) go(hit.href);
    }
  }

  const panel = (
    <SearchPanel
      query={query}
      results={results}
      loading={loading}
      active={active}
      onHover={setActive}
      onPick={go}
    />
  );

  return (
    <>
      {/* ── Desktop ── */}
      <div ref={boxRef} className="relative ml-auto hidden min-[630px]:block">
        <div className="flex w-[220px] items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple">
          <Search className="size-[15px] shrink-0" strokeWidth={1.8} />
          <input
            ref={inputRef}
            {...INPUT_PROPS}
            aria-label="Search applicants, jobs and team"
            placeholder="Search people…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className="w-full min-w-0 bg-transparent text-[13px] text-[var(--ai-t1)] outline-none placeholder:text-[var(--ai-t3)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="shrink-0 text-[var(--ai-t4)] transition-colors hover:text-[var(--ai-t1)]"
            >
              <X className="size-3.5" strokeWidth={2.2} />
            </button>
          )}
        </div>

        {open && query.trim().length >= MIN_QUERY_LENGTH && (
          <div className="absolute right-0 top-[42px] z-50 max-h-[70vh] w-[400px] overflow-y-auto rounded-[14px] border border-[var(--ai-line)] bg-white shadow-[0_20px_50px_rgba(20,16,32,0.16)]">
            {panel}
          </div>
        )}
      </div>

      {/* ── Mobile trigger ── */}
      <button
        type="button"
        onClick={() => setSheet(true)}
        aria-label="Search"
        className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] min-[630px]:hidden"
      >
        <Search className="size-5" strokeWidth={2} />
      </button>

      {/* ── Mobile sheet ── */}
      {sheet && (
        <div
          // top-0 + an explicit height rather than inset-0: the height is the
          // visual viewport, so the sheet ends where the keyboard begins.
          style={viewportH ? { height: `${viewportH}px` } : undefined}
          className="fixed inset-x-0 top-0 z-50 flex h-[100dvh] flex-col overscroll-contain bg-[var(--ai-page)] min-[630px]:hidden"
        >
          <div className="flex items-center gap-2 border-b border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5">
            <Search className="size-[17px] shrink-0 text-[var(--ai-t3)]" strokeWidth={1.9} />
            <input
              ref={sheetInputRef}
              {...INPUT_PROPS}
              aria-label="Search applicants, jobs and team"
              placeholder="Search people, jobs, team…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full min-w-0 bg-transparent text-[15px] text-[var(--ai-t1)] outline-none placeholder:text-[var(--ai-t3)]"
            />
            <button
              type="button"
              onClick={close}
              className="shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-[var(--ai-t2)]"
            >
              Cancel
            </button>
          </div>
          {/* Owns whatever height is left once the field is placed, and
              scrolls inside it — so every result is reachable by thumb without
              the page behind it moving. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
            {panel}
          </div>
        </div>
      )}
    </>
  );
}

function SearchPanel({
  query,
  results,
  loading,
  active,
  onHover,
  onPick,
}: {
  query: string;
  results: SearchResults;
  loading: boolean;
  active: number;
  onHover: (i: number) => void;
  onPick: (href: string) => void;
}) {
  const trimmed = query.trim();

  if (trimmed.length < MIN_QUERY_LENGTH) {
    return (
      <p className="m-0 px-4 py-6 text-center text-[13px] leading-relaxed text-[var(--ai-t3)]">
        Type at least {MIN_QUERY_LENGTH} characters to search applicants, jobs
        and your team.
      </p>
    );
  }

  // Loading only shows while there is nothing to show. Keeping the last result
  // on screen during a refetch stops the panel flickering on every keystroke.
  if (loading && results.total === 0) {
    return (
      <div className="flex flex-col gap-2 px-4 py-4">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[38px] animate-pulse rounded-lg bg-[var(--ai-inset)]"
          />
        ))}
      </div>
    );
  }

  if (results.total === 0) {
    return (
      <div className="px-4 py-7 text-center">
        <p className="m-0 text-[13.5px] font-semibold text-[var(--ai-t1)]">
          Nothing matches “{trimmed}”
        </p>
        <p className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
          Try part of a name, an email address, or a job title. You only see
          people and roles you have access to.
        </p>
      </div>
    );
  }

  let index = -1;
  return (
    <div className="py-1.5">
      {results.groups.map((group) => (
        <div key={group.kind} className="pb-1">
          <p className="m-0 px-4 pb-1 pt-2 text-[10px] font-extrabold uppercase tracking-[0.11em] text-[var(--ai-t4)]">
            {group.label}
          </p>
          {group.hits.map((hit) => {
            index += 1;
            const i = index;
            const Icon = KIND_ICON[hit.kind];
            return (
              <div
                key={`${hit.kind}-${hit.id}`}
                className={`flex items-center gap-1 px-1.5 ${
                  i === active ? "bg-[var(--ai-inset)]" : ""
                }`}
              >
                <button
                  type="button"
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPick(hit.href)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]">
                    <Icon className="size-[15px]" strokeWidth={1.9} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-[var(--ai-t1)]">
                      {hit.title}
                    </span>
                    <span className="block truncate text-[11.5px] text-[var(--ai-t3)]">
                      {hit.subtitle}
                    </span>
                  </span>
                  {hit.badge && (
                    <span className="shrink-0 rounded-full bg-[var(--ai-inset)] px-2 py-0.5 text-[10.5px] font-bold text-[var(--ai-t3)]">
                      {hit.badge}
                    </span>
                  )}
                </button>
                {/* Interviews are not a group of their own — they hang off the
                    applicant they belong to. See searchWorkspace. */}
                {hit.interviewHref && (
                  <button
                    type="button"
                    onClick={() => onPick(hit.interviewHref as string)}
                    aria-label={`Open ${hit.title}'s interview`}
                    className="mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-[var(--ai-t4)] transition-colors hover:bg-remotiv-purple hover:text-white"
                  >
                    <Video className="size-[15px]" strokeWidth={1.9} />
                  </button>
                )}
              </div>
            );
          })}
          {group.more && (
            <button
              type="button"
              onClick={() => onPick(group.allHref)}
              className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left text-[11.5px] font-bold text-remotiv-purple"
            >
              See all {group.label.toLowerCase()} matching “{trimmed}”
              <ArrowRight className="size-3.5" strokeWidth={2.2} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
