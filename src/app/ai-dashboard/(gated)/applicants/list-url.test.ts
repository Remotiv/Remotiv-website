/**
 * The address bar as the list's only source of truth, executed.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-url.test.ts"
 *
 * ── What is at stake in a codec ──────────────────────────────
 *
 * The filters moved out of component state and into the URL, which buys the
 * refresh, Back/Forward and a shareable link — and makes this one function the
 * thing all three depend on. It is tested here rather than through the
 * component because there is no DOM runner in this repo, and because the
 * failures worth catching are all statements about the function:
 *
 *   - IT IS READER INPUT. `?stage=`, `?job=` and `?q=` are hand-editable and
 *     land in a server action's query. An unvalidated stage filters on a value
 *     no row can hold, which renders an empty list that looks like a real
 *     answer; an unvalidated job id reaches `.eq("job_id", …)` as a malformed
 *     uuid and errors the whole read. So the decode tests assert the fallback
 *     AND that the junk does not reach `listQueryFor`.
 *
 *   - IT IS READ ON BOTH SIDES. `page.tsx` decodes the URL to pick the page it
 *     serves; the client decodes the same URL to know what it is rendering. One
 *     function, so they cannot disagree — but only if the function is a round
 *     trip. If `decode(encode(s))` is not `s`, then writing a filter and
 *     reading it back gives a different filter, and Back becomes a mutation
 *     rather than a return.
 *
 *   - IT SHARES THE QUERY STRING. `?applicant=` and `?tab=` belong to the
 *     panel. A filter change that dropped them would close the open candidate,
 *     so preservation of foreign params is asserted, not assumed.
 *
 * Tenancy is NOT this function's job and no test here implies otherwise: the
 * company filter and the job-scope filter are applied server-side in
 * `listQuery`, and `list-read-scope.test.ts` is where that is proven. A junk
 * `?job=` cannot cross a tenant boundary — it can only error the read, which
 * is why it is rejected here as a usability fix rather than a security one.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const {
  LIST_PARAM_NAMES,
  PAGE_PARAM_MAX,
  PANEL_PARAM_NAMES,
  SEARCH_PARAM_MAX,
  decodeListUrl,
  encodeListUrl,
  encodePanelUrl,
  listKey,
  listParamsFrom,
  listQueryFor,
} = await import("./list-state.ts");
const { PIPELINE_STAGES } = await import("../../lib/applicant-types.ts");

const JOB = "0f6b2a1c-8d4e-4b7a-9c31-5e2f8a0d1b43";

const decode = (qs: string) => decodeListUrl(new URLSearchParams(qs));

const DEFAULTS = {
  request: { jobId: null, search: "", stage: null, flaggedOnly: false, sort: "best", page: 1 },
  topOnly: false,
};

/* ── decode: the empty and the full case ─────────────────────── */

test("an empty query string decodes to the unfiltered first page", () => {
  assert.deepEqual(decode(""), DEFAULTS);
});

test("every field the URL carries is decoded", () => {
  assert.deepEqual(
    decode(`q=sarah&job=${JOB}&stage=interview&flagged=1&sort=newest&page=4&top=1`),
    {
      request: {
        jobId: JOB,
        search: "sarah",
        stage: "interview",
        flaggedOnly: true,
        sort: "newest",
        page: 4,
      },
      topOnly: true,
    },
  );
});

test("the param names the codec claims to own are exactly the ones it reads", () => {
  // Each name, set to a non-default value on its own, must change the decode.
  // A name in the list that changes nothing is a param this codec does not
  // really own, and `encodeListUrl` would be deleting a stranger's state.
  const nonDefault = {
    q: "x",
    job: JOB,
    stage: "hired",
    flagged: "1",
    sort: "newest",
    page: "3",
    top: "1",
  };
  for (const name of LIST_PARAM_NAMES) {
    assert.notDeepEqual(
      decode(`${name}=${encodeURIComponent(nonDefault[name])}`),
      DEFAULTS,
      `?${name}= decoded to the defaults — the codec owns a param it ignores`,
    );
  }
});

/* ── decode: reader-supplied values that must not be forwarded ── */

