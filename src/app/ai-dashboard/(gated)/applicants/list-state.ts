import {
  APPLICANT_PAGE_SIZE,
  type ApplicantSort,
  type CompanyApplicantPage,
  type CompanyApplicantQuery,
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/app/ai-dashboard/lib/applicant-types";

/**
 * Which page of applicants the list is allowed to display, and when.
 *
 * ── Why this exists ─────────────────────────────────────────
 *
 * Until this pass the list was a prop. Every filter, the sort and the page
 * number were applied to an array already in memory, so the rendered rows were
 * a pure function of state and could be neither stale nor absent.
 *
 * Reading one page from the database makes the rows a RESPONSE, and inherits
 * every failure mode counts-state.ts enumerates for the population figures —
 * a late response overwriting a newer one, one filter's data presented as
 * another's, and a failed read rendered as emptiness. The reasoning there
 * applies here unchanged and is not repeated; see that file.
 *
 * Two of them bite harder on rows than on numbers:
 *
 *   - A stale COUNT is a wrong number next to a label. Stale ROWS are a list
 *     the reader will click. So `updating` is not decoration here: the surface
 *     has to say the rows belong to a filter it has moved off, and the reader
 *     has to be able to tell.
 *
 *   - A failed count draws an em dash. A failed page has no em dash available
 *     — zero rows and "no results" are the same picture — so `failed` is
 *     carried separately from an empty page and the empty copy branches on it.
 *     "No one matches that search" over a read that did not happen is the lie
 *     this field exists to prevent.
 *
 * And one is new. The page number is now an INPUT to the read, so it can be
 * out of range in a way an in-memory slice never was: `.slice()` past the end
 * answers `[]`, a `.range()` past the end is an error. The clamp therefore
 * cannot happen before the request — the total that defines the range arrives
 * with the response. See `clampPage`.
 *
 * Pure on purpose, for the reason given in counts-state.ts: there is no DOM
 * test runner here, so a decision left in the component could only be checked
 * by matching source text, which proves nothing about behaviour.
 */

/**
 * How long to wait after a keystroke before asking the server.
 *
 * Search was instant and local; it is now a round trip. Without a delay the
 * list issues one request per character and the reader watches the answer to a
 * prefix of what they typed. The responses are sequence-guarded regardless, so
 * this buys request count rather than correctness.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/** The filter, sort and page a set of rows was read for. Equal keys mean interchangeable. */
export type ListKey = string;

/**
 * Everything the list read depends on.
 *
 * "Review top 10" is deliberately NOT in here. It is a view mode over its own
 * bounded read of the whole population — the same read the "Top match" chips
 * need whether or not the mode is on — so folding it in would both invalidate
 * a page that is still perfectly good and ask for the top ten twice.
 */
export type ListRequest = {
  jobId: string | null;
  search: string;
  stage: PipelineStage | null;
  flaggedOnly: boolean;
  sort: ApplicantSort;
  page: number;
};

/**
 * The filter half of a request, without the sort or the page.
 *
 * The top-scored read is ordered by score by definition and limited to ten, so
 * neither the display sort nor the page number changes its answer — but every
 * filter does. Keying it on the whole request would re-read the top ten on
 * each page turn, and the chips would flicker for no reason.
 */
export function filterKey(r: ListRequest): ListKey {
  return JSON.stringify([r.jobId ?? "all", r.search.trim(), r.stage ?? "all", r.flaggedOnly]);
}

/**
 * The request identity, as a string.
 *
 * Every field that reaches the server is in it, `page` included — unlike
 * counts, where the figures describe a population the page number does not
 * narrow. Two requests with equal keys ask for the same rows, so either
 * answer will do; unequal keys must never settle on each other.
 *
 * `search` is trimmed but not lowercased: the server match is already
 * case-insensitive, so folding here would make "Ana" and "ana" the same key —
 * which they are — but it would also hide a trailing-space change that does
 * alter the tokens. Trim is the normalisation the server applies too.
 */
export function listKey(r: ListRequest): ListKey {
  // JSON rather than a delimiter join: a job title or a search term containing
  // the delimiter would otherwise collide two different requests into one key.
  return JSON.stringify([
    r.jobId ?? "all",
    r.search.trim(),
    r.stage ?? "all",
    r.flaggedOnly,
    r.sort,
    r.page,
  ]);
}

/** The query the server action is called with, derived from the same request. */
export function listQueryFor(r: ListRequest): CompanyApplicantQuery {
  const q: CompanyApplicantQuery = { sort: r.sort, page: r.page };
  if (r.jobId) q.jobId = r.jobId;
  const search = r.search.trim();
  if (search) q.search = search;
  if (r.stage) q.stage = r.stage;
  if (r.flaggedOnly) q.flaggedOnly = true;
  return q;
}

export type ListState = {
  /** The request the list is displaying now. */
  key: ListKey;
  /** The sequence number of the newest request issued. Only it may settle. */
  expected: number;
  /** A request for `key` is outstanding. */
  pending: boolean;
  /** The newest page accepted, kept on screen across a refetch. */
  shown: CompanyApplicantPage | null;
  /** The key `shown` was read for — unequal to `key` means it is stale. */
  shownKey: ListKey | null;
  /** The newest accepted response for `key` was a failure. */
  failed: boolean;
};

/**
 * The state the page starts in, holding the server pass's own answer.
 *
 * A null page is `failed`, not an empty slate, for the reason seedCounts gives:
 * the page knows the read did not work and must say so rather than sit in
 * something that looks like loading.
 */
export function seedList(key: ListKey, page: CompanyApplicantPage | null): ListState {
  return {
    key,
    expected: 0,
    pending: false,
    shown: page,
    shownKey: page ? key : null,
    failed: page === null,
  };
}

/**
 * A request is going out. `seq` must come from a monotonic counter the caller
 * owns — see requestCounts for why the reducer cannot mint it and stay pure.
 *
 * `shown` deliberately survives a key change, so the table holds the previous
 * rows while the new ones load instead of collapsing to empty on every
 * keystroke. `listView` reports that as `updating`, and the surface must show
 * it: these rows answer a question the reader has already moved off.
 */
export function requestList(state: ListState, key: ListKey, seq: number): ListState {
  return {
    ...state,
    key,
    expected: seq,
    pending: true,
    // A previous failure is not evidence about this request.
    failed: false,
  };
}

/**
 * A response came back. Applied only if it answers the newest request.
 *
 * Both the key and the sequence are checked, for the reason settleCounts
 * gives: the sequence is the mechanism and the key is the statement of intent.
 */
export function settleList(
  state: ListState,
  response: { key: ListKey; seq: number; page: CompanyApplicantPage | null },
): ListState {
  if (response.key !== state.key || response.seq !== state.expected) return state;

  if (!response.page) {
    // Last-known rows are dropped rather than left under new filters: a table
    // still showing job A's applicants after a failed read for job B is
    // asserting they match job B. Nothing on screen could correct that.
    return { ...state, pending: false, failed: true, shown: null, shownKey: null };
  }

  return {
    ...state,
    pending: false,
    failed: false,
    shown: response.page,
    shownKey: response.key,
  };
}

/**
 * Drop a deleted applicant from the page on screen, before the refetch lands.
 *
 * The total comes down with it, so the pager and "of 128" do not keep counting
 * someone who is gone. It is decremented rather than recomputed because the
 * true figure needs a round trip, and a count that stays put for the length of
 * one is a count the reader can see is wrong.
 *
 * The page does NOT backfill: removing row 7 of 20 leaves 19 until the server
 * answers. Pulling row 21 up would need a read anyway, and the refetch that
 * follows a delete is already doing it.
 */
export function dropRow(state: ListState, id: string): ListState {
  if (!state.shown) return state;
  const rows = state.shown.rows.filter((r) => r.id !== id);
  if (rows.length === state.shown.rows.length) return state;
  return {
    ...state,
    shown: {
      rows,
      total: state.shown.total === null ? null : Math.max(0, state.shown.total - 1),
    },
  };
}

/** What the list renders. */
export type ListView = {
  /** The page's rows, or none when the read failed or has not landed. */
  rows: CompanyApplicantPage["rows"];
  /** The filtered population. Null means unreadable, never zero. */
  total: number | null;
  /** Pages at the current page size, or null when the total is unknown. */
  pageCount: number | null;
  /** The rows belong to a request the reader has moved off, or one is in flight. */
  updating: boolean;
  /** The newest read failed. Distinct from a legitimately empty page. */
  failed: boolean;
};

const NO_ROWS: CompanyApplicantPage["rows"] = [];

/**
 * Collapse the state into what the table draws.
 *
 * A failed read and a first paint both yield no rows and a null total, which
 * is correct — neither knows anything. They differ in `failed`, which is what
 * the empty copy branches on, not in the figures.
 */
export function listView(state: ListState): ListView {
  const shown = state.failed ? null : state.shown;
  const total = shown?.total ?? null;
  return {
    rows: shown?.rows ?? NO_ROWS,
    total,
    pageCount: total === null ? null : Math.max(1, Math.ceil(total / APPLICANT_PAGE_SIZE)),
    updating: state.pending || (shown !== null && state.shownKey !== state.key),
    failed: state.failed,
  };
}

/**
 * The page to ask for next, given what the last answer said the total was.
 *
 * Returns `page` unchanged when it is in range, and the last populated page
 * when it is past the end. The clamp is deliberately AFTER the read rather
 * than before it: the total that defines the range is what the read returns.
 *
 * It is the mechanism that keeps a stale `?page=12` from rendering as a failure.
 * `fetchCompanyApplicants` answers an out-of-range range with no rows and a
 * true total precisely so this function has something to clamp against — the
 * raw PostgREST answer is a 416, which postgrest-js turns into an error with
 * the count discarded, and which would reach the reader as "couldn't load"
 * rather than as a page that does not exist.
 *
 * A null total yields `page` unchanged: an unreadable total is no evidence the
 * page is wrong, and clamping to 1 on a failed read would move the reader.
 */
export function clampPage(page: number, total: number | null): number {
  const asked = Math.max(1, Math.trunc(page) || 1);
  if (total === null) return asked;
  const last = Math.max(1, Math.ceil(total / APPLICANT_PAGE_SIZE));
  return Math.min(asked, last);
}

/**
 * The 1-based index of the page's first row, for "Showing 21–40 of 128".
 *
 * Zero when there are no rows, so the surface can omit the range rather than
 * claim to be showing row 1 of nothing.
 */
export function rangeStart(page: number, rowCount: number): number {
  if (rowCount === 0) return 0;
  return (Math.max(1, page) - 1) * APPLICANT_PAGE_SIZE + 1;
}

/*
 * ── The address bar ─────────────────────────────────────────
 *
 * The filters used to live only in component state, so the URL described the
 * route and nothing about what was on screen. Three things followed, and all
 * three are what this codec exists to fix:
 *
 *   - A refresh threw the reader back to page 1 of everybody. That was
 *     survivable while the browser held the whole population and re-filtering
 *     was free; it is now twenty rows read under a filter the reload forgot.
 *   - Back did not undo a filter. It left the page, because no filter change
 *     had ever put an entry on the stack to go back to.
 *   - A filtered view could not be sent to a colleague.
 *
 * Making the URL the source of truth is what fixes all three at once: the
 * server pass decodes it for the first paint, the client derives its state
 * from it, and Back/Forward are then just two more ways the URL changes.
 *
 * This codec is the single definition of that mapping, shared by both sides —
 * `page.tsx` decodes the request it reads, the client decodes the request it
 * renders. Two spellings of the same mapping would drift, and the drift would
 * show as a first paint that disagrees with the URL that produced it.
 *
 * Pure, and params in rather than a URL, so the whole of it is testable: a
 * decode is a function from a query string to a request, which is exactly the
 * shape a `node --test` file can state.
 */

/**
 * Just enough of `URLSearchParams` to decode with.
 *
 * Both a plain instance and the `ReadonlyURLSearchParams` the `useSearchParams`
 * hook returns satisfy it, so one function serves the server's plain object
 * (wrapped) and the client's hook without either being converted first.
 */
export type ParamReader = { get(name: string): string | null };

/** The params this list owns. Anything else in the query string belongs to someone else. */
export const LIST_PARAM_NAMES = ["q", "job", "stage", "flagged", "sort", "page", "top"] as const;

/**
 * Longest search term accepted from the address bar.
 *
 * `searchTokens` already bounds the NUMBER of filters a term becomes, which is
 * what keeps a pasted paragraph from becoming sixty `or=` parameters. It does
 * not bound their LENGTH, and the address bar is hand-editable, so six
 * thousand-character tokens would still assemble a request URL that fails as a
 * whole. Truncating here widens the match rather than narrowing it — a prefix
 * matches a superset — so the failure direction stays "too many results".
 */
export const SEARCH_PARAM_MAX = 120;

/**
 * Highest page number accepted from the address bar.
 *
 * A million pages is twenty million applicants, so no real request is above
 * it. What is above it is a hand-edited URL, and the number matters because the
 * page becomes a byte range: `?page=1e21` makes `from` large enough that
 * `String()` renders it in exponential notation, and PostgREST answers a
 * malformed Range header with an error rather than the out-of-range code the
 * server knows how to clamp. So the reader would get "couldn't load" where they
 * asked for a page that does not exist.
 *
 * Over the cap falls back to page 1, the same rule every other invalid field
 * here follows — not to the cap, which would be a page just as fictional.
 */
export const PAGE_PARAM_MAX = 1_000_000;

/**
 * A job filter has to be a job id or nothing.
 *
 * Not politeness: `?job=` is reader-supplied and reaches `.eq("job_id", …)`.
 * The scope filter still applies either way, so a junk value cannot cross a
 * tenant boundary — it would simply make every read error on a malformed uuid
 * and render as "couldn't load". Rejecting it here answers the unfiltered list
 * instead, which is what the reader asked for minus the part that was nonsense.
 */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything about the list that the URL carries.
 *
 * `topOnly` rides along despite not being part of `ListRequest` — it is a view
 * mode over its own read, not a filter, and keeping it out of the request is
 * what stops it invalidating a page that is still good. But it IS part of what
 * the reader is looking at, so a link that omitted it would not reproduce the
 * screen it was copied from.
 */
export type ListUrlState = { request: ListRequest; topOnly: boolean };

/**
 * What the address bar is asking for.
 *
 * Every field is validated and every invalid one falls back to its default
 * rather than being passed on: this is reader-supplied input, and the two
 * places it lands are a server action's query and the component's own state.
 * An unrecognised stage is the clearest case — forwarded, it would filter on a
 * value no row can hold and show an empty list that looks like a real answer.
 */
/**
 * Next's `searchParams` object, as something `decodeListUrl` can read.
 *
 * The page receives a plain object, not a `URLSearchParams`, and a repeated
 * param arrives as an array. The array form is DROPPED rather than joined or
 * sampled: `?stage=applied&stage=hired` states two filters where the list
 * supports one, and taking either is a guess about which was meant — the
 * browser-side `URLSearchParams.get` answers the first, so joining here would
 * also make the server disagree with the client about the same URL.
 *
 * Here rather than inline in `page.tsx` so the refresh path is testable end to
 * end: a query string in, the served request out, through the same codec the
 * client renders from.
 */
export function listParamsFrom(
  raw: Record<string, string | string[] | undefined>,
): URLSearchParams {
  return new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v] as [string, string]] : [],
    ),
  );
}