test("an unrecognised stage falls back to all AND never reaches the query", () => {
  for (const junk of ["ghosted", "APPLIED", "", "applied,hired", "null", "__proto__"]) {
    const { request } = decode(`stage=${encodeURIComponent(junk)}`);
    assert.equal(request.stage, null, `stage=${junk} survived the decode`);
    assert.equal("stage" in listQueryFor(request), false, `stage=${junk} reached the server query`);
  }
});

test("every real stage IS accepted, so the guard is not just refusing everything", () => {
  for (const stage of PIPELINE_STAGES) {
    assert.equal(decode(`stage=${stage}`).request.stage, stage);
    assert.equal(listQueryFor(decode(`stage=${stage}`).request).stage, stage);
  }
});

test("a malformed job id falls back to all jobs AND never reaches the query", () => {
  for (const junk of [
    "all",
    "123",
    `${JOB}x`,
    JOB.slice(0, -1),
    "0f6b2a1c8d4e4b7a9c315e2f8a0d1b43",
    "'; drop table applications; --",
  ]) {
    const { request } = decode(`job=${encodeURIComponent(junk)}`);
    assert.equal(request.jobId, null, `job=${junk} survived the decode`);
    assert.equal("jobId" in listQueryFor(request), false, `job=${junk} reached the server query`);
  }
});

test("a job id in upper case is the same id", () => {
  assert.equal(decode(`job=${JOB.toUpperCase()}`).request.jobId, JOB.toUpperCase());
});

test("only the exact string 1 turns a boolean param on", () => {
  for (const almost of ["true", "yes", "0", "on", "1 ", ""]) {
    assert.equal(decode(`flagged=${encodeURIComponent(almost)}`).request.flaggedOnly, false);
    assert.equal(decode(`top=${encodeURIComponent(almost)}`).topOnly, false);
  }
  assert.equal(decode("flagged=1").request.flaggedOnly, true);
  assert.equal(decode("top=1").topOnly, true);
});

test("an unreadable sort is Best Match, not Newest", () => {
  // Best Match is the default, and a sort nobody can read is not evidence the
  // reader wanted the other one.
  for (const junk of ["", "oldest", "best ", "NEWEST"]) {
    assert.equal(decode(`sort=${encodeURIComponent(junk)}`).request.sort, "best");
  }
  assert.equal(decode("sort=newest").request.sort, "newest");
});

test("a search term is trimmed, and a long one is truncated rather than refused", () => {
  assert.equal(decode("q=%20%20sarah%20%20").request.search, "sarah");
  const long = "a".repeat(SEARCH_PARAM_MAX + 500);
  const got = decode(`q=${long}`).request.search;
  assert.equal(got.length, SEARCH_PARAM_MAX);
  // A prefix matches a SUPERSET of what the full term would, so the failure
  // direction is "too many results" rather than a silently narrowed list.
  assert.equal(long.startsWith(got), true);
});

test("a page that is not a page is page 1", () => {
  for (const junk of ["0", "-3", "abc", "", "NaN", "Infinity", "1e999", " ", "null"]) {
    assert.equal(decode(`page=${encodeURIComponent(junk)}`).request.page, 1, `page=${junk}`);
  }
});

test("a fractional page is floored, not rounded", () => {
  assert.equal(decode("page=2.7").request.page, 2);
  assert.equal(decode("page=1.999").request.page, 1);
});

test("a page above the cap is page 1, so no read is issued for an exponential range", () => {
  /*
   * The page becomes a byte offset: at 1e21 `String(from)` is "2e+22", which
   * PostgREST rejects as a malformed Range header — an error, not the
   * out-of-range code the server knows how to answer with a true total. So a
   * hand-edited URL would render "couldn't load" instead of a clamp.
   */
  assert.equal(decode(`page=${PAGE_PARAM_MAX}`).request.page, PAGE_PARAM_MAX);
  assert.equal(decode(`page=${PAGE_PARAM_MAX + 1}`).request.page, 1);
  assert.equal(decode("page=1e21").request.page, 1);
  assert.equal(decode(`page=${Number.MAX_SAFE_INTEGER}`).request.page, 1);
});

test("a repeated param takes the first, and does not become two filters", () => {
  // `?stage=applied&stage=hired` states two filters where the list supports
  // one. URLSearchParams.get answers the first; what matters is that the
  // result is a single valid stage rather than a joined string.
  assert.equal(decode("stage=applied&stage=hired").request.stage, "applied");
});

/* ── encode: canonical, and not a landlord ───────────────────── */

test("the default state encodes to nothing, so a clean view has a clean URL", () => {
  assert.equal(encodeListUrl(DEFAULTS, ""), "");
});

test("each non-default field appears, and page 1 never does", () => {
  const full = {
    request: {
      jobId: JOB,
      search: "sarah",
      stage: "interview",
      flaggedOnly: true,
      sort: "newest",
      page: 4,
    },
    topOnly: true,
  };
  const qs = encodeListUrl(full, "");
  for (const name of LIST_PARAM_NAMES) {
    assert.equal(new URLSearchParams(qs).has(name), true, `${name} missing from the encode`);
  }
  const atPageOne = encodeListUrl({ ...full, request: { ...full.request, page: 1 } }, "");
  assert.equal(new URLSearchParams(atPageOne).has("page"), false);
});

test("params the list does not own survive a filter change", () => {
  // The panel writes ?applicant= and ?tab=. Dropping them here would close the
  // open candidate every time a tab was clicked.
  const qs = encodeListUrl(
    { ...DEFAULTS, request: { ...DEFAULTS.request, stage: "hired" } },
    "applicant=abc&tab=screening&utm_source=email",
  );
  const params = new URLSearchParams(qs);
  assert.equal(params.get("applicant"), "abc");
  assert.equal(params.get("tab"), "screening");
  assert.equal(params.get("utm_source"), "email");
  assert.equal(params.get("stage"), "hired");
});

test("a state no longer in force leaves the URL", () => {
  // Returning to All must DELETE ?stage=, not leave the old one beside the new
  // view. The in-place form of this bug shows as a filter that cannot be
  // cleared, only replaced.
  const qs = encodeListUrl(DEFAULTS, `stage=hired&flagged=1&page=9&top=1&job=${JOB}&q=sarah`);
  assert.equal(qs, "");
});

test("one state has exactly one spelling, whatever order the params arrived in", () => {
  const state = {
    request: {
      jobId: JOB,
      search: "sarah",
      stage: "offer",
      flaggedOnly: true,
      sort: "newest",
      page: 3,
    },
    topOnly: false,
  };
  const a = encodeListUrl(state, "page=1&stage=applied&q=bob");
  const b = encodeListUrl(state, `top=1&job=${JOB}&sort=newest`);
  assert.equal(a, b);
});

test("encode trims the search term too, so a space cannot mint a second URL for one view", () => {
  const spaced = { ...DEFAULTS, request: { ...DEFAULTS.request, search: "  sarah " } };
  const tight = { ...DEFAULTS, request: { ...DEFAULTS.request, search: "sarah" } };
  assert.equal(encodeListUrl(spaced, ""), encodeListUrl(tight, ""));
});

/* ── the round trip, which is what Back depends on ───────────── */

const STATES = [
  DEFAULTS,
  { ...DEFAULTS, request: { ...DEFAULTS.request, stage: "screening" } },
  { ...DEFAULTS, request: { ...DEFAULTS.request, jobId: JOB, page: 7 } },
  { ...DEFAULTS, request: { ...DEFAULTS.request, search: "o'brien & co", flaggedOnly: true } },
  { ...DEFAULTS, request: { ...DEFAULTS.request, search: "100% match, (maybe)" } },
  { ...DEFAULTS, request: { ...DEFAULTS.request, sort: "newest", page: 2 }, topOnly: true },
  {
    request: {
      jobId: JOB,
      search: "ana",
      stage: "rejected",
      flaggedOnly: true,
      sort: "newest",
      page: 12,
    },
    topOnly: true,
  },
];

test("decode(encode(s)) is s, for every state the UI can reach", () => {
  for (const state of STATES) {
    assert.deepEqual(decode(encodeListUrl(state, "")), state);
  }
});

test("encoding is idempotent through a decode", () => {
  // encode(decode(encode(s))) === encode(s). The failure this catches is a
  // write that drifts each time it is re-read — the URL changing on its own
  // while the reader does nothing.
  for (const state of STATES) {
    const once = encodeListUrl(state, "");
    assert.equal(encodeListUrl(decode(once), ""), once);
  }
});