export function decodeListUrl(params: ParamReader): ListUrlState {
  const stage = params.get("stage");
  const job = params.get("job");
  const pageRaw = Number(params.get("page") ?? 1);

  return {
    request: {
      jobId: job && JOB_ID_PATTERN.test(job) ? job : null,
      search: (params.get("q") ?? "").trim().slice(0, SEARCH_PARAM_MAX),
      stage: isPipelineStage(stage) ? stage : null,
      flaggedOnly: params.get("flagged") === "1",
      // Any third value is Best Match, because Best Match is the default and
      // an unreadable sort is not evidence the reader wanted the other one.
      sort: params.get("sort") === "newest" ? "newest" : "best",
      page:
        Number.isFinite(pageRaw) && pageRaw >= 1 && pageRaw <= PAGE_PARAM_MAX
          ? Math.floor(pageRaw)
          : 1,
    },
    topOnly: params.get("top") === "1",
  };
}

function isPipelineStage(value: string | null): value is PipelineStage {
  return value !== null && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/**
 * The query string for a state, preserving every param the list does not own.
 *
 * `?applicant=` and `?tab=` are the ones that matter today: the panel writes
 * them, and a filter change must not close the open candidate by dropping them.
 *
 * Defaults are OMITTED rather than spelled out, which is what keeps the clean
 * view's URL clean — and makes the encoding canonical, since one state has
 * exactly one spelling however the params arrived. `decode(encode(s)) === s`
 * then holds, and so does `encode(decode(encode(s))) === encode(s)`; both are
 * tested, because a codec that is not a round trip turns Back into a mutation.
 */
export function encodeListUrl(state: ListUrlState, current: string): string {
  const params = new URLSearchParams(current);
  // Cleared first, then written in a fixed order: setting in place would leave
  // ours wherever they happened to be and make the same state produce two
  // different strings.
  for (const name of LIST_PARAM_NAMES) params.delete(name);

  const { request: r } = state;
  const search = r.search.trim().slice(0, SEARCH_PARAM_MAX);
  if (search) params.set("q", search);
  if (r.jobId) params.set("job", r.jobId);
  if (r.stage) params.set("stage", r.stage);
  if (r.flaggedOnly) params.set("flagged", "1");
  if (r.sort !== "best") params.set("sort", r.sort);
  if (r.page > 1) params.set("page", String(r.page));
  if (state.topOnly) params.set("top", "1");

  return params.toString();
}

export const PANEL_PARAM_NAMES = ["applicant", "tab"] as const;

/**
 * The query string for a panel that is open on `openId`, or closed when it is
 * null.
 *
 * The closed case has to spell BOTH params out of the URL. Leaving `?tab=`
 * behind was harmless to the panel but not to the codec: the list params are
 * cleared and rewritten by `encodeListUrl`, so a stray param that nothing
 * clears accumulates, and two routes to the same state stop producing the same
 * string — which is the property Back depends on.
 *
 * Writing the params rather than mutating a URL in place so the decision is
 * reachable from a test; the caller does the `replaceState`.
 */
export function encodePanelUrl(current: string, openId: string | null, tab: string | null): string {
  const params = new URLSearchParams(current);
  for (const name of PANEL_PARAM_NAMES) params.delete(name);
  if (openId) {
    params.set("applicant", openId);
    if (tab) params.set("tab", tab);
  }
  return params.toString();
}

/*
 * ── Stepping through the population ────────────────────────
 *
 * Prev/next used to be an index into an array holding everybody, so stepping
 * ran from the first match to the last and the page number was a presentation
 * detail it moved under the reader. The array is now twenty rows, and the
 * naive port stopped the arrows at the page edges — a reader working a
 * shortlist of sixty hit a dead end every twenty and had to close the panel,
 * turn the page and reopen.
 *
 * So the sequence prev/next walks is the FILTERED POPULATION, addressed by its
 * index, and the page is derived from the index rather than the other way
 * round. A step that lands outside the page on screen is a page turn plus an
 * offset to open once it arrives, which is what `StepTarget` carries: the
 * request to issue, and where in its answer the candidate will be.
 *
 * It cannot be synchronous — the destination row is in a page that has not
 * been read — so the two halves are separate functions. `stepTarget` decides
 * where to go, `stepRow` decides when the answer is the one to open.
 */

/** Where a row sits in the filtered population: 0-based, counting from page 1. */
export function populationIndex(page: number, offset: number): number {
  return (Math.max(1, Math.trunc(page) || 1) - 1) * APPLICANT_PAGE_SIZE + offset;
}

/** A page to read, and the row within it to open when it lands. */
export type StepTarget = { request: ListRequest; offset: number };

/**
 * Where prev/next goes from the row at `offset` of `from`'s page.
 *
 * Null means there is nowhere to go and the control must say so: before the
 * first row, past the last, or — the case worth naming — when the population
 * size is UNKNOWN. A null total is an unreadable count, and "step forward"
 * then has no answer that can be checked against anything. Guessing the next
 * page exists would open an empty panel on a read that already failed.
 */
export function stepTarget(
  from: ListRequest,
  offset: number,
  delta: number,
  total: number | null,
): StepTarget | null {
  if (total === null) return null;
  const index = populationIndex(from.page, offset) + delta;
  if (index < 0 || index >= total) return null;
  return {
    request: { ...from, page: Math.floor(index / APPLICANT_PAGE_SIZE) + 1 },
    offset: index % APPLICANT_PAGE_SIZE,
  };
}

/**
 * The row a pending step should open, or null to keep waiting.
 *
 * Three refusals, and each one is a wrong panel if it is missing:
 *
 *   - `updating`: the rows on screen are still the page the reader stepped
 *     OFF. Reading an offset out of them opens whoever happens to sit at that
 *     index of the wrong page.
 *   - the key: the rows must have been read for exactly this request. A filter
 *     that moved while the page was in flight makes the offset meaningless,
 *     and page numbers alone cannot tell — page 2 of one filter and page 2 of
 *     another are the same number and different people.
 *   - a short page: the offset can be past the end if rows were deleted
 *     between the step and the read. The last row of the landed page is the
 *     nearest honest answer to "forward"; only a genuinely empty page gives up.
 */
export function stepRow<T extends { id: string }>(
  target: StepTarget | null,
  shown: { key: ListKey | null; updating: boolean; rows: readonly T[] },
): T | null {
  if (!target || shown.updating) return null;
  if (shown.key !== listKey(target.request)) return null;
  return shown.rows[target.offset] ?? shown.rows[shown.rows.length - 1] ?? null;
}