test("a search term with PostgREST metacharacters round trips unharmed", () => {
  // `sanitiseSearchTerm` strips %,() on the way to the server. That is the
  // server's business; the URL must carry back exactly what was typed, or the
  // search box would rewrite itself on a refresh.
  const typed = "a,b(c)%d";
  const state = { ...DEFAULTS, request: { ...DEFAULTS.request, search: typed } };
  assert.equal(decode(encodeListUrl(state, "")).request.search, typed);
});

test("a junk URL re-encodes to the clean one, so the junk does not persist", () => {
  const dirty = "stage=ghosted&job=nope&sort=sideways&page=0&flagged=true&top=yes";
  assert.equal(encodeListUrl(decode(dirty), dirty), "");
});

/* ── the refresh: what the SERVER serves for a URL ───────────── */

/**
 * Next hands the page a plain object, and a refresh is the only path where the
 * URL is read by the server rather than the browser. `listParamsFrom` is that
 * conversion, and these tests are what makes the claim "a refresh on page 7 of
 * a filtered list serves page 7 of that filter" checkable.
 */
test("a refresh serves the request the URL states, not the defaults", () => {
  const onReload = listParamsFrom({
    q: "sarah",
    job: JOB,
    stage: "interview",
    flagged: "1",
    sort: "newest",
    page: "7",
  });
  assert.deepEqual(decodeListUrl(onReload).request, {
    jobId: JOB,
    search: "sarah",
    stage: "interview",
    flaggedOnly: true,
    sort: "newest",
    page: 7,
  });
});

test("the server and the client read one URL the same way", () => {
  /*
   * The client skips its mount fetch by comparing the request it renders
   * against `servedRequest`. If these two paths decoded the same URL
   * differently, that skip would be a lie: the client would conclude it already
   * had the right rows and show page 1 of everybody under a filled-in toolbar.
   */
  const qs = `q=ana&job=${JOB}&stage=offer&flagged=1&sort=newest&page=3&top=1`;
  const fromServer = decodeListUrl(listParamsFrom(Object.fromEntries(new URLSearchParams(qs))));
  const fromBrowser = decode(qs);
  assert.deepEqual(fromServer, fromBrowser);
  assert.equal(listKey(fromServer.request), listKey(fromBrowser.request));
});

test("a repeated param does not become a joined filter on the server", () => {
  /*
   * Next delivers `?q=sarah&q=ana` as an array, and the browser's
   * `URLSearchParams.get` answers the FIRST. Joining is the tempting
   * conversion and it is wrong twice: it searches for a term nobody typed,
   * and it makes the server disagree with the client about one URL.
   *
   * Asserted on `q` deliberately. The obvious probe is `?stage=` — but an
   * enum guard rejects "applied,hired" as readily as it rejects a dropped
   * value, so a stage assertion passes whether or not the join happened and
   * proves nothing. `q` has no enum to hide behind.
   */
  assert.equal(decodeListUrl(listParamsFrom({ q: ["sarah", "ana"] })).request.search, "");
  const served = decodeListUrl(listParamsFrom({ q: ["sarah", "ana"] }));
  assert.equal("search" in listQueryFor(served.request), false);
  // The enum case too, now that the discriminating claim above is in place.
  assert.equal(decodeListUrl(listParamsFrom({ stage: ["applied", "hired"] })).request.stage, null);
});

test("an absent param is not the string undefined", () => {
  const served = decodeListUrl(listParamsFrom({ q: undefined, stage: undefined }));
  assert.deepEqual(served, DEFAULTS);
});

test("every state the UI can reach survives a refresh unchanged", () => {
  // The composed claim: encode what is on screen, hand that query string to the
  // server the way Next would, and get the same state back.
  for (const state of STATES) {
    const qs = encodeListUrl(state, "");
    const served = decodeListUrl(listParamsFrom(Object.fromEntries(new URLSearchParams(qs))));
    assert.deepEqual(served, state);
  }
});

/*
 * ── The panel's half of the query string ─────────────────────
 *
 * Scope, stated so these tests are not read as more than they are: the defect
 * that prompted them was in the EFFECT that seeds the panel from the URL, and
 * an effect is not reachable from here. What is reachable is the writer, and
 * the writer is what has to leave a history entry that describes the panel
 * honestly — a closed panel that still writes `?tab=` leaves entries no
 * encoding of any state would produce, and Back onto one of those is where the
 * disagreement showed. The effect change itself is covered by a browser check,
 * not by these.
 */

test("an open panel writes both params, and a closed one leaves neither", () => {
  const open = new URLSearchParams(encodePanelUrl("", "app-1", "screening"));
  assert.equal(open.get("applicant"), "app-1");
  assert.equal(open.get("tab"), "screening");
  const openQs = "applicant=app-1&tab=screening";
  const closed = new URLSearchParams(encodePanelUrl(openQs, null, "screening"));
  for (const name of PANEL_PARAM_NAMES) {
    assert.equal(closed.has(name), false, `${name} survived the close`);
  }
});

test("closing clears the tab as well as the applicant", () => {
  // The one the hand-rolled version got right and a `delete("applicant")`-only
  // fix would get wrong: `?tab=` is nothing to the panel once it is shut, but
  // it is a param no encoding produces, so it accumulates and breaks the
  // "one state, one spelling" property the round trip rests on.
  assert.equal(encodePanelUrl("tab=messages", null, "messages"), "");
});

test("the panel does not disturb the list params", () => {
  const state = { ...DEFAULTS, request: { ...DEFAULTS.request, stage: "offer", page: 4 } };
  const listed = encodeListUrl(state, "");
  const withPanel = encodePanelUrl(listed, "app-2", "profile");
  const closed = encodePanelUrl(withPanel, null, "profile");
  const asList = (qs: string) => decodeListUrl(new URLSearchParams(qs));
  assert.deepEqual(asList(withPanel), asList(listed));
  assert.deepEqual(asList(closed), asList(listed));
});

test("and the list does not drop the panel", () => {
  // Already asserted of foreign params generally; asserted again of the real
  // pair, because this is the one that closes a candidate mid-review.
  const withPanel = encodePanelUrl("", "app-3", "notes");
  const state = { ...DEFAULTS, request: { ...DEFAULTS.request, stage: "hired" } };
  const moved = new URLSearchParams(encodeListUrl(state, withPanel));
  assert.equal(moved.get("applicant"), "app-3");
  assert.equal(moved.get("tab"), "notes");
});

test("one panel state has exactly one spelling, however the params arrived", () => {
  const spellings = [
    "applicant=app-4&tab=profile",
    "tab=profile&applicant=app-4",
    "applicant=stale&tab=messages",
    "",
  ];
  const once = spellings.map((s) => encodePanelUrl(s, "app-4", "profile"));
  for (const s of once) assert.equal(s, once[0]);
  // And idempotent, so a re-render cannot drift the URL.
  assert.equal(encodePanelUrl(once[0], "app-4", "profile"), once[0]);
});

test("a tabless open panel writes the applicant alone", () => {
  assert.equal(encodePanelUrl("", "app-5", null), "applicant=app-5");
});

test("an applicant id's metacharacters survive the round trip", () => {
  // Ids are uuids today, but this writes whatever it is handed into a URL, and
  // the reader gets it back through URLSearchParams on the other side.
  const id = "a&b=c%20d+e?f#g";
  const qs = encodePanelUrl("stage=offer", id, "profile");
  assert.equal(new URLSearchParams(qs).get("applicant"), id);
  assert.equal(new URLSearchParams(qs).get("stage"), "offer");
});

test("walking the repro sequence leaves no entry that lies about the panel", () => {
  /*
   * The defect's exact sequence, as the three query strings the writers
   * produce: land unfiltered, push a filter move, then open a panel on top of
   * it. The claim is about the ENTRIES, which is the part a pure test can
   * reach — each one has to be the encoding of the panel state in force when
   * it was written, so that the seeding effect reading it back cannot be
   * misled.
   */
  const landed = encodeListUrl(DEFAULTS, "");
  const offer = { ...DEFAULTS, request: { ...DEFAULTS.request, stage: "offer" } };
  const filtered = encodeListUrl(offer, landed);
  const opened = encodePanelUrl(filtered, "app-6", "profile");

  assert.equal(new URLSearchParams(landed).has("applicant"), false);
  assert.equal(new URLSearchParams(filtered).has("applicant"), false);
  assert.equal(new URLSearchParams(opened).get("applicant"), "app-6");
  // Back is a return to `filtered`, which names nobody — so "names nobody" has
  // to be a state the writer can express, not merely an absence it never
  // writes. Closing on the open entry must reproduce it exactly.
  assert.equal(encodePanelUrl(opened, null, "profile"), filtered);
});
