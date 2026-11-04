/**
 * Every read of job_applications on the company-tenant surface carries a
 * company filter, or is justified here by name.
 *
 *   node --test src/lib/tenant-isolation.test.ts
 *
 * ── What this proves, and why it has to be a scan ────────────
 *
 * RLS is enabled on the dashboard tables but carries no policies, and the
 * service-role client bypasses RLS regardless. Tenant isolation is therefore
 * enforced in application code only: every company-scoped read has to carry
 * `.eq("company_id_snapshot", ctx.companyId)` by hand. company-access.test.ts
 * covers admission control — whether a user may enter — and nothing covered
 * what the queries then filter on. A missed filter is a cross-company data
 * leak, not a slow page.
 *
 * So this parses every source file with the TypeScript compiler, finds every
 * read of job_applications on that surface, and requires each one to be either
 * company-filtered in its own builder chain or on the ALLOWLIST below with a
 * written derivation. The default is "fails until justified". A new call site
 * is covered the moment it is written, which is the one thing the
 * phase8-wiring.test.ts technique it copies does not do — that test's call
 * sites are hardcoded, so a new one is silently uncovered.
 *
 * Two access shapes count as a read, because both return this table's columns:
 * `.from("job_applications")`, and this table EMBEDDED in another table's
 * select — `.from("application_team_comments").select("id,
 * job_applications!inner(email)")`. The second was added after a negative
 * control showed it passing silently against a `.from()`-only scan. For an
 * embedded read the filter PostgREST wants is
 * `.eq("job_applications.company_id_snapshot", …)`; a filter on the parent
 * table's own tenancy column does not count, because it is not this table's.
 *
 * ── What this does NOT prove ────────────────────────────────
 *
 * Read these as the boundary of the claim, not as caveats.
 *
 *   - It does NOT enforce database-level isolation. Nothing here reaches a
 *     database. A query that this test passes is still unprotected at the
 *     storage layer, and the service-role client will happily return another
 *     company's rows if the filter is ever dropped at runtime.
 *   - It does NOT establish that RLS policies exist. It asserts nothing about
 *     pg_policies, and it is in fact written on the assumption that there are
 *     none. If policies are added later, this test will not notice and must
 *     not be read as evidence for or against them.
 *   - It CANNOT guarantee detection of runtime-constructed queries. The scan is
 *     static, so it cannot know what a table name assembled at runtime, passed
 *     in as a parameter, or read from configuration resolves to. What it does
 *     instead is refuse to guess: a same-file constant IS followed
 *     (`const T = "job_applications"; .from(T)` is a site, and that shape is
 *     live in this tree), and a name it cannot follow is reported by
 *     INDIRECT_TABLE_REFS rather than skipped — so the unfollowable case fails
 *     loudly instead of passing silently. The PROJECTION is held to the same
 *     rule, and was not always: deciding whether a read embeds this table
 *     needs the `select()` argument as text, that check once required a bare
 *     literal, and the 32 sites whose projection was a constant or a ternary
 *     were therefore dropped before the scan had an opinion on them. One of
 *     the 32 did embed this table. Same-file constants, templates of them,
 *     concatenations and both branches of a ternary are now read
 *     (resolveSelectArg), and the four projections that remain unreadable are
 *     named in UNREADABLE_SELECTS. The residual gap is real and narrow:
 *     a table reached through a PostgREST VIEW or an RPC is invisible, because
 *     neither names this table in the TypeScript at all. No `.from()` in this
 *     tree reads a view, and the five RPCs that exist (unlock_candidate,
 *     consume_allowance, release_allowance, set_company_plan,
 *     remove_company_plan) are not application reads by name — but their
 *     bodies live in the database, not in this repo, so that is a reading of
 *     their names and not a proof. A view or function added later that selects
 *     from this table is outside what any source scan can reach.
 *   - It says nothing about WRITES, nor about row-level correctness beyond the
 *     company column, nor about any other table read on this surface. Those
 *     are named in UNSCANNED_TABLES, which the inventory test derives from the
 *     source, so this comment does not list them and cannot drift from them.
 *   - A company filter whose VALUE is wrong is only partly caught: the shape of
 *     every filter value is pinned (see FILTER_VALUES) but this test cannot
 *     prove that `ctx.companyId` was itself resolved correctly. That is
 *     company-access.test.ts's job.
 *
 * ── The company-tenant surface ──────────────────────────────
 *
 * Deliberately not a list of files. A file is on the surface if it is under
 * `app/ai-dashboard/`, or if it mentions company tenancy at all
 * (`CompanyContext`, `companyId`). Both halves matter: the path catches a new
 * dashboard file that forgot tenancy entirely, and the mention catches a shared
 * helper under `lib/` that takes a companyId and reads applications.
 *
 * Everything else — Remotiv's internal `app/admin/**`, the public apply and
 * duplicate-check routes, the candidate-side `app/talent/**`, the retention
 * purge — is a DIFFERENT trust boundary. Those requests carry no CompanyContext
 * to filter on, so "must carry .eq(company_id_snapshot, ctx.companyId)" is not
 * merely unenforced there, it is meaningless. This is a scope boundary, not an
 * exemption: it is recomputed from the source on every run, so the moment one
 * of those files starts carrying a companyId it joins the surface and must then
 * be filtered or justified.
 *
 * The `companyId` half of the rule is deliberately left OVER-inclusive. It
 * cannot tell "receives a caller's company" from "computes one for its own
 * use", so it pulls in the signed WhatsApp webhook and the super-admin platform
 * aggregate, which are on the surface only because that identifier appears as a
 * local variable. Narrowing to `ctx.companyId` would drop them — and would also
 * drop the shared queue handlers under `lib/` that take a bare companyId, which
 * are exactly the helpers most likely to be reused by a dashboard caller later.
 * Over-inclusion costs four allowlist entries that name their real boundary.
 * Under-inclusion would cost silent coverage, so the rule errs this way on
 * purpose.
 */
// @ts-nocheck — same reason as communication-log-writes.test.ts: Node's `.ts`
// specifier vs this repo's tsconfig. Nothing ships from this file.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TABLE = "job_applications";
const COMPANY_COLUMN = "company_id_snapshot";
const WRITES = new Set(["insert", "update", "upsert", "delete"]);
const SRC = fileURLToPath(new URL("../", import.meta.url));

/* ── the allowlist ────────────────────────────────────────────── */

/**
 * Reads that carry no company filter of their own and are safe anyway.
 *
 * An entry is identified by the file, the enclosing function, and the query's
 * own builder chain — never by the file alone, and never by line number. Change
 * the query and the entry stops matching, which fails the test rather than
 * quietly continuing to excuse something else. An entry that matches nothing
 * also fails, so a deleted query cannot leave a stale excuse behind.
 *
 * `.eq("id", someId)` is NOT self-justifying. It is safe only if `someId`
 * provably came from an already-company-scoped read, so every id-filtered entry
 * has to say where the id comes from and why that source is scoped. If it
 * cannot be traced it does not belong here — it belongs in the report as a
 * finding.
 */
const DASH = "app/ai-dashboard/(gated)";

/**
 * The derivation that covers sites 1-6 below, written once.
 *
 * Fetch-then-verify: the read is by primary key with no company filter, but it
 * SELECTS `company_id_snapshot` and the very next statement rejects the row if
 * it is not the caller's. Not-found and not-yours return the same message, so
 * an id cannot be probed. Nothing is returned and no side effect occurs before
 * that comparison.
 */
const verifyAfterRead = (guardLine, note) =>
  `applicationId is the client-supplied server-action argument and proves nothing. The read ` +
  `selects company_id_snapshot and the row is rejected at line ${guardLine} — ` +
  `\`company_id_snapshot !== ctx.companyId\` — before any value is returned or any side effect ` +
  `runs, with canAccessJob() applied to target.job_id immediately after. ${note}`;

const ALLOWLIST = [
  /* ── fetch-then-verify, on the applicants surface ──────────── */
  {
    file: `${DASH}/applicants/actions.ts`,
    fn: "updateApplicationStage",
    query:
      '.select("id, company_id_snapshot, pipeline_stage, job_id, first_name, last_name").eq("id", applicationId).maybeSingle()',
    verifyAfter: {},
    why: verifyAfterRead(
      750,
      "The stage UPDATE at 779 independently re-filters on company_id_snapshot, so the write is scoped even if this guard were edited away.",
    ),
  },
  {
    file: `${DASH}/applicants/actions.ts`,
    fn: "assertAdjustableScore",
    query: '.select("id, company_id_snapshot, job_id").eq("id", applicationId).maybeSingle()',
    // The only one of the six that compares against a local rather than
    // ctx.companyId directly, so the binding is checked too.
    verifyAfter: { value: "companyId", boundFrom: "ctx.companyId" },
    why: verifyAfterRead(
      864,
      "A module-private helper whose only output is a boolean verdict — it never hands row data back. Its companyId local is bound from ctx.companyId at 853.",
    ),
  },
  {
    file: `${DASH}/applicants/actions.ts`,
    fn: "rescoreApplication",
    query: '.select("id, company_id_snapshot, job_id").eq("id", applicationId).maybeSingle()',
    verifyAfter: {},
    why: verifyAfterRead(
      1060,
      "The allowance read at 1070 and requestCvScore(applicationId, ctx.companyId) at 1076 both follow the guard.",
    ),
  },
  {
    file: `${DASH}/applicants/actions.ts`,
    fn: "attachApplicationCv",
    query:
      '.select("id, company_id_snapshot, job_id, cv_path, cv_delete_after").eq("id", applicationId).maybeSingle()',
    verifyAfter: {},
    why: verifyAfterRead(
      1175,
      "The retention check at 1190 and the CV upload at 1208 both follow the guard.",
    ),
  },
  {
    file: `${DASH}/applicants/actions.ts`,
    fn: "deleteApplication",
    query:
      '.select("id, company_id_snapshot, cv_path, job_id, first_name, last_name").eq("id", applicationId).maybeSingle()',
    verifyAfter: {},
    why: verifyAfterRead(
      1833,
      "The destructive step is doubly covered: the row delete at 1868 re-filters on company_id_snapshot itself.",
    ),
  },
  {
    file: `${DASH}/applicants/booking-actions.ts`,
    fn: "sendBookingLink",
    query:
      '.select("id, first_name, last_name, email, job_id, company_id_snapshot, jobs(title)").eq("id", applicationId).maybeSingle()',
    verifyAfter: {},
    why: verifyAfterRead(
      88,
      "The calendar read at 105 and createBookingLink at 159 both follow the guard; the latter is what stamps interview_bookings.company_id, which is the invariant cancelBookingAsRecruiter then relies on.",
    ),
  },

  {
    file: `${DASH}/jobs/actions.ts`,
    fn: "fetchCompanyJobs",
    query: '.select("id", { count: "exact", head: true }).eq("job_id", r.id as string)',
    // Existence-only: a company-filtered read of `jobs` must be present in
    // this function, so deleting that filter fails the test. Ordering is NOT
    // asserted — see unprovable.
    scopedRead: { table: "jobs", column: "company_id", ordered: false },
    unprovable: [
      "Ordering. The jobs read sits in a `for` loop body and this count sits in a " +
        "`rows.map(async r => …)` callback, so neither is a straight-line predecessor of the " +
        "other and the strict domination check correctly refuses to claim one.",
      "That r.id came from THAT read. The id travels through `rows.push(...batch)` and then an " +
        "array callback parameter; this scanner does not trace dataflow through arrays.",
      "The job_id-implies-company invariant: an application with a mismatched " +
        "company_id_snapshot but a matching job_id would still be counted.",
    ],
    why:
      "A per-job HEAD count with no company filter at all. r comes from rows accumulated at 480 " +
      "from the paged jobs read built at 462-470, which carries " +
      '.eq("company_id", ctx.companyId) at 465, .is("deleted_at", null) at 466 and ' +
      'q.in("id", scope.jobIds) at 467 for job-scoped roles; ctx is from getCompanyContext() at ' +
      "444. So r.id is always a job this company owns. head: true means the query returns a " +
      "NUMBER and no row data, which bounds the consequence to a wrong count. The derivation " +
      "rests on the cross-table invariant that an application whose job_id belongs to this " +
      "company is this company's row: an application with a mismatched company_id_snapshot but a " +
      "matching job_id would still be counted. Reported as a finding.",
  },
  {
    file: `${DASH}/jobs/actions.ts`,
    fn: "fetchDeletedCompanyJobs",
    query: '.select("id", { count: "exact", head: true }).eq("job_id", r.id as string)',
    scopedRead: { table: "jobs", column: "company_id", ordered: false },
    unprovable: [
      "Exactly the three things fetchCompanyJobs cannot prove — same shape, same loop, same " +
        "array hop, same job_id-implies-company invariant.",
    ],
    why:
      "Identical shape to fetchCompanyJobs, one filter line different. r comes from rows at 559, " +
      'from the jobs read at 543-550 carrying .eq("company_id", ctx.companyId) at 546, ' +
      '.not("deleted_at", "is", null) at 547 and q.in("id", scope.jobIds) at 548. Same ' +
      "head: true count-only exposure and the same job_id-implies-company invariant. Reported as " +
      "a finding alongside fetchCompanyJobs.",
  },
  {
    file: `${DASH}/messages/actions.ts`,
    fn: "fetchApplicationInbound",
    query: '.select("phone").eq("id", applicationId).maybeSingle()',
    // Fully checked, and the reason this mechanism exists. Every clause is
    // asserted against the AST: canSeeApplication is called in this function,
    // with THIS applicationId (the same one the read filters on), it provably
    // precedes the read, and its result is consumed as `if (!guard) return`.
    // Deleting line 549 fails the test. Before this existed, it did not.
    guard: { call: "canSeeApplication", protects: "applicationId" },
    unprovable: [
      "That canSeeApplication's own read is company-filtered. It is (200), but it is a sibling " +
        "function, so the guard check asserts the CALL, not the callee's body. The callee's " +
        "filter is itself covered as a filtered site by the main scan.",
    ],
    why:
      "applicationId is the client-supplied server-action argument at 537, and the select is only " +
      '"phone", so no post-read company comparison is possible on this row. Safety is entirely ' +
      "the guard at 549: `if (!(await canSeeApplication(ctx, applicationId))) return " +
      'empty("phone")`. canSeeApplication (191-205) resolves the SAME id against ' +
      'job_applications with .eq("id", applicationId) at 199 AND ' +
      '.eq("company_id_snapshot", ctx.companyId) at 200, returns false at 203 when no row ' +
      "matches, and additionally requires canAccessJob(ctx, row.job_id) at 204. That makes line " +
      "549 load-bearing: deleting it turns this into a cross-company phone-number read with no " +
      "other check in the way. Reported as a finding.",
  },
  {
    file: `${DASH}/messages/actions.ts`,
    fn: "fetchApplicationInbound",
    query:
      '.select("id, phone, email, first_name, last_name, company_id_snapshot").filter("phone", "imatch", pattern).order("created_at", { ascending: false }).limit(OWNER_LOOKUP_LIMIT)',
    // #64. Granted narrowly: this read must cross companies to detect that a
    // number SPANS companies, so the missing filter is the requirement and the
    // refusal is the protection. Two checked dependencies, so that deleting
    // either turns this scan red and not only the unit test:
    //   gate       - canSeeApplication runs before it (existence and order;
    //                its polarity is asserted by the sibling entry above, on
    //                the same call in the same function). Not `guard`, which
    //                also demands .eq("id", applicationId), and this read is
    //                keyed on the phone by design.
    //   consumedBy - soleOwnerAt() is called AFTER the read and its negation
    //                returns before any row is rendered. That call is the
    //                load-bearing guard; without it this is a cross-company
    //                read whose result reaches the drawer unexamined.
    gate: { call: "canSeeApplication" },
    consumedBy: { call: "soleOwnerAt" },
    unprovable: [
      "That soleOwnerAt() is deciding on THIS read's rows. consumedBy asserts the call, its order " +
        "and its short-circuit, not that `prefiltered` is what was passed - a data-flow claim the " +
        "AST walk does not make. inbound-ownership.test.ts pins the behaviour end to end.",
      "That `pattern` is digits-only. It is built by phonePrefilterPattern() from toWhatsAppDigits " +
        "output in a different module; a regression there would widen the prefilter unnoticed here.",
      "That a FULL page fails closed (prefiltered.length >= OWNER_LOOKUP_LIMIT returns the " +
        "number-not-unique basis). inbound-ownership.test.ts pins it; this scan cannot.",
    ],
    why:
      "The #64 ownership check. This read deliberately spans EVERY company: it asks whether the " +
      "open applicant's phone number is held by anyone else, at any company, and that question " +
      "cannot be answered inside one company's rows; a company filter here would make the check " +
      "vacuous. Controls in place of a filter: canSeeApplication(ctx, applicationId) runs first on " +
      "the same client-supplied id; the rows are reduced by confirmedOwners() and soleOwnerAt() to a " +
      "boolean and never returned; a lookup error returns ok:false and a full page returns no rows; " +
      "and the boolean only ever REMOVES the same applicant's inbound messages from a response the " +
      "viewer could already see. The read removes information, never adds it.",
  },

  /* ── a different trust boundary, named ─────────────────────── */
  {
    file: "app/api/cv/company-application/[id]/route.ts",
    fn: "GET",
    query:
      '.select("id, cv_path, cv_url, cv_delete_after, company_id_snapshot").eq("id", id).maybeSingle()',
    // The same fetch-then-verify shape as the applicants sites, and the real
    // cross-company risk here, so it is checked the same way.
    verifyAfter: {},
    unprovable: [
      "That the rejection precedes every side effect. It is asserted to FOLLOW the read and to " +
        "return, but 'nothing leaks before it' is read off the source by eye — the signed URL is " +
        "minted after, which this does not assert.",
    ],
    why:
      "An authenticated COMPANY request — ctx = await getCompanyContext() at 54, 403 on throw, " +
      "rate-limited at 33 — so this is the real cross-company risk shape, and it is fetch-then-" +
      "verify like the applicants sites. id is the fully client-controlled route param; the query " +
      "selects company_id_snapshot precisely so the row can be rejected at 83 — " +
      "`if (!application || application.company_id_snapshot !== ctx.companyId)` → 404 — before " +
      "any signed CV URL is minted. Missing and not-yours share one response, so ids cannot be " +
      "probed.",
  },
  {
    file: "app/api/book/[token]/route.ts",
    fn: "loadContext",
    query: '.select("first_name, last_name, email").eq("id", row.application_id).maybeSingle()',
    unprovable: [
      "Everything about the token. loadContext takes `row` as a parameter, so the token lookup " +
        "and the isExpired check live in four separate callers (191, 391, 565, 645) and nothing " +
        "in this function's scope can be asserted. A fifth caller passing an unverified row " +
        "would leave this test green.",
      "That hashBookingToken makes the token unguessable, which is the actual authorisation here " +
        "and is a cryptographic claim, not a syntactic one.",
    ],
    why:
      "Not a company request at all: a public candidate booking link with no login, where the " +
      "token IS the authorisation (route doc at 32). There is no CompanyContext to filter on, so " +
      "a company filter is not merely absent but meaningless. row.application_id comes from the " +
      "interview_bookings row returned by findBookingByToken (lib/calendar/bookings.ts:239-261), " +
      'looked up by .eq("token_hash", hashBookingToken(rawToken)) — unguessable — and all four ' +
      "loadContext(row) call sites (191, 391, 565, 645) are preceded by that lookup plus an " +
      "isExpired check. The read returns only the one candidate's own name and email, i.e. the " +
      "data the token holder already has.",
  },
  {
    file: "app/api/webhooks/whatsapp/route.ts",
    fn: "resolveTenancy",
    query:
      '.select("id, phone, email, first_name, last_name, company_id_snapshot, created_at").filter("phone", "imatch", pattern).order("created_at", { ascending: false }).limit(25)',
    unprovable: [
      "There is no company to assert. This read DISCOVERS tenancy — company_id_snapshot is its " +
        "return value — so a company filter is impossible by construction and there is no guard " +
        "shape to declare.",
      "That the HMAC verification at 149-150 runs before this handler. It is in the route's POST " +
        "body and this read is in resolveTenancy, so the ordering spans functions.",
      "That `pattern` is digits-only. It is built by toWhatsAppDigits, which is a different " +
        "module; a regression there would widen the match and this test would not notice.",
    ],
    why:
      "An inbound Meta provider webhook, HMAC-verified over the raw body against " +
      "WHATSAPP_APP_SECRET at 149-150. No company session exists, and this read is what " +
      "DISCOVERS tenancy rather than consuming it — company_id_snapshot is the return value, so " +
      "filtering on a company here is impossible by construction. pattern is built from " +
      "toWhatsAppDigits(fromPhone) and is digits-only. Controls in place of a filter: limit(25), " +
      "an exact-digit re-confirmation, and refusal when the matches span different people " +
      "(isOnePerson). Note for the record: when one person applied at two companies from the same " +
      "phone, isOnePerson holds and matches[0] attributes the message to the NEWEST application " +
      "— a deliberate tie-break that routes that candidate's own text to one company, not a leak " +
      "of another company's rows. On the surface only because the identifier companyId appears " +
      "as a local; see the note on over-inclusion in the header.",
  },
  {
    file: "app/admin/analytics/actions.ts",
    fn: "fetchPlatformAnalytics",
    query:
      '.select("company_id_snapshot, created_at").in("job_id", chunk).order("created_at", { ascending: true }).range(from, to)',
    // The cross-company read is the feature; what must hold is the staff gate.
    gate: { call: "requireSuperAdmin" },
    unprovable: [
      "That requireSuperAdmin actually throws for a non-admin. Its presence and position are " +
        "asserted; its body is in another module and is covered by its own tests, not by this one.",
    ],
    why:
      "A Remotiv-staff platform aggregate, intentionally cross-company: " +
      "await requireSuperAdmin() is the first statement at 124 and throws rather than degrading, " +
      "and the results are bucketed BY company (unscoredByCompany keyed on " +
      "app.company_id_snapshot). A company filter would defeat the feature. chunk is 200-id " +
      "slices of a platform-wide published-jobs read. On the surface only because the identifier " +
      "companyId appears as a local variable (253, 292, 337, 417); see the header note on why " +
      "the rule is left over-inclusive.",
  },
  {
    file: "lib/ai/cv-scoring.ts",
    fn: "handleAiCvScore",
    query:
      '.select("id, job_id, company_id_snapshot, cv_text, screening_answers, years_experience, city, country, notice_period, availability, first_name, last_name").eq("id", applicationId).maybeSingle()',
    derivesTenancy: { from: "app.company_id_snapshot", boundTo: "companyId" },
    unprovable: [
      "That the payload is not otherwise trusted. The derivation is asserted, but 'nothing else " +
        "from job.payload reaches a query' is a whole-function property this does not compute.",
    ],
    why:
      "A queue worker handler for ai_cv_score, not a request — there is no caller company to " +
      "filter by, and this read is what ESTABLISHES tenancy. applicationId comes from " +
      "job.payload, and the module doc at 1364-1370 states the contract: nothing else is trusted " +
      "from the payload, because company, job and CV are all loaded server-side from the " +
      "application row, so a forged payload cannot make one company's job score another's " +
      "applicant. The score is then written with company_id: app.company_id_snapshot, i.e. to the " +
      "OWNING company rather than to whoever enqueued the job.",
  },
  {
    file: "lib/email/candidate/dispatch.ts",
    fn: "handleSendMessage",
    query:
      '.select("id, first_name, last_name, email, job_id, job_title_snapshot, company_id_snapshot, pipeline_stage").eq("id", applicationId).maybeSingle()',
    derivesTenancy: { from: "app.company_id_snapshot", boundTo: "companyId" },
    unprovable: [
      "That every downstream read and write uses the derived companyId rather than the payload. " +
        "The derivation is asserted at its binding; its propagation through the rest of the " +
        "handler is not traced.",
    ],
    why:
      "A queue worker handler for send_message, declared at 36. applicationId comes from " +
      "payload.applicationId, and tenancy is DERIVED from this read rather than checked against a " +
      "caller: `const companyId = app.company_id_snapshot` at 105, with a skip when it is null. " +
      "Every downstream read and write — the company lookup and writeCommunicationLog — uses that " +
      "derived value, so a forged payload addresses the owning company's data, not the " +
      "enqueuer's.",
  },
  {
    file: "lib/whatsapp/dispatch.ts",
    fn: "handleWhatsAppMessage",
    query:
      '.select("id, first_name, phone, job_id, job_title_snapshot, company_id_snapshot").eq("id", applicationId).maybeSingle()',
    derivesTenancy: { from: "app.company_id_snapshot", boundTo: "companyId" },
    unprovable: [
      "The same propagation gap as handleSendMessage: the binding is asserted, its use " +
        "downstream is not traced.",
    ],
    why:
      "A queue worker handler declared at 96, the same shape as handleSendMessage: applicationId " +
      "comes from the job payload and tenancy is derived from this read, " +
      "`const companyId = app.company_id_snapshot` at 215, with a skip when null and all " +
      "downstream logging scoped to that derived value. No caller company exists to filter on.",
  },
];

/**
 * `.from(x)` where x is a table name the single-file scan cannot follow.
 *
 * Kept separate from the query allowlist because the risk is different: these
 * are not unfiltered reads, they are reads the scanner cannot SEE. An entry is
 * keyed by file, function and the `.from()` argument's exact source text, and
 * pins the table that argument resolves to. resolveExpr follows the import
 * and reads the constant from its own source, so renaming the table there
 * fails this test although the call site is unchanged. A resolved table of
 * job_applications fails outright: that is a read the scan cannot check.
 */
const INDIRECT_TABLE_REFS = [
  {
    file: `${DASH}/tip-actions.ts`,
    fn: "dismissTip",
    from: "TIP_TABLE",
    table: "company_member_tips",
    occurrences: 1,
    why:
      "TIP_TABLE is imported from app/ai-dashboard/lib/tip-state.ts, where it is an exported " +
      "string const naming the per-member tip dismissals table. That is a different table from " +
      "job_applications; the single-file scan does not follow imports, so the resolver reads " +
      "the constant from its own source and the pinned table is the claim under test.",
  },
];

/**
 * `.select(x)` where x is a projection the single-file scan cannot read.
 *
 * The same inversion as INDIRECT_TABLE_REFS, one level in: whether such a read
 * embeds job_applications cannot be decided from its own file. An entry
 * records a human having reviewed one exact query, so it is keyed by
 * everything that query is: file, function, table, the select argument's exact
 * source text, and how many times that select appears in the function.
 * `projection` pins what the argument resolves to, read statically from the
 * modules it imports. It is the reviewed statement, so a justification never
 * restates it: change the select text, the function, the table, the count, or
 * the contents of anything the projection is built from, and the entry stops
 * matching.
 *
 * Line numbers are deliberately not part of the key (#27). They changed on
 * edits that changed nothing reviewed, and they missed the one change that did:
 * b80ab19 rewrote LIST_SELECT and its entry kept passing.
 *
 * A projection that cannot be resolved FAILS, and so does one containing a
 * parenthesis, which is how PostgREST spells an embedded resource.
 */
const UNREADABLE_SELECTS = [
  {
    file: `${DASH}/applicants/final-interview-actions.ts`,
    fn: "latestBooking",
    table: "interview_bookings",
    select: "BOOKING_ROW_COLUMNS",
    occurrences: 1,
    projection:
      "id, company_id, application_id, job_id, host_member_id, duration_minutes, status, scheduled_start, scheduled_end, candidate_timezone, host_timezone, meeting_mode, meeting_url, provider_event_id, provider, expires_at, cancelled_at, booked_at, cancelled_by, cancel_reason, purpose, final_interview_id, recording_notice_acknowledged_at, recording_notice_version",
    why:
      "BOOKING_ROW_COLUMNS is imported from lib/calendar/bookings.ts, where it aliases that " +
      "module's own ROW_COLUMNS string: the flat interview_bookings projection a BookingRow is " +
      "read with. A flat column list cannot embed job_applications.",
  },
  {
    file: `${DASH}/applicants/final-interview-actions.ts`,
    fn: "listFinalInterviews",
    table: "interview_bookings",
    select: "BOOKING_ROW_COLUMNS",
    occurrences: 1,
    projection:
      "id, company_id, application_id, job_id, host_member_id, duration_minutes, status, scheduled_start, scheduled_end, candidate_timezone, host_timezone, meeting_mode, meeting_url, provider_event_id, provider, expires_at, cancelled_at, booked_at, cancelled_by, cancel_reason, purpose, final_interview_id, recording_notice_acknowledged_at, recording_notice_version",
    why:
      "The same imported constant as latestBooking, read at a second call site in this file. " +
      "A separate entry rather than an occurrence count because the two reads sit in different " +
      "functions, and each function is its own reviewed call site.",
  },
  {
    file: `${DASH}/jobs/actions.ts`,
    fn: "assertOwned",
    table: "jobs",
    select:
      `\`id, company_id, criteria_version, \${SCORING_RELEVANT_COLUMNS.join(", ")}, ` +
      `\${CV_WEIGHT_DIMENSIONS.map((d) => d.key).join(", ")}\``,
    occurrences: 1,
    projection:
      "id, company_id, criteria_version, title, description, responsibilities, requirements, experience_level, category, screening_questions, scoring_must_haves, interview_criteria, cv_weight_requirements, cv_weight_experience, cv_weight_domain, cv_weight_responsibilities",
    why:
      "A template over two imported module constants of plain jobs column names: " +
      "SCORING_RELEVANT_COLUMNS from app/ai-dashboard/lib/job-patch.ts, joined, and the key of " +
      "each CV_WEIGHT_DIMENSIONS entry from app/ai-dashboard/lib/job-types.ts, mapped and " +
      "joined. The resolver reads both array literals, so a column added to either one " +
      "changes the projection and fails here.",
  },
  {
    file: "app/jobs/company-filter.ts",
    fn: "fetchCompanyJobs",
    table: "jobs",
    select: "LIST_SELECT",
    occurrences: 1,
    projection:
      "id,title,company,company_rating,location,salary_min,salary_max,salary_currency,contract_type,work_type,category,experience_level,positions,created_at,slug,company_id",
    why:
      "LIST_SELECT is imported from lib/jobs.ts, where it is PUBLIC_JOB_SUMMARY_FIELDS joined " +
      "with commas: the public card-grid keep-list. lib/jobs.ts records that this projection " +
      "deliberately avoids joins because /jobs is the hottest page on the site, which is the " +
      "property the parenthesis check enforces.",
  },
];

/**
 * Every table read on the tenant surface that this scan does NOT check (#65).
 *
 * Derived, not written: the inventory test below collects every table read on
 * the surface with its own pass over the source, independent of the scan's
 * table filter and file prefilter, subtracts the one table scanned, and
 * requires the remainder to equal these keys. A read of a table missing here
 * fails; an entry whose table is no longer read is stale and fails; a table
 * name the inventory cannot resolve fails closed.
 *
 * What this guarantees is that the INVENTORY is complete. It is not security
 * coverage: a new unfiltered read of a table already listed here passes. Being
 * listed means "known and unchecked", never "safe".
 * Complete only for the surface as onTenantSurface defines it: app/admin, app/api, app/talent, the public pages and lib/ workers off it (lib/interviews, lib/final-interviews, lib/ai, lib/cv-purge.ts and others) read tenant tables this inventory never sees.
 *
 * The reasons, and what each one does NOT claim:
 *   pending-classification   carries applicant data. Unchecked. The #65 audit
 *                            classified these reads, but provisionally: its B2
 *                            reads were sorted by entry-point SHAPE, not by
 *                            verifying each chain, and its D = 0 means zero
 *                            FOUND (about 25 sites were read line by line), not
 *                            zero existing.
 *   company-data-only        company data, no applicant data. Unchecked.
 *   different-trust-boundary not company tenancy at all. Nothing in this file
 *                            or anywhere else checks these: UNVERIFIED, not safe.
 *   no-tenant-data           holds no company or applicant data.
 */
export const UNSCANNED_TABLES = {
  application_scores: {
    reason: "pending-classification",
    note: "AI and human scores per application",
  },
  application_stage_history: {
    reason: "pending-classification",
    note: "pipeline moves per application",
  },
  application_team_comments: {
    reason: "pending-classification",
    note: "recruiter comments on an applicant",
  },
  communication_logs: {
    reason: "pending-classification",
    note: "messages sent to applicants, with address and body",
  },
  communication_opt_outs: {
    reason: "pending-classification",
    note: "applicant email opt-outs per company",
  },
  final_interview_bots: {
    reason: "pending-classification",
    note: "recording bots per final interview, keyed by application",
  },
  final_interview_evaluations: {
    reason: "pending-classification",
    note: "interviewer evaluations of a final interview",
  },
  final_interview_recordings: {
    reason: "pending-classification",
    note: "final-interview recordings, keyed by application",
  },
  final_interviews: {
    reason: "pending-classification",
    note: "final human interviews, keyed by application",
  },
  interview_answer_scores: {
    reason: "pending-classification",
    note: "scores of one candidate answer, keyed by session",
  },
  interview_answers: {
    reason: "pending-classification",
    note: "candidate answer transcripts; NO company_id column, session-keyed only",
  },
  interview_bookings: {
    reason: "pending-classification",
    note: "candidate interview bookings, keyed by application",
  },
  interview_notes: {
    reason: "pending-classification",
    note: "recruiter notes on an interview session",
  },
  interview_session_scores: {
    reason: "pending-classification",
    note: "scorecard of one interview session",
  },
  interview_sessions: {
    reason: "pending-classification",
    note: "AI interview sessions, keyed by application",
  },
  interview_turns: {
    reason: "pending-classification",
    note: "live interview transcript turns; NO company_id column, session-keyed only",
  },
  live_interview_actions: {
    reason: "pending-classification",
    note: "recruiter actions on a live interview session",
  },
  live_interview_scores: {
    reason: "pending-classification",
    note: "live interview scorecards, keyed by session",
  },
  live_restart_link_events: {
    reason: "pending-classification",
    note: "restart link events for a candidate's session",
  },
  live_video_pieces: {
    reason: "pending-classification",
    note: "candidate interview video pieces, keyed by session",
  },
  notifications_company: {
    reason: "pending-classification",
    note: "company bell entries naming applicants",
  },
  whatsapp_inbound: {
    reason: "pending-classification",
    note: "inbound applicant WhatsApp messages (#64)",
  },

  availability_rules: { reason: "company-data-only", note: "a member's calendar availability" },
  background_jobs: {
    reason: "company-data-only",
    note: "queue rows; payloads carry ids, not applicant data",
  },
  calendar_connections: { reason: "company-data-only", note: "members' connected calendars" },
  companies: { reason: "company-data-only", note: "the company row; its tenancy column is id" },
  company_invites: { reason: "company-data-only", note: "pending member invites" },
  company_member_tips: {
    reason: "company-data-only",
    note: "per-member tip dismissals, reached through TIP_TABLE",
  },
  company_members: { reason: "company-data-only", note: "a company's members and roles" },
  company_plan_history: { reason: "company-data-only", note: "plan changes per company" },
  company_plans: { reason: "company-data-only", note: "a company's plan and allowances" },
  final_interview_interviewers: {
    reason: "company-data-only",
    note: "members assigned to a final interview",
  },
  interview_questions: { reason: "company-data-only", note: "a job's interview questions" },
  job_hiring_team: { reason: "company-data-only", note: "members assigned to a job" },
  job_question_scoring_guides: {
    reason: "company-data-only",
    note: "per-job scoring guides for live questions",
  },
  jobs: { reason: "company-data-only", note: "a company's jobs, drafts included" },
  message_templates: { reason: "company-data-only", note: "a company's message templates" },
  usage_events: { reason: "company-data-only", note: "per-company usage metering" },

  client_members: {
    reason: "different-trust-boundary",
    note: "client portal membership; UNVERIFIED, nothing checks it",
  },
  clients: {
    reason: "different-trust-boundary",
    note: "client portal accounts; UNVERIFIED, nothing checks it",
  },
  talent_profiles: {
    reason: "different-trust-boundary",
    note: "candidate-side talent profiles; UNVERIFIED, nothing checks it",
  },
  team_members: {
    reason: "different-trust-boundary",
    note: "Remotiv's own staff; UNVERIFIED, nothing checks it",
  },

  admin_users: { reason: "no-tenant-data", note: "the super-admin list" },
  pricing_settings: { reason: "no-tenant-data", note: "platform-wide price settings" },
  sentinel: { reason: "no-tenant-data", note: "the staging guard's sentinel row" },
  worker_heartbeats: { reason: "no-tenant-data", note: "queue worker liveness" },
};

/**
 * Every distinct value passed to `.eq("company_id_snapshot", …)` at an in-scope
 * read, with what each one is actually worth.
 *
 * A read can carry the right column and still leak if the value came from the
 * client, so the value shapes are pinned too. They are NOT all equivalent, and
 * flattening them into one "server-derived" claim would overclaim — the notes
 * are the point of this map. A new shape fails the test until it is traced.
 */
const FILTER_VALUES = new Map([
  [
    "ctx.companyId",
    "The request's company, and the only shape that is request-scoped tenancy. " +
      "getCompanyContext (lib/company-guards.ts:60) takes auth.getUser(), throws CompanyAccessDenied " +
      "when there is no user, and resolves through resolveMembership (company-access.ts:94), which " +
      "reads company_members keyed on the cookie-verified user id. No request field can influence " +
      "it; the cache() wrapper is per-request AsyncLocalStorage, not process-wide.",
  ],
  [
    "companyId",
    "A parameter of a module-private helper, never exported, so the caller set is closed and every " +
      "member of it passes ctx.companyId: readScoringFacts (applicants/actions.ts:606, called at " +
      "582), loadApplications (analytics/actions.ts:67, called at 209) and fetchApplications " +
      "(lib/interviews/review.ts:293, called at 186 and 398).",
  ],
  [
    "input.companyId",
    "Four reads in lib/interviews/shortlist.ts. Never client-supplied — always a database column — " +
      "but NOT uniformly a tenancy boundary. dismissShortlistFlag's only caller " +
      "(applicants/actions.ts:1018) passes ctx.companyId, so there it is request-scoped. " +
      "maybeFlagForShortlist is queue-driven: cv-scoring.ts:1617 passes app.company_id_snapshot " +
      "from an unfiltered primary-key read, so the filter re-filters the same row by its own " +
      "company value and is tautological — it cannot leak, and it proves nothing either.",
  ],
  [
    "session.company_id",
    "A column off an interview_sessions row fetched by primary key from a queue payload with no " +
      "company filter (lib/interviews/reminder.ts:110-114, expiry.ts:162-164). So this is a " +
      "cross-ROW consistency check, not request-scoped tenancy: it asserts the application agrees " +
      "with its session's company. The comment at reminder.ts:217-218 says exactly that — an " +
      "application that does not agree is not this company's to write about.",
  ],
]);

/**
 * A filter value approved at ONE read only, matched like an ALLOWLIST entry:
 * by file, enclosing function and the read's own builder chain. For a shape
 * that is safe where it stands but must not become a global approval -
 * `row.company_id` appears 43 times in this tree, each `row` a different
 * table. Change the query and the entry stops matching; reuse the shape at
 * any other read and that read fails as untraced.
 */
const SITE_FILTER_VALUES = [
  {
    file: "lib/final-interviews/alerts.ts",
    fn: "runFinalBotAlert",
    query:
      '.select("first_name").eq("id", row.application_id).eq("company_id_snapshot", row.company_id).maybeSingle()',
    value: "row.company_id",
    why:
      "A column off a final_interview_bots row fetched by primary key from a final_bot_lobby_check " +
      "queue payload that only the service role writes (bots.ts ensureAlertJob, with the id of a row " +
      "the code itself just read). Like session.company_id, a cross-row consistency check, not " +
      "request-scoped tenancy: the bot row's company is fixed by migration 040's composite foreign key " +
      "to final_interviews, whose trigger (038) already requires the application to belong to that " +
      "company, and this filter re-asserts it before the first name goes into the host's alert.",
  },
  {
    file: "lib/interviews/live-question-freeze.ts",
    fn: "prepareLiveQuestions",
    query:
      '.select("first_name, last_name, cv_text").eq("id", row.application_id).eq("job_id", row.job_id).eq("company_id_snapshot", row.company_id).maybeSingle()',
    value: "row.company_id",
    why:
      "A column off an interview_sessions row read by primary key (readSession) for a live session " +
      "id the server itself holds; no request field reaches it. Like session.company_id, a cross-row " +
      "consistency check, not request-scoped tenancy: the application must belong to the session's " +
      "company and job before its CV is read for question writing. The file joined the surface when " +
      "it began passing companyId to the job guide writer (live-guides.ts).",
  },
];

/* ── the scan ─────────────────────────────────────────────────── */

const isLit = (node, value) =>
  node && ts.isStringLiteralLike(node) && (value === undefined || node.text === value);

/**
 * The column a company filter narrows on, direct or through an embedded join.
 *
 * PostgREST names an embedded parent's columns `job_applications.<col>`, so a
 * read of this table through another table's `select()` is filtered by
 * `.eq("job_applications.company_id_snapshot", …)` and not by the bare column.
 * Both spellings count; nothing else does. `.not(col, "is", null)` in
 * particular is a null check, not a tenancy filter, and is deliberately not
 * matched here.
 */
const COMPANY_KEYS = new Set([COMPANY_COLUMN, `${TABLE}.${COMPANY_COLUMN}`]);
const isCompanyKey = (node) => isLit(node) && COMPANY_KEYS.has(node.text);

/**
 * This table appearing as an embedded resource inside a `select()` string.
 *
 * `select("id, job_applications!inner(email)")` on `application_team_comments`
 * reads this table's columns without ever naming it in `.from()`. A scan that
 * only looks at `.from()` misses it completely — confirmed by negative control
 * 3, where exactly this shape passed silently before this was added.
 *
 * Three spellings are matched that a narrower pattern missed, all of them real
 * PostgREST: an embed renamed with `alias:`, an FK disambiguation hint before
 * the join modifier (`job_applications!fk_logs_app!inner(…)`), and whitespace
 * around either. An embed this pattern cannot see is a read with no opinion
 * attached, which is the one outcome this file exists to prevent.
 */
const EMBED_RE = new RegExp(
  `(?:^|[,(\\s])(?:[A-Za-z_]\\w*\\s*:\\s*)?${TABLE}((?:!\\w+)*)\\s*\\(`,
  "g",
);

/**
 * Every embed of this table in a projection, with the join each one asks for.
 *
 * PostgREST puts the join in the hints: `!inner` is an INNER join and anything
 * else — no hint, `!left`, or an FK hint alone — is a LEFT join. The difference
 * is load-bearing. A filter keyed on an embedded column restricts which
 * embedded rows are attached, not which parent rows come back; across an INNER
 * join a parent with no surviving embed is dropped, across a LEFT join it is
 * returned with the embed nulled out. So the same filter that isolates one
 * query leaks in the other, and the only thing separating them is the hint.
 */
function embedsIn(text) {
  return [...text.matchAll(EMBED_RE)].map((m) => ({
    hints: m[1],
    join: /!inner\b/.test(m[1]) ? "INNER" : "LEFT",
  }));
}

/** The base of a builder chain: `service` in `service.from(t).select()`. */
function chainRoot(node) {
  let e = node;
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else return e;
  }
}

/**
 * Walk UP from a `.from(...)` call collecting the methods applied to it.
 *
 * Returns the methods in source order and the outermost node of the chain, so
 * the caller can see whether the chain was awaited on the spot or bound to a
 * variable and extended later.
 */
function chainFrom(fromCall) {
  const methods = [];
  let node = fromCall;
  for (;;) {
    const pa = node.parent;
    if (!pa || !ts.isPropertyAccessExpression(pa) || pa.expression !== node) break;
    const call = pa.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== pa) break;
    methods.push({ name: pa.name.text, args: call.arguments });
    node = call;
  }
  return { methods, outer: node };
}

/** The name a chain was bound to, if it was: `let q = service.from(...)`. */
function boundName(outer) {
  let n = outer;
  while (
    n.parent &&
    (ts.isAwaitExpression(n.parent) ||
      ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent))
  ) {
    n = n.parent;
  }
  const p = n.parent;
  if (p && ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) {
    return p.name.text;
  }
  if (
    p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === n &&
    ts.isIdentifier(p.left)
  ) {
    return p.left.text;
  }
  return null;
}

/** The nearest enclosing function-ish node, used both as scope and as identity. */
function enclosingFunction(node) {
  let n = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isSourceFile(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return null;
}

/**
 * The nearest NAMED enclosing function — the one `functionName` reports.
 *
 * Distinct from `enclosingFunction`, which stops at the first arrow. A read
 * inside `rows.map(async (r) => …)` has the arrow as its immediate scope but
 * `fetchCompanyJobs` as its owner, and a declared dependency on an earlier
 * statement has to be looked for in the owner.
 */
function owningFunction(node) {
  let n = node.parent;
  let last = null;
  while (n && !ts.isSourceFile(n)) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      if (n.name) return n;
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      if (n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
        return n;
      }
      last = n;
    }
    n = n.parent;
  }
  return last;
}

/** A readable name for the enclosing function, for allowlist identity. */
function functionName(node) {
  let n = node.parent;
  while (n && !ts.isSourceFile(n)) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.text;
    if (ts.isFunctionExpression(n) && n.name) return n.name.text;
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parent &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
    n = n.parent;
  }
  return "<module>";
}

/**
 * Company filters applied to `name` anywhere in `scope`.
 *
 * This is what makes the builder pattern checkable: `let q = service.from(...)`
 * followed by `q = q.eq("company_id_snapshot", ctx.companyId)` is as filtered as
 * the single-expression form. The chain ROOT has to be the bound name, so a
 * filter on a sibling query inside the same `Promise.all([...])` is not
 * credited to this one.
 *
 * The key is returned alongside the value because the two company spellings are
 * not interchangeable: `company_id_snapshot` restricts the table being read,
 * `job_applications.company_id_snapshot` restricts an embedded resource, and
 * which one was written decides whether the join type matters.
 */
function filtersOn(scope, name) {
  const found = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "eq" &&
      isCompanyKey(n.arguments[0])
    ) {
      const root = chainRoot(n.expression.expression);
      if (ts.isIdentifier(root) && root.text === name) {
        found.push({ key: n.arguments[0].text, value: n.arguments[1] });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** Normalised builder-chain text, used as the allowlist's identity for a query. */
function chainText(methods) {
  return methods
    .map((m) => `.${m.name}(${m.args.map((a) => a.getText()).join(", ")})`)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every module-level `const X = "<string>"` in one file.
 *
 * `.from(APPLICATIONS_TABLE)` is a real shape in this tree (app/api/apply) and a
 * literal-only scan misses it entirely. Resolving same-file constants closes
 * that hole, and it also keeps the opaque-reference check below quiet about
 * `const CV_BUCKET = "cvs"` — which is followable, and is not a table.
 */
function stringConsts(sf) {
  const map = new Map();
  const visit = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isStringLiteralLike(n.initializer)
    ) {
      map.set(n.name.text, n.initializer.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

/**
 * A `select()` argument read as text, by the same rules `.from()` is read by.
 *
 * The embedded-read check below needs the projection as a string, and it used
 * to require a bare literal. That silently dropped every
 * `.select(SOME_COLUMNS)` and every ternary — 32 sites on this surface — and a
 * dropped site is one this scan has no OPINION about, which is the single
 * outcome the rest of this file exists to prevent. One of the 32 turned out to
 * embed job_applications behind a ternary, unverified for as long as the check
 * was literal-only.
 *
 * So the same-file constant resolution `resolveTableArg` already relies on
 * applies here too, extended to the composite shapes this tree actually uses.
 * A ternary resolves to BOTH branches joined, because either branch reaching
 * the database is enough to make the read real.
 *
 * Returns `{ text }` when it could be read and `{ why }` naming the obstacle
 * when it could not. `{ why }` is a finding, not a pass — see
 * UNREADABLE_SELECTS.
 */
function resolveSelectArg(arg, consts) {
  if (!arg) return { why: "called with no argument" };
  if (ts.isStringLiteralLike(arg)) return { text: arg.text };
  if (ts.isIdentifier(arg)) {
    return consts.has(arg.text)
      ? { text: consts.get(arg.text) }
      : { why: `${arg.text} is not a same-file string const` };
  }
  if (ts.isParenthesizedExpression(arg) || ts.isAsExpression(arg)) {
    return resolveSelectArg(arg.expression, consts);
  }
  if (ts.isTemplateExpression(arg)) {
    let text = arg.head.text;
    for (const span of arg.templateSpans) {
      const part = resolveSelectArg(span.expression, consts);
      if (part.text === undefined) return { why: `interpolates ${part.why}` };
      text += part.text + span.literal.text;
    }
    return { text };
  }
  const parts = ts.isConditionalExpression(arg)
    ? { kind: "ternary", nodes: [arg.whenTrue, arg.whenFalse], glue: "," }
    : ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? { kind: "concatenation", nodes: [arg.left, arg.right], glue: "" }
      : null;
  if (parts) {
    const read = parts.nodes.map((node) => resolveSelectArg(node, consts));
    const blocked = read.find((r) => r.text === undefined);
    return blocked
      ? { why: `${parts.kind} ${blocked.why}` }
      : { text: read.map((r) => r.text).join(parts.glue) };
  }
  return { why: `a ${ts.SyntaxKind[arg.kind]}, which no static reading covers` };
}

/** Does the receiver of this `.from()` go through `.storage`? Then it is a bucket. */
function isStorageChain(call) {
  let e = call.expression;
  while (e) {
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text === "storage") return true;
      e = e.expression;
    } else if (ts.isCallExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    } else if (ts.isIdentifier(e)) {
      return e.text === "storage";
    } else return false;
  }
  return false;
}

/**
 * What table does `.from(x)` read?
 *
 *   { table }     — followed to a name, whatever that name is
 *   { notATable } — Array.from, Buffer.from, a storage bucket
 *   { opaque }    — a table name this scan CANNOT follow, which is the one
 *                   outcome that must never pass silently
 *
 * The third case is the honest limit of a static scan: a name arriving as a
 * function parameter, or imported from another module, is unresolvable here.
 */
function resolveTableArg(call, consts) {
  const arg = call.arguments[0];
  if (!arg) return { notATable: true };
  if (ts.isStringLiteralLike(arg)) return { table: arg.text, direct: true };
  if (ts.isIdentifier(arg) && consts.has(arg.text)) {
    return { table: consts.get(arg.text), direct: false };
  }
  if (isStorageChain(call)) return { notATable: true };
  const root = chainRoot(call.expression);
  if (ts.isIdentifier(root) && (root.text === "Array" || root.text === "Buffer")) {
    return { notATable: true };
  }
  if (ts.isObjectLiteralExpression(arg) || ts.isArrayLiteralExpression(arg)) {
    return { notATable: true };
  }
  if (ts.isCallExpression(arg) && /arrayBuffer|entries|values|keys/.test(arg.getText())) {
    return { notATable: true };
  }
  return { opaque: true };
}

/* ── verifying a declared guard ───────────────────────────────── */

/**
 * The ancestor chain of `node` as (enclosing block, index of the statement in
 * it) pairs, outermost last. Used to decide execution order structurally rather
 * than by comparing source offsets, which would call a guard inside a later
 * `else` branch a predecessor of a read in the `then` branch.
 */
function blockPath(node, stop) {
  const path = [];
  let n = node;
  while (n && n !== stop) {
    const p = n.parent;
    if ((p && ts.isBlock(p)) || (p && ts.isSourceFile(p))) {
      const i = p.statements.indexOf(n);
      if (i >= 0) path.push({ block: p, index: i });
    }
    n = p;
  }
  return path;
}

/**
 * Does `a` certainly run before `b`, with no branch able to skip it?
 *
 * True only when both sit in one straight-line block and `a`'s statement comes
 * first, or when `a`'s statement ENCLOSES `b`. Anything else — different
 * branches of an `if`, different arms of a `try` — returns false. A guard this
 * cannot order is reported as unordered rather than assumed.
 */
function dominates(a, b, fnNode) {
  const pa = blockPath(a, fnNode);
  const pb = blockPath(b, fnNode);
  for (let i = 0; i < pa.length; i++) {
    const y = pb.find((e) => e.block === pa[i].block);
    if (!y) continue;
    // `i > 0` means `a` sits deeper than the block they share — inside an `if`,
    // a loop, or a `try` — so reaching `a` at all is conditional and it cannot
    // be said to run before `b`.
    return i === 0 && pa[i].index < y.index;
  }
  // `a`'s statement wraps `b` entirely: a condition guarding a nested read.
  return pa.length > 0 && pb.length === 0;
}

/**
 * How a guard call's RESULT is consumed, which is the half that actually stops
 * the read. A guard that is called and its answer thrown away is worse than no
 * guard, because it reads as protection.
 *
 * Polarity is reported, never assumed:
 *   negated-return — `if (!(await g(...))) return ...`  the shape we want
 *   else-return    — `if (await g(...)) {...} else { return }`
 *   destructured   — the result is bound and a later statement returns on it
 *   unknown        — consumed by control flow, but this cannot prove which way
 *   none           — not consumed at all
 */
function guardShape(call) {
  let n = call;
  let negated = false;
  while (n.parent) {
    const p = n.parent;
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) {
      negated = !negated;
    }
    if (ts.isIfStatement(p) && p.expression === n) {
      const terminates = (br) =>
        !!br &&
        (ts.isReturnStatement(br) ||
          ts.isThrowStatement(br) ||
          (ts.isBlock(br) &&
            br.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s))));
      if (negated && terminates(p.thenStatement)) return "negated-return";
      if (!negated && terminates(p.elseStatement)) return "else-return";
      if (terminates(p.thenStatement) || terminates(p.elseStatement)) return "unknown";
      return "none";
    }
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAwaitExpression(p) ||
      ts.isPrefixUnaryExpression(p) ||
      ts.isAsExpression(p)
    ) {
      n = p;
      continue;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === n) return "destructured";
    return "none";
  }
  return "none";
}

/** Every call of `name` inside `scope`, with the call nodes themselves. */
function callsTo(scope, name) {
  const found = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isPropertyAccessExpression(n.expression)
        ? n.expression.name.text
        : ts.isIdentifier(n.expression)
          ? n.expression.text
          : null;
      if (callee === name) found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** The argument texts of a call, whitespace-normalised. */
const argTexts = (call) => call.arguments.map((a) => a.getText().replace(/\s+/g, " "));

/** A same-file function declaration or `const f = …` by name. */
function findFunction(sf, name) {
  let hit = null;
  const visit = (n) => {
    if (hit) return;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name?.text === name) {
      hit = n;
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      hit = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit;
}

/** Does anything inside `scope` filter on `column` with `value`? */
function hasFilter(scope, column, value) {
  let hit = false;
  const visit = (n) => {
    if (
      !hit &&
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "eq" &&
      isLit(n.arguments[0], column) &&
      (!value || n.arguments[1]?.getText().replace(/\s+/g, " ") === value)
    ) {
      hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return hit;
}

/**
 * Reads of `table` inside `scope` that carry `.eq(column, value)` plus every
 * column in `also`. Returns the `.from()` nodes, so the caller can order them
 * against the unsafe read.
 */
function scopedReadsOf(scope, table, column, value, also = []) {
  const found = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "from" &&
      isLit(n.arguments[0], table)
    ) {
      const { methods } = chainFrom(n);
      const eqs = methods.filter((m) => m.name === "eq");
      const on = (col, val) =>
        eqs.some(
          (m) =>
            isLit(m.args[0], col) && (!val || m.args[1]?.getText().replace(/\s+/g, " ") === val),
        );
      if (on(column, value) && also.every(([c, v]) => on(c, v))) found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * Comparisons of `<something>.<column>` against `value` that short-circuit.
 *
 * This is the fetch-then-verify shape: the read is unfiltered but selects the
 * company column, and the row is rejected before use. Checkable properties are
 * that the comparison EXISTS and that its result terminates the function. That
 * it precedes every side effect is not checked here — see the test's own notes.
 */
function rejectionsOn(scope, column, value) {
  const found = [];
  const visit = (n) => {
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) &&
      [n.left, n.right].some((s) => ts.isPropertyAccessExpression(s) && s.name.text === column) &&
      [n.left, n.right].some((s) => s.getText().replace(/\s+/g, " ") === value)
    ) {
      const neq = n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      let p = n.parent;
      while (
        p &&
        (ts.isParenthesizedExpression(p) ||
          ts.isBinaryExpression(p) ||
          ts.isPrefixUnaryExpression(p))
      ) {
        p = p.parent;
      }
      if (p && ts.isIfStatement(p)) {
        const term = (br) =>
          !!br &&
          (ts.isReturnStatement(br) ||
            ts.isThrowStatement(br) ||
            (ts.isBlock(br) &&
              br.statements.some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s))));
        if (neq ? term(p.thenStatement) : term(p.elseStatement)) found.push(n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * Check one allowlist entry's declared dependency against the AST.
 *
 * Returns a list of failure strings — empty means every declared property was
 * found and ordered. This is the part that makes an allowlist entry a CHECKED
 * claim instead of a comment: `fetchApplicationInbound` is safe only because of
 * one `if` on one line, and before this existed, deleting that line left the
 * test green.
 */
function verifyGuard(entry, site) {
  const fail = [];
  const where = `${entry.file} ${entry.fn}()`;

  if (entry.guard) {
    const { call, protects, polarity = "negated-return" } = entry.guard;
    const calls = callsTo(site.ownerNode, call);
    if (calls.length === 0) {
      fail.push(`${where}: declared guard ${call}() is NOT called in this function`);
    } else {
      const withId = calls.filter((c) => argTexts(c).includes(protects));
      if (withId.length === 0) {
        fail.push(
          `${where}: ${call}() is called but never with ${protects} — ` +
            `got ${calls.map((c) => `${call}(${argTexts(c).join(", ")})`).join("; ")}`,
        );
      }
      // The guard must check the SAME id the unsafe read resolves, or it is
      // checking a different row than the one being returned.
      const readsId = site.methods.some(
        (m) => m.name === "eq" && isLit(m.args[0], "id") && m.args[1]?.getText() === protects,
      );
      if (!readsId) {
        fail.push(`${where}: the read does not filter .eq("id", ${protects})`);
      }
      for (const c of withId) {
        if (!dominates(c, site.node, site.ownerNode)) {
          fail.push(`${where}: ${call}(${protects}) does not provably run before the read`);
        }
        const shape = guardShape(c);
        if (shape !== polarity) {
          fail.push(
            `${where}: ${call}(${protects}) result is consumed as "${shape}", declared "${polarity}"`,
          );
        }
      }
    }
  }

  if (entry.gate) {
    // A throw-style gate: no boolean to inspect, so only existence and order
    // are asserted. Polarity is not applicable and is not claimed.
    const { call } = entry.gate;
    const calls = callsTo(site.ownerNode, call);
    if (calls.length === 0) {
      fail.push(`${where}: declared gate ${call}() is NOT called in this function`);
    } else if (!calls.some((c) => dominates(c, site.node, site.ownerNode))) {
      fail.push(`${where}: ${call}() does not provably run before the read`);
    }
  }

  if (entry.derivesTenancy) {
    // The queue-worker shape: there is no caller company, so the row's own
    // company_id_snapshot IS the tenancy and everything downstream must use
    // it. What is checkable is that the derivation exists, comes from this
    // read's row, and follows the read. Swapping it for a payload-supplied
    // company — the forged-payload attack these handlers are written against
    // — stops matching and fails.
    const { from, boundTo } = entry.derivesTenancy;
    const found = [];
    const visit = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === boundTo &&
        n.initializer?.getText().replace(/\s+/g, " ") === from
      ) {
        found.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(site.ownerNode);
    if (found.length === 0) {
      fail.push(`${where}: tenancy is not derived as \`const ${boundTo} = ${from}\``);
    } else if (!found.some((f) => dominates(site.node, f, site.ownerNode))) {
      fail.push(`${where}: the \`${boundTo}\` derivation does not follow the read`);
    }
  }

  if (entry.verifyAfter) {
    const { column = COMPANY_COLUMN, value = "ctx.companyId", boundFrom } = entry.verifyAfter;
    // A comparison against a LOCAL is only as good as where the local came
    // from, so a declared binding is checked rather than assumed.
    if (boundFrom) {
      const bound = [];
      const visit = (n) => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === value &&
          n.initializer?.getText().replace(/\s+/g, " ") === boundFrom
        ) {
          bound.push(n);
        }
        ts.forEachChild(n, visit);
      };
      visit(site.ownerNode);
      if (bound.length === 0) {
        fail.push(`${where}: \`${value}\` is not bound from ${boundFrom} in this function`);
      }
    }
    // A comparison is only possible if the row carries the column.
    const sel = site.methods.find((m) => m.name === "select");
    if (!sel || !isLit(sel.args[0]) || !sel.args[0].text.includes(column)) {
      fail.push(`${where}: the read does not select ${column}, so no post-read check is possible`);
    }
    const rejects = rejectionsOn(site.ownerNode, column, value);
    if (rejects.length === 0) {
      fail.push(
        `${where}: no short-circuiting comparison of .${column} against ${value} in this function`,
      );
    } else if (!rejects.some((r) => dominates(site.node, r, site.ownerNode))) {
      // The rejection must come AFTER the read, not before it — a comparison
      // that precedes the read is testing some other row.
      fail.push(`${where}: the .${column} comparison does not follow the read`);
    }
  }

  if (entry.scopedRead) {
    const { table, column, value = "ctx.companyId", also = [], ordered = true } = entry.scopedRead;
    const hits = scopedReadsOf(site.ownerNode, table, column, value, also);
    if (hits.length === 0) {
      fail.push(
        `${where}: declared prior scoped read of ${table} filtered on ` +
          `${column}=${value}${also.length ? ` plus ${also.map(([c]) => c).join(", ")}` : ""} not found`,
      );
    } else if (ordered && !hits.some((h) => dominates(h, site.node, site.ownerNode))) {
      fail.push(`${where}: the scoped read of ${table} does not provably run before this read`);
    }
  }

  if (entry.viaCall) {
    const { call, binding, calleeFiltersOn, calleeValue = "ctx.companyId" } = entry.viaCall;
    const calls = callsTo(site.ownerNode, call);
    if (calls.length === 0) {
      fail.push(`${where}: declared source call ${call}() is NOT called in this function`);
    } else if (!calls.some((c) => dominates(c, site.node, site.ownerNode))) {
      fail.push(`${where}: ${call}() does not provably run before the read`);
    }
    // The read's filter value must actually be a property of the binding that
    // call produced, not a same-named local from somewhere else.
    const usesBinding = site.methods.some(
      (m) =>
        m.name === "eq" &&
        m.args[1] &&
        ts.isPropertyAccessExpression(m.args[1]) &&
        m.args[1].expression.getText() === binding,
    );
    if (!usesBinding) {
      fail.push(`${where}: the read's id is not a property of ${binding}`);
    }
    const callee = findFunction(site.sf, call);
    if (!callee) {
      fail.push(`${where}: ${call}() is not defined in this file, so its filter cannot be checked`);
    } else if (!hasFilter(callee, calleeFiltersOn, calleeValue)) {
      fail.push(`${where}: ${call}() does not filter .eq("${calleeFiltersOn}", ${calleeValue})`);
    }
  }

  if (entry.consumedBy) {
    // The post-read guard shape: the read is unfiltered BY DESIGN and a call
    // AFTER it decides, from the rows, whether anything may proceed. Checkable:
    // the call exists in this function, it follows the read (a consumer that
    // precedes the read is deciding on some other rows), and its result is
    // consumed as `if (!call(...)) return`. Deleting the call, moving it before
    // the read, or ignoring its answer each fails here. What is NOT checked is
    // that the call's argument is this read's data - that is a data-flow claim
    // the entry must state under `unprovable`.
    const { call, polarity = "negated-return" } = entry.consumedBy;
    const calls = callsTo(site.ownerNode, call);
    if (calls.length === 0) {
      fail.push(`${where}: declared consumer ${call}() is NOT called in this function`);
    } else {
      const after = calls.filter((c) => dominates(site.node, c, site.ownerNode));
      if (after.length === 0) {
        fail.push(`${where}: ${call}() does not provably run after the read`);
      }
      for (const c of after) {
        const shape = guardShape(c);
        if (shape !== polarity) {
          fail.push(`${where}: ${call}() result is consumed as "${shape}", declared "${polarity}"`);
        }
      }
    }
  }

  return fail;
}

/** Is this file on the company-tenant surface? Recomputed from source, never listed. */
export function onTenantSurface(rel, text) {
  const path = rel.split(sep).join("/");
  if (path.startsWith("app/ai-dashboard/")) return true;
  return /\bCompanyContext\b|\bcompanyId\b/.test(text);
}

/** Scan one source text. Pure, so the self-tests below can feed it snippets. */
export function scanSource(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = stringConsts(sf);
  const sites = [];
  const opaque = [];
  const unreadable = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      if (n.expression.name.text === "from") {
        const arg = n.arguments[0];
        const resolved = resolveTableArg(n, consts);
        if (resolved.opaque) {
          opaque.push({
            file: fileName,
            fn: functionName(n),
            from: arg.getText().replace(/\s+/g, " "),
            arg,
            sf,
          });
        } else if (resolved.table) {
          const { methods, outer } = chainFrom(n);
          const direct = resolved.table === TABLE;
          const selects = methods.filter((m) => m.name === "select");
          const projections = selects.map((m) => resolveSelectArg(m.args[0], consts));
          const embeds = direct
            ? []
            : projections.flatMap((p) => (p.text === undefined ? [] : embedsIn(p.text)));
          const embedded = embeds.length > 0;
          // The weakest embed wins: a ternary with one `!inner` branch and one
          // plain branch can still reach the database down the plain one.
          const embedJoin = embeds.every((e) => e.join === "INNER") ? "INNER" : "LEFT";
          if (!direct && !embedded) {
            // A projection the scan cannot read either names this table or
            // does not, and there is no way to tell from here. Recorded as a
            // finding rather than dropped, for the same reason an unfollowable
            // .from() argument is: a read this scan cannot see must not pass as
            // one it has cleared.
            projections.forEach((p, i) => {
              if (p.text !== undefined) return;
              const shown = selects[i].args[0]?.getText().replace(/\s+/g, " ") ?? "";
              // Keyed as UNREADABLE_SELECTS is: no line number (#27). `arg`
              // and `sf` let the pin check resolve the projection across
              // modules.
              unreadable.push({
                file: fileName,
                fn: functionName(n),
                table: resolved.table,
                select: shown,
                why: p.why,
                arg: selects[i].args[0],
                sf,
              });
            });
            return ts.forEachChild(n, visit);
          }
          const bound = boundName(outer);
          const scope = enclosingFunction(n) ?? sf;
          const company = [
            ...methods
              .filter((m) => m.name === "eq" && isCompanyKey(m.args[0]))
              .map((m) => ({ key: m.args[0].text, value: m.args[1] })),
            ...(bound ? filtersOn(scope, bound) : []),
          ];
          const values = company.map((f) => f.value);
          sites.push({
            file: fileName,
            line: line(n),
            fn: functionName(n),
            write: methods.some((m) => WRITES.has(m.name)),
            indirect: !isLit(arg, TABLE),
            embedded,
            via: embedded ? resolved.table : null,
            embedJoin: embedded ? embedJoin : null,
            filteredOnEmbed: company.some((f) => f.key === `${TABLE}.${COMPANY_COLUMN}`),
            filteredOnParent: company.some((f) => f.key === COMPANY_COLUMN),
            filtered: values.length > 0,
            values: values.map((v) => v.getText().replace(/\s+/g, " ")),
            chain: chainText(methods),
            // Retained so a declared guard can be checked against the real tree
            // rather than against this summary. See `verifyGuard`.
            node: n,
            methods,
            fnNode: scope,
            ownerNode: owningFunction(n) ?? scope,
            sf,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites, opaque, unreadable };
}

/* ── cross-module pins ────────────────────────────────────────── */

/** Source text by path relative to src/, or null when there is no such file. */
const diskModule = (rel) => {
  try {
    return readFileSync(join(SRC, rel), "utf8");
  } catch {
    return null;
  }
};

const parseModule = (rel, text) =>
  ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/**
 * The src/-relative file an import specifier names, or null.
 *
 * Only `@/` and relative specifiers. A package is not this tree's source, and a
 * value pinned from node_modules would pin something nobody here reviews.
 */
function specBase(fromRel, spec) {
  if (spec.startsWith("@/")) return spec.slice(2);
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return posix.join(posix.dirname(fromRel), spec);
  }
  return null;
}

function moduleRel(fromRel, spec, readModule) {
  const base = specBase(fromRel, spec);
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (readModule(candidate) !== null) return candidate;
  }
  return null;
}

/** Every name a binding introduces: `a`, `{ a, b: c }`, `[a, ...d]`. */
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

/**
 * Is `name` declared between `node` and module scope?
 *
 * The resolver reads MODULE bindings. A local of the same name is what the
 * query would actually use, so finding one is a refusal, not a guess.
 */
function shadowedAt(node, name) {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    const declared = [];
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters ?? []) declared.push(...bindingNames(p.name));
    }
    if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      for (const s of n.statements) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) declared.push(...bindingNames(d.name));
        } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) {
          declared.push(s.name.text);
        }
      }
    }
    if (
      (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.initializer)
    ) {
      for (const d of n.initializer.declarations) declared.push(...bindingNames(d.name));
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      declared.push(...bindingNames(n.variableDeclaration.name));
    }
    if (declared.includes(name)) return true;
  }
  return false;
}

/** A module-level `const name = …` in `sf`, optionally only an exported one. */
function moduleConst(sf, name, exportedOnly) {
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    const exported = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exportedOnly && !exported) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
      const isConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0;
      return isConst && d.initializer
        ? { init: d.initializer }
        : { why: `${name} is not a const with an initializer` };
    }
  }
  return null;
}

/** An identifier, to the value of the module const or named import it names. */
function resolveBinding(id, mod, depth) {
  const name = id.text;
  if (depth > 8) return { why: `${name} is more than eight bindings deep` };
  if (shadowedAt(id, name)) {
    return {
      why: `${name} is declared locally where it is used, so no module binding stands for it`,
    };
  }
  const local = moduleConst(mod.sf, name, false);
  if (local) return local.why ? local : resolveExpr(local.init, mod, depth + 1);
  for (const s of mod.sf.statements) {
    const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined;
    if (!named || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => e.name.text === name);
    if (!el) continue;
    if (s.importClause.isTypeOnly || el.isTypeOnly) return { why: `${name} is a type-only import` };
    const spec = s.moduleSpecifier.text;
    const rel = moduleRel(mod.rel, spec, mod.readModule);
    if (!rel)
      return { why: `${name} is imported from ${spec}, which is not a source file under src/` };
    const target = { rel, sf: parseModule(rel, mod.readModule(rel)), readModule: mod.readModule };
    const exported = (el.propertyName ?? el.name).text;
    const found = moduleConst(target.sf, exported, true);
    if (!found) return { why: `${spec} has no \`export const ${exported}\` to read` };
    return found.why ? found : resolveExpr(found.init, target, depth + 1);
  }
  return { why: `${name} is neither a module-level const nor a named import in ${mod.rel}` };
}

/** `(d) => d.key` gives "key". Any other callback gives null. */
function propertyPicker(fn) {
  if (!ts.isArrowFunction(fn) || fn.parameters.length !== 1) return null;
  const p = fn.parameters[0];
  if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer) return null;
  let body = fn.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  return ts.isPropertyAccessExpression(body) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === p.name.text
    ? body.name.text
    : null;
}

/**
 * The value of an expression, read from source and never executed.
 *
 * Deliberately narrow: strings, same-module consts, named imports of `export
 * const` under src/, templates and `+` of strings, array literals without
 * spreads, object literals of plain properties, `.join()` with a literal
 * separator, and `.map((d) => d.key)`. That is every shape the pinned entries
 * use. Anything else returns `{ why }`, and a pin that cannot be resolved
 * fails: a security test that cannot read what it approves must go red.
 *
 * Nothing is cached. Every call parses the modules it follows from the text
 * `readModule` returns at that moment, which is what lets a control edit a
 * dependency and see the change.
 *
 * Object literals resolve lazily, as their property nodes, so an object is
 * only as readable as the property actually picked from it.
 */
function resolveExpr(e, mod, depth = 0) {
  if (!e) return { why: "there is no argument" };
  if (ts.isStringLiteralLike(e)) return { value: e.text };
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    return resolveExpr(e.expression, mod, depth);
  }
  if (ts.isIdentifier(e)) return resolveBinding(e, mod, depth);
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) {
      const part = resolveExpr(span.expression, mod, depth);
      if (part.why) return part;
      if (typeof part.value !== "string") {
        return { why: `${span.expression.getText()} does not resolve to a string` };
      }
      text += part.value + span.literal.text;
    }
    return { value: text };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const sides = [resolveExpr(e.left, mod, depth), resolveExpr(e.right, mod, depth)];
    const blocked = sides.find((s) => s.why);
    if (blocked) return blocked;
    if (sides.some((s) => typeof s.value !== "string")) {
      return { why: `${e.getText()} concatenates something that is not a string` };
    }
    return { value: sides[0].value + sides[1].value };
  }
  if (ts.isArrayLiteralExpression(e)) {
    const out = [];
    for (const el of e.elements) {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) {
        return { why: "an array literal with a spread or a hole" };
      }
      const r = resolveExpr(el, mod, depth);
      if (r.why) return r;
      out.push(r.value);
    }
    return { value: out };
  }
  if (ts.isObjectLiteralExpression(e)) {
    const props = new Map();
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        return { why: "an object literal with a property that is not a plain assignment" };
      }
      props.set(p.name.text, p.initializer);
    }
    return { value: { props, mod } };
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    const recv = resolveExpr(e.expression.expression, mod, depth);
    if (recv.why) return recv;
    const list = Array.isArray(recv.value) ? recv.value : null;
    if (method === "join" && list && list.every((v) => typeof v === "string")) {
      if (e.arguments.length === 0) return { value: list.join(",") };
      if (e.arguments.length === 1 && ts.isStringLiteralLike(e.arguments[0])) {
        return { value: list.join(e.arguments[0].text) };
      }
    }
    const prop =
      method === "map" && e.arguments.length === 1 ? propertyPicker(e.arguments[0]) : null;
    if (prop && list) {
      const out = [];
      for (const item of list) {
        const node = item?.props instanceof Map ? item.props.get(prop) : undefined;
        if (!node)
          return { why: `an element of ${e.expression.expression.getText()} has no ${prop}` };
        const r = resolveExpr(node, item.mod, depth);
        if (r.why) return r;
        out.push(r.value);
      }
      return { value: out };
    }
    return { why: `${e.getText()} calls .${method}() in a form this resolver does not evaluate` };
  }
  return { why: `${e.getText()} is a ${ts.SyntaxKind[e.kind]}, which this resolver does not read` };
}

const selectPinKey = (e) => `${e.file} ${e.fn}(): .from("${e.table}").select(${e.select})`;
const tablePinKey = (e) => `${e.file} ${e.fn}(): .from(${e.from})`;

/**
 * Every way the unreadable selects in `records` fail their pins. Empty is a pass.
 *
 * Pure over its arguments, so a control can hand it a re-scanned file and a
 * `readModule` that returns an edited dependency.
 */
function selectPinFailures(records, readModule) {
  const failures = [];
  const used = new Map();
  for (const r of records) {
    const where = selectPinKey(r);
    const entry = UNREADABLE_SELECTS.find(
      (e) => e.file === r.file && e.fn === r.fn && e.table === r.table && e.select === r.select,
    );
    if (!entry) {
      failures.push(`unexamined: ${where}, which the single-file scan cannot read (${r.why})`);
      continue;
    }
    used.set(entry, (used.get(entry) ?? 0) + 1);
    const got = resolveExpr(r.arg, { rel: r.file, sf: r.sf, readModule });
    if (got.why || typeof got.value !== "string") {
      failures.push(`could not be resolved: ${where}: ${got.why ?? "it is not a string"}`);
      continue;
    }
    if (got.value !== entry.projection) {
      failures.push(
        `projection changed since it was reviewed: ${where}\n      pinned:   ${entry.projection}\n      resolved: ${got.value}`,
      );
    }
    if (got.value.includes("(")) {
      failures.push(
        `embeds a resource: ${where} resolves to a projection with a parenthesis: ${got.value}`,
      );
    }
  }
  for (const e of UNREADABLE_SELECTS) {
    const n = used.get(e) ?? 0;
    if (n === 0) failures.push(`stale: ${selectPinKey(e)} matches no select in the tree`);
    else if (n !== e.occurrences) {
      failures.push(
        `occurrence count changed: ${selectPinKey(e)} was reviewed ${e.occurrences} time(s) and appears ${n}`,
      );
    }
  }
  return failures;
}

/** The same, for `.from()` arguments the single-file scan cannot follow. */
function tablePinFailures(records, readModule) {
  const failures = [];
  const used = new Map();
  for (const r of records) {
    const where = tablePinKey(r);
    const entry = INDIRECT_TABLE_REFS.find(
      (e) => e.file === r.file && e.fn === r.fn && e.from === r.from,
    );
    if (!entry) {
      failures.push(`unexamined: ${where}, a table name the single-file scan cannot follow`);
      continue;
    }
    used.set(entry, (used.get(entry) ?? 0) + 1);
    const got = resolveExpr(r.arg, { rel: r.file, sf: r.sf, readModule });
    if (got.why || typeof got.value !== "string") {
      failures.push(`could not be resolved: ${where}: ${got.why ?? "it is not a string"}`);
      continue;
    }
    if (got.value !== entry.table) {
      failures.push(
        `table changed since it was reviewed: ${where} was pinned to ${entry.table} and resolves to ${got.value}`,
      );
    }
    if (got.value === TABLE) {
      failures.push(`reaches ${TABLE}: ${where} is a ${TABLE} access the scan cannot check`);
    }
  }
  for (const e of INDIRECT_TABLE_REFS) {
    const n = used.get(e) ?? 0;
    if (n === 0) failures.push(`stale: ${tablePinKey(e)} matches no .from() in the tree`);
    else if (n !== e.occurrences) {
      failures.push(
        `occurrence count changed: ${tablePinKey(e)} was reviewed ${e.occurrences} time(s) and appears ${n}`,
      );
    }
  }
  return failures;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test-support") continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** The whole tree, partitioned by trust boundary. Computed once. */
const scan = (() => {
  const onSurface = [];
  const offSurface = [];
  const opaqueOnSurface = [];
  const unreadableOnSurface = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    const text = readFileSync(file, "utf8");
    if (!text.includes(TABLE) && !/\.from\(/.test(text)) continue;
    const surface = onTenantSurface(rel, text);
    const { sites, opaque, unreadable } = scanSource(rel.split(sep).join("/"), text);
    for (const s of sites) (surface ? onSurface : offSurface).push(s);
    if (surface) {
      opaqueOnSurface.push(...opaque);
      unreadableOnSurface.push(...unreadable);
    }
  }
  return { onSurface, offSurface, opaqueOnSurface, unreadableOnSurface };
})();

const reads = scan.onSurface.filter((s) => !s.write);

/**
 * A read whose only company filter is keyed on an embedded column the join does
 * not honour.
 *
 * `.select("id, job_applications(company_id_snapshot)")` with
 * `.eq("job_applications.company_id_snapshot", ctx.companyId)` reads as isolated
 * and is not. The filter decides which embedded rows are attached; a LEFT join
 * keeps the parent row either way, so every parent row still comes back and the
 * embed is simply null for the other companies'. `!inner` is what turns that
 * filter into a restriction on the parent, and it is one word.
 *
 * `filteredOnParent` is the exemption: a query that also filters its own
 * `company_id_snapshot` is restricted whatever the embed does.
 */
const leaksAcrossLeftJoin = (s) =>
  s.embedded && s.embedJoin === "LEFT" && s.filteredOnEmbed && !s.filteredOnParent;

/* ── the scanner discriminates ────────────────────────────────── */

const wrap = (body) => `async function f(service, ctx) { ${body} }`;

test("the scanner refuses every unsafe shape and accepts the safe ones", () => {
  const unfiltered = (src) => {
    const { sites } = scanSource("x.ts", src);
    assert.ok(sites.length > 0, `no site found at all: ${src}`);
    return sites.filter((s) => !s.filtered || leaksAcrossLeftJoin(s));
  };

  // Each of these must be reported as unfiltered.
  const refused = {
    "no filter": wrap('await service.from("job_applications").select("id");'),
    "an id filter only": wrap(
      'await service.from("job_applications").select("id").eq("id", applicationId);',
    ),
    "a job filter only": wrap(
      'await service.from("job_applications").select("id").in("job_id", jobIds);',
    ),
    "the wrong column": wrap(
      'await service.from("job_applications").select("id").eq("company_id", ctx.companyId);',
    ),
    "a sibling query's filter": wrap(
      'await Promise.all([service.from("jobs").select("id").eq("company_id_snapshot", ctx.companyId), service.from("job_applications").select("id").eq("id", x)]);',
    ),
    "a filter on a different builder": wrap(
      'let a = service.from("job_applications").select("id"); let b = service.from("jobs").select("id"); b = b.eq("company_id_snapshot", ctx.companyId); await a;',
    ),
    "a filter in a sibling function": `async function g(service, ctx) { let q = service.from("job_applications").select("id"); return q; }
      async function h(service, ctx) { let q = service.from("jobs").select("id"); q = q.eq("company_id_snapshot", ctx.companyId); return q; }`,
    "the table in a variable": `const T = "job_applications";
      ${wrap('await service.from(T).select("id");')}`,
    "an embedded read through another table": wrap(
      'await service.from("application_team_comments").select("id, job_applications!inner(email)").eq("id", logId);',
    ),
    "an embedded read filtered only on the parent": wrap(
      'await service.from("communication_logs").select("id, job_applications(email)").eq("company_id", ctx.companyId);',
    ),
    "an embedded null check mistaken for a filter": wrap(
      'await service.from("application_team_comments").select("id, job_applications!inner(email)").not("job_applications.company_id_snapshot", "is", null);',
    ),
    // The three shapes resolveSelectArg added. Each hid an embedded read from
    // the literal-only check; the ternary is the one that was live in this
    // tree, in fetchMessages.
    "an embedded read behind a ternary select": wrap(
      'await service.from("communication_logs").select(head ? "id, job_applications!inner(email)" : "id, body, job_applications!inner(email)").eq("company_id", ctx.companyId);',
    ),
    "an embedded read behind a column constant": `const COLS = "id, job_applications!inner(email)";
      ${wrap('await service.from("communication_logs").select(COLS).eq("company_id", ctx.companyId);')}`,
    "an embedded read behind an interpolated constant": `const EMBED = "job_applications!inner(email)";
      ${wrap(`await service.from("communication_logs").select(\`id, \${EMBED}\`).eq("company_id", ctx.companyId);`)}`,
    // The accepted case below, with the one word that makes it safe removed.
    // Each of these spells a LEFT join, so the filter on the embedded column
    // nulls the embed out and returns the parent row regardless.
    "a plain embed, filtered on the embedded column": wrap(
      'await service.from("communication_logs").select("id, job_applications(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "an explicit !left embed, filtered on the embedded column": wrap(
      'await service.from("communication_logs").select("id, job_applications!left(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "an FK hint with no join modifier": wrap(
      'await service.from("communication_logs").select("id, job_applications!fk_logs_app(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "an aliased plain embed": wrap(
      'await service.from("communication_logs").select("id, app:job_applications(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "a ternary whose other branch drops !inner": wrap(
      'await service.from("communication_logs").select(head ? "id, job_applications!inner(email)" : "id, body, job_applications(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "a builder filtered on the embedded column across a plain embed": wrap(
      'let q = service.from("communication_logs").select("id, job_applications(email)"); q = q.eq("job_applications.company_id_snapshot", ctx.companyId); await q;',
    ),
  };
  for (const [name, src] of Object.entries(refused)) {
    assert.ok(unfiltered(src).length > 0, `not refused: ${name}`);
  }

  const accepted = {
    "a chain-local filter": wrap(
      'await service.from("job_applications").select("id").eq("company_id_snapshot", ctx.companyId);',
    ),
    "a builder filter": wrap(
      'let q = service.from("job_applications").select("id"); q = q.eq("company_id_snapshot", ctx.companyId); await q;',
    ),
    "a conditionally-narrowed builder": wrap(
      'const q = service.from("job_applications").select("id").eq("company_id_snapshot", ctx.companyId); await (scoped ? q.in("job_id", ids) : q);',
    ),
    "an aliased table, filtered": `const T = "job_applications";
      ${wrap('await service.from(T).select("id").eq("company_id_snapshot", ctx.companyId);')}`,
    "an embedded read filtered on the embedded column": wrap(
      'await service.from("application_team_comments").select("id, job_applications!inner(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "a ternary select, filtered on the embedded column": wrap(
      'await service.from("communication_logs").select(head ? "id, job_applications!inner(email)" : "id, body, job_applications!inner(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    // The join check must not fire on these. The first keeps `!inner` behind an
    // FK hint, where the join modifier is no longer the last thing in the
    // string. The second is a LEFT join whose parent carries its own filter, so
    // nothing depends on the embed restricting anything.
    "an FK-hinted !inner embed, filtered on the embedded column": wrap(
      'await service.from("communication_logs").select("id, job_applications!fk_logs_app!inner(email)").eq("job_applications.company_id_snapshot", ctx.companyId);',
    ),
    "a plain embed whose parent is filtered on its own column": wrap(
      'await service.from("communication_logs").select("id, job_applications(email)").eq("company_id_snapshot", ctx.companyId);',
    ),
  };
  for (const [name, src] of Object.entries(accepted)) {
    assert.deepEqual(unfiltered(src), [], `refused: ${name}`);
  }
});

test("a select() the scan cannot read is recorded, not dropped", () => {
  // The inversion itself. Each of these is a projection that MIGHT embed
  // job_applications; none can be read statically, and the old behaviour was
  // to walk past them in silence.
  const unreadable = (src) => scanSource("x.ts", src).unreadable;
  const cases = {
    "an imported constant": wrap('await service.from("communication_logs").select(COLS);'),
    "a parameter": 'async function f(service, cols) { await service.from("jobs").select(cols); }',
    "an interpolated call": wrap(`await service.from("jobs").select(\`id, \${COLS.join(", ")}\`);`),
    "a ternary with one unreadable branch": wrap(
      'await service.from("jobs").select(head ? "id" : COLS);',
    ),
  };
  for (const [name, src] of Object.entries(cases)) {
    assert.equal(unreadable(src).length, 1, `not recorded: ${name}`);
  }

  // And the converse: anything it CAN read is not reported as unreadable, or
  // the list would fill with noise and stop being read.
  const quiet = {
    "a literal with no embed": wrap('await service.from("jobs").select("id, title");'),
    "a same-file constant": `const COLS = "id, title";
      ${wrap('await service.from("jobs").select(COLS);')}`,
    "no select at all": wrap('await service.from("jobs").delete().eq("id", jobId);'),
    "a resolved embed, which becomes a site instead": `const COLS = "id, job_applications!inner(email)";
      ${wrap('await service.from("communication_logs").select(COLS);')}`,
  };
  for (const [name, src] of Object.entries(quiet)) {
    assert.deepEqual(unreadable(src), [], `falsely reported: ${name}`);
  }
});

test("the scanner sees aliased tables and flags table names it cannot follow", () => {
  const aliased = scanSource(
    "x.ts",
    `const T = "job_applications"; async function f(s) { await s.from(T).select("id"); }`,
  );
  assert.equal(aliased.sites.length, 1, "an aliased .from() must still be a site");
  assert.equal(aliased.sites[0].indirect, true);

  const opaque = scanSource("x.ts", `async function f(s, t) { await s.from(t).select("id"); }`);
  assert.deepEqual(opaque.sites, [], "an unresolvable table is not a job_applications site");
  assert.equal(opaque.opaque.length, 1, "...but it must be flagged as unfollowable");

  // The shapes that dominate `.from(x)` in this tree and are not table reads.
  for (const src of [
    "const a = Array.from({ length: 3 });",
    "const u = s.storage.from(CV_BUCKET).getPublicUrl(p);",
  ]) {
    assert.deepEqual(scanSource("x.ts", src).opaque, [], `false positive: ${src}`);
  }

  // A read of another table is only a site if it embeds THIS table. The last
  // two are the near-misses: a column whose name merely starts with the table
  // name, and the table named in a filter rather than embedded in the select.
  for (const src of [
    'await s.from("communication_logs").select("id, body").eq("id", x);',
    'await s.from("communication_logs").select("id, job_applications_count").eq("id", x);',
    'await s.from("talent_claim_tokens").select("id").eq("source_table", "job_applications");',
    // The case that actually probes the embed pattern's boundary: a DIFFERENT
    // table whose name starts with this one, with the parenthesis that makes it
    // an embed. The near-miss above has no parenthesis, so it never could.
    'await s.from("communication_logs").select("id, job_applications_archive(email)").eq("id", x);',
  ]) {
    assert.deepEqual(scanSource("x.ts", src).sites, [], `false positive: ${src}`);
  }

  // Embed spellings PostgREST accepts and a narrower pattern could not see. An
  // embed the scan misses is a read it has no opinion about, which is worse
  // than one it refuses: these must each resolve to exactly one site, with the
  // join read off the hints rather than off the hint being last.
  const visible = {
    "an FK hint before the join modifier": [
      'await s.from("communication_logs").select("id, job_applications!fk_logs_app!inner(email)").eq("id", x);',
      "INNER",
    ],
    "an FK hint alone, which is a LEFT join": [
      'await s.from("communication_logs").select("id, job_applications!fk_logs_app(email)").eq("id", x);',
      "LEFT",
    ],
    "a renamed embed": [
      'await s.from("communication_logs").select("id, app:job_applications!inner(email)").eq("id", x);',
      "INNER",
    ],
    "a renamed plain embed": [
      'await s.from("communication_logs").select("id, app:job_applications(email)").eq("id", x);',
      "LEFT",
    ],
    "whitespace before the parenthesis": [
      'await s.from("communication_logs").select("id, job_applications!inner (email)").eq("id", x);',
      "INNER",
    ],
    "an explicit !left": [
      'await s.from("communication_logs").select("id, job_applications!left(email)").eq("id", x);',
      "LEFT",
    ],
  };
  for (const [name, [src, join]] of Object.entries(visible)) {
    const { sites } = scanSource("x.ts", src);
    assert.equal(sites.length, 1, `embed invisible to the scan: ${name}`);
    assert.equal(sites[0].embedded, true, `not recorded as embedded: ${name}`);
    assert.equal(sites[0].embedJoin, join, `join misread: ${name}`);
  }
});

test("a tenancy filter through an embedded resource is only credited to an INNER join", () => {
  const leaky = scan.onSurface.filter(leaksAcrossLeftJoin);
  assert.deepEqual(
    leaky.map((s) => `${s.file}:${s.line} ${s.fn}(): ${s.chain}`),
    [],
    `A filter keyed "${TABLE}.${COMPANY_COLUMN}" says which embedded rows to attach, not
which parent rows to return. Across a LEFT join — a plain embed, "!left", or an FK
hint with no join modifier — a parent row whose ${TABLE} belongs to another
company is STILL RETURNED, with the embed nulled out, so the read is not isolated
even though it looks it. Fix by spelling the embed "${TABLE}!inner(…)", or by
filtering the parent's own "${COMPANY_COLUMN}" as well.`,
  );
});

test("a declared guard is checked, not taken on faith", () => {
  const site = (src) => {
    const { sites } = scanSource("x.ts", src);
    assert.equal(sites.length, 1, `expected one site in: ${src}`);
    return sites[0];
  };
  const entry = (guard) => ({ file: "x.ts", fn: "f", query: "", guard });
  const decl = { call: "canSee", protects: "applicationId" };

  const guarded = `async function f(service, ctx, applicationId) {
      if (!(await canSee(ctx, applicationId))) return null;
      return await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
    }`;
  assert.deepEqual(verifyGuard(entry(decl), site(guarded)), [], "a real guard must verify");

  // Each of these is the guard broken in one specific way, and each must be
  // reported. The first is the exact edit that left the old test green.
  const broken = {
    "guard deleted": `async function f(service, ctx, applicationId) {
        return await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
      }`,
    "guard called on a different id": `async function f(service, ctx, applicationId, other) {
        if (!(await canSee(ctx, other))) return null;
        return await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
      }`,
    "guard result ignored": `async function f(service, ctx, applicationId) {
        await canSee(ctx, applicationId);
        return await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
      }`,
    "guard does not short-circuit": `async function f(service, ctx, applicationId) {
        if (!(await canSee(ctx, applicationId))) console.warn("nope");
        return await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
      }`,
    "guard runs after the read": `async function f(service, ctx, applicationId) {
        const r = await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
        if (!(await canSee(ctx, applicationId))) return null;
        return r;
      }`,
    "guard only on one branch": `async function f(service, ctx, applicationId, flag) {
        if (flag) { if (!(await canSee(ctx, applicationId))) return null; }
        return await service.from("job_applications").select("phone").eq("id", applicationId).maybeSingle();
      }`,
  };
  for (const [name, src] of Object.entries(broken)) {
    assert.ok(verifyGuard(entry(decl), site(src)).length > 0, `not reported: ${name}`);
  }

  // fetch-then-verify: the comparison must exist, follow the read, and
  // short-circuit. Deleting it must be reported.
  const fv = { file: "x.ts", fn: "f", query: "", verifyAfter: {} };
  const ok = `async function f(service, ctx, applicationId) {
      const { data: t } = await service.from("job_applications").select("id, company_id_snapshot").eq("id", applicationId).maybeSingle();
      if (!t || t.company_id_snapshot !== ctx.companyId) return null;
      return t;
    }`;
  assert.deepEqual(verifyGuard(fv, site(ok)), [], "a real post-read check must verify");
  for (const [name, src] of Object.entries({
    "comparison deleted": `async function f(service, ctx, applicationId) {
        const { data: t } = await service.from("job_applications").select("id, company_id_snapshot").eq("id", applicationId).maybeSingle();
        return t;
      }`,
    "comparison does not return": `async function f(service, ctx, applicationId) {
        const { data: t } = await service.from("job_applications").select("id, company_id_snapshot").eq("id", applicationId).maybeSingle();
        if (t.company_id_snapshot !== ctx.companyId) console.warn("nope");
        return t;
      }`,
    "column not selected": `async function f(service, ctx, applicationId) {
        const { data: t } = await service.from("job_applications").select("id").eq("id", applicationId).maybeSingle();
        if (t.company_id_snapshot !== ctx.companyId) return null;
        return t;
      }`,
  })) {
    assert.ok(verifyGuard(fv, site(src)).length > 0, `not reported: ${name}`);
  }

  // consumedBy: the post-read guard must exist, FOLLOW the read, and
  // short-circuit on its negation. Each way of breaking it must be reported.
  const cb = { file: "x.ts", fn: "f", query: "", consumedBy: { call: "soleOwner" } };
  const consumed = `async function f(service, ctx, applicationId) {
      const { data } = await service.from("job_applications").select("id, phone").filter("phone", "imatch", p).limit(25);
      if (!soleOwner(data, applicationId, ctx.companyId)) { return []; }
      return rows(data);
    }`;
  assert.deepEqual(verifyGuard(cb, site(consumed)), [], "a real post-read guard must verify");
  for (const [name, src] of Object.entries({
    "consumer deleted": `async function f(service, ctx, applicationId) {
        const { data } = await service.from("job_applications").select("id, phone").filter("phone", "imatch", p).limit(25);
        return rows(data);
      }`,
    "consumer result ignored": `async function f(service, ctx, applicationId) {
        const { data } = await service.from("job_applications").select("id, phone").filter("phone", "imatch", p).limit(25);
        soleOwner(data, applicationId, ctx.companyId);
        return rows(data);
      }`,
    "consumer does not short-circuit": `async function f(service, ctx, applicationId) {
        const { data } = await service.from("job_applications").select("id, phone").filter("phone", "imatch", p).limit(25);
        if (!soleOwner(data, applicationId, ctx.companyId)) console.warn("nope");
        return rows(data);
      }`,
    "consumer runs before the read": `async function f(service, ctx, applicationId) {
        if (!soleOwner(prior, applicationId, ctx.companyId)) { return []; }
        const { data } = await service.from("job_applications").select("id, phone").filter("phone", "imatch", p).limit(25);
        return rows(data);
      }`,
  })) {
    assert.ok(verifyGuard(cb, site(src)).length > 0, `not reported: ${name}`);
  }

  // A declared same-file source call must exist, precede the read, hand over
  // the binding the read uses, AND itself be company-filtered.
  const via = {
    file: "x.ts",
    fn: "f",
    query: "",
    viaCall: { call: "gate", binding: "fi", calleeFiltersOn: "company_id" },
  };
  const viaOk = `async function gate(ctx, service, id) {
      return await service.from("final_interviews").select("*").eq("id", id).eq("company_id", ctx.companyId).maybeSingle();
    }
    async function f(service, ctx, id) {
      const fi = await gate(ctx, service, id);
      if (!fi) return null;
      return await service.from("job_applications").select("email").eq("id", fi.application_id).maybeSingle();
    }`;
  assert.deepEqual(verifyGuard(via, site(viaOk)), [], "a real via-call must verify");
  const viaUnscoped = viaOk.replace('.eq("company_id", ctx.companyId)', "");
  assert.ok(
    verifyGuard(via, site(viaUnscoped)).length > 0,
    "an unscoped source call must be reported",
  );
});

/* ── the real tree ────────────────────────────────────────────── */

test("the scan is not vacuous", () => {
  assert.ok(reads.length >= 40, `only ${reads.length} tenant-surface reads found`);
  for (const file of [
    "app/ai-dashboard/(gated)/applicants/actions.ts",
    "app/ai-dashboard/(gated)/messages/actions.ts",
    "app/ai-dashboard/(gated)/jobs/actions.ts",
    "app/ai-dashboard/(gated)/layout.tsx",
    "app/ai-dashboard/lib/job-scope.ts",
  ]) {
    assert.ok(
      reads.some((r) => r.file === file),
      `no job_applications read found in ${file}`,
    );
  }
});

test("every job_applications read on the tenant surface is company-filtered or justified", () => {
  const key = (s) => `${s.file}|${s.fn}|${s.chain}`;
  const used = new Map();
  const unjustified = [];

  for (const site of reads) {
    if (site.filtered) continue;
    const entry = ALLOWLIST.find(
      (a) => a.file === site.file && a.fn === site.fn && a.query === site.chain,
    );
    if (!entry) {
      unjustified.push(
        `${site.file}:${site.line} in ${site.fn}()\n      ${site.chain}\n      key: ${key(site)}`,
      );
      continue;
    }
    used.set(entry, (used.get(entry) ?? 0) + 1);
  }

  assert.deepEqual(
    unjustified,
    [],
    `${unjustified.length} job_applications read(s) with no company filter and no allowlist entry:\n    ${unjustified.join("\n    ")}`,
  );

  // A stale entry is as bad as a missing one: it is a written claim about code
  // that no longer exists, and it would silently excuse the next query to land
  // in the same place.
  const stale = ALLOWLIST.filter((a) => !used.has(a)).map((a) => `${a.file} ${a.fn}() ${a.query}`);
  assert.deepEqual(stale, [], `stale allowlist entries:\n    ${stale.join("\n    ")}`);

  for (const a of ALLOWLIST) {
    assert.equal(used.get(a), a.occurrences ?? 1, `${a.file} ${a.fn}(): occurrence count changed`);
    assert.ok(a.why && a.why.length > 80, `${a.file} ${a.fn}(): justification too thin`);
  }
});

/**
 * The allowlist's declared dependencies hold in the real tree.
 *
 * Separate from the test above on purpose: that one asks "is this read
 * justified in writing", this one asks "is the thing the writing CLAIMS still
 * there". An entry whose guard was deleted is a worse state than an entry that
 * never had one, because the prose keeps vouching for code that is gone.
 */
test("every declared guard and scoped-read dependency still holds", () => {
  const failures = [];
  for (const site of reads) {
    if (site.filtered) continue;
    const entry = ALLOWLIST.find(
      (a) => a.file === site.file && a.fn === site.fn && a.query === site.chain,
    );
    if (entry) failures.push(...verifyGuard(entry, site));
  }
  assert.deepEqual(
    failures,
    [],
    `${failures.length} declared dependenc(ies) no longer hold:\n    ${failures.join("\n    ")}`,
  );

  // Not vacuous: if every declaration were dropped the assertion above would
  // still pass, so the declarations themselves are counted.
  const DECLS = [
    "guard",
    "gate",
    "verifyAfter",
    "scopedRead",
    "viaCall",
    "derivesTenancy",
    "consumedBy",
  ];
  const declares = (a) => DECLS.some((d) => a[d]);
  const declared = ALLOWLIST.filter(declares);
  // 15 since #64: fetchApplicationInbound's ownership read declares consumedBy.
  assert.equal(declared.length, 15, "the number of entries declaring a dependency changed");
  assert.ok(
    ALLOWLIST.some((a) => a.guard),
    "at least one entry must declare an authorization guard",
  );

  // An entry that declares nothing checkable must SAY so. This is what stops
  // the allowlist drifting back into prose: silence is not an option, and
  // naming a function in `why` is not a substitute for an assertion.
  const silent = ALLOWLIST.filter(
    (a) => !declares(a) && !(a.unprovable && a.unprovable.length > 0),
  ).map((a) => `${a.file} ${a.fn}()`);
  assert.deepEqual(
    silent,
    [],
    `allowlist entries that neither declare a checkable dependency nor state what cannot be ` +
      `proven:\n    ${silent.join("\n    ")}`,
  );

  // And a stated limitation has to be a sentence, not a shrug.
  for (const a of ALLOWLIST) {
    for (const u of a.unprovable ?? []) {
      assert.ok(u.length > 60, `${a.file} ${a.fn}(): limitation too thin to be useful: "${u}"`);
    }
  }
});

test("no company filter value is client-supplied", () => {
  const seen = new Set();
  const usedSiteEntries = new Set();
  for (const site of reads) {
    for (const v of site.values) {
      const entry = SITE_FILTER_VALUES.find(
        (e) => e.value === v && e.file === site.file && e.fn === site.fn && e.query === site.chain,
      );
      if (entry) usedSiteEntries.add(entry);
      else seen.add(v);
    }
  }
  const unknown = [...seen].filter((v) => !FILTER_VALUES.has(v));
  assert.deepEqual(
    unknown,
    [],
    `company filter value shapes not yet traced: ${unknown.join(", ")}`,
  );

  // Not vacuous: an empty set of shapes would satisfy the assertion above.
  assert.ok(seen.size >= 4, `only ${seen.size} filter value shapes found`);
  assert.ok(seen.has("ctx.companyId"), "the request-scoped shape must still be in use");

  // A traced shape that no longer appears is a stale claim, same as a stale
  // allowlist entry.
  const unused = [...FILTER_VALUES.keys()].filter((v) => !seen.has(v));
  assert.deepEqual(unused, [], `filter value shapes documented but no longer used: ${unused}`);

  // A site-scoped approval that matches no read is a stale claim too.
  const staleSite = SITE_FILTER_VALUES.filter((e) => !usedSiteEntries.has(e)).map(
    (e) => `${e.file} ${e.fn}(): ${e.value}`,
  );
  assert.deepEqual(staleSite, [], `site-scoped filter values that match no read: ${staleSite}`);
  for (const e of SITE_FILTER_VALUES) {
    assert.ok(e.why.length > 80, `${e.file} ${e.fn}(): justification too thin`);
  }
});

test("no select() on the tenant surface is unreadable to the scan", () => {
  const failures = selectPinFailures(scan.unreadableOnSurface, diskModule);
  assert.deepEqual(
    failures,
    [],
    "a select() this scan cannot read might embed job_applications; it is not cleared " +
      `until it matches a reviewed pin:\n    ${failures.join("\n    ")}`,
  );
  for (const e of UNREADABLE_SELECTS) {
    assert.ok(e.why && e.why.length > 80, `${selectPinKey(e)}: justification too thin`);
  }
});

test("no table name on the tenant surface is reached by a route the scan cannot follow", () => {
  const failures = tablePinFailures(scan.opaqueOnSurface, diskModule);
  assert.deepEqual(
    failures,
    [],
    `.from() with a table argument that matches no reviewed pin:\n    ${failures.join("\n    ")}`,
  );
  for (const e of INDIRECT_TABLE_REFS) {
    assert.ok(e.why && e.why.length > 80, `${tablePinKey(e)}: justification too thin`);
  }
});

/* ── #27: the pins track the query, not its position ─────────── */

/**
 * The scan's two pinned-record lists, with some files' text replaced.
 *
 * Each overlaid file is re-scanned from its new text, and the resolver reads
 * every dependency through `readModule`, so an edited dependency is read as
 * edited. No module is imported, so there is no module cache to hide a change:
 * the dependencies are parsed from text on every call.
 */
function rescan(overlay) {
  const readModule = (rel) => (Object.hasOwn(overlay, rel) ? overlay[rel] : diskModule(rel));
  let unreadable = scan.unreadableOnSurface;
  let opaque = scan.opaqueOnSurface;
  for (const [rel, text] of Object.entries(overlay)) {
    unreadable = unreadable.filter((r) => r.file !== rel);
    opaque = opaque.filter((r) => r.file !== rel);
    if (!onTenantSurface(rel, text)) continue;
    const out = scanSource(rel, text);
    unreadable = [...unreadable, ...out.unreadable];
    opaque = [...opaque, ...out.opaque];
  }
  return [...selectPinFailures(unreadable, readModule), ...tablePinFailures(opaque, readModule)];
}

/** `text` with its one occurrence of `from` replaced. A missing anchor is a broken control. */
function editOnce(text, from, to) {
  const at = text.indexOf(from);
  assert.ok(at !== -1 && text.indexOf(from, at + 1) === -1, `control anchor not unique: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

const FILTER = "app/jobs/company-filter.ts";
const JOBS_LIB = "lib/jobs.ts";
const FETCH_JOBS = `${FILTER} fetchCompanyJobs()`;
const FETCH_JOBS_OPEN =
  "export async function fetchCompanyJobs(companyId: string): Promise<Read<Job[]>> {\n" +
  "  const supabase = createServiceClient();\n";
const SUMMARY_OPEN = 'export const PUBLIC_JOB_SUMMARY_FIELDS = [\n  "id",\n';

test("#27 an imported column array changing fails its pin, though the select text does not", () => {
  // b80ab19, reproduced: the dependency moves and the call site does not.
  const jobs = diskModule(JOBS_LIB);
  const filter = diskModule(FILTER);
  assert.ok(filter.includes(".select(LIST_SELECT)"), "the call site is the one pinned");
  const cases = {
    "a field added to PUBLIC_JOB_SUMMARY_FIELDS": {
      [JOBS_LIB]: editOnce(jobs, SUMMARY_OPEN, `${SUMMARY_OPEN}  "description",\n`),
    },
    "a field removed from PUBLIC_JOB_SUMMARY_FIELDS": {
      [JOBS_LIB]: editOnce(jobs, '  "company_rating",\n', ""),
    },
    "a column added to SCORING_RELEVANT_COLUMNS": {
      "app/ai-dashboard/lib/job-patch.ts": editOnce(
        diskModule("app/ai-dashboard/lib/job-patch.ts"),
        '  "screening_questions",\n',
        '  "screening_questions",\n  "salary_min",\n',
      ),
    },
    "a CV_WEIGHT_DIMENSIONS key renamed": {
      "app/ai-dashboard/lib/job-types.ts": editOnce(
        diskModule("app/ai-dashboard/lib/job-types.ts"),
        'key: "cv_weight_domain"',
        'key: "cv_weight_sector"',
      ),
    },
  };
  for (const [name, overlay] of Object.entries(cases)) {
    // Only the dependency is overlaid: every call site is read from disk unchanged.
    assert.ok(
      !Object.hasOwn(overlay, FILTER) && !Object.hasOwn(overlay, `${DASH}/jobs/actions.ts`),
    );
    const failures = rescan(overlay);
    assert.ok(
      failures.some((f) => f.startsWith("projection changed since it was reviewed: ")),
      `${name}: not caught\n    ${failures.join("\n    ")}`,
    );
  }
  assert.deepEqual(rescan({}), [], "and the unedited tree passes, so the edit is what failed");
});

test("#27 unrelated lines added above an approved select still pass", () => {
  const filler = Array.from({ length: 11 }, (_, i) => `// unrelated line ${i + 1}\n`).join("");
  const actions = `${DASH}/jobs/actions.ts`;
  assert.deepEqual(
    rescan({
      [FILTER]: editOnce(diskModule(FILTER), FETCH_JOBS_OPEN, filler + FETCH_JOBS_OPEN),
      [actions]: editOnce(
        diskModule(actions),
        "async function assertOwned(",
        `${filler}async function assertOwned(`,
      ),
    }),
    [],
  );
});

test("#27 the select's source text changing fails, even when it resolves to the same value", () => {
  const filter = diskModule(FILTER);
  for (const replacement of [
    `.select(\`\${LIST_SELECT},description\`)`,
    // Byte-for-byte the same projection. Only the select text says it changed.
    `.select(\`\${LIST_SELECT}\`)`,
  ]) {
    const failures = rescan({ [FILTER]: editOnce(filter, ".select(LIST_SELECT)", replacement) });
    assert.ok(
      failures.some((f) => f.startsWith(`unexamined: ${FILTER} fetchCompanyJobs()`)),
      `${replacement}: not caught\n    ${failures.join("\n    ")}`,
    );
  }
});

test("#27 a second copy of an approved select in the same function fails its occurrence count", () => {
  const failures = rescan({
    [FILTER]: editOnce(
      diskModule(FILTER),
      FETCH_JOBS_OPEN,
      `${FETCH_JOBS_OPEN}  void supabase.from("jobs").select(LIST_SELECT);\n`,
    ),
  });
  assert.ok(
    failures.some((f) => f.startsWith(`occurrence count changed: ${FETCH_JOBS}`)),
    failures.join("\n"),
  );
});

test("#27 an embedded relation in a resolved projection fails", () => {
  const failures = rescan({
    [JOBS_LIB]: editOnce(
      diskModule(JOBS_LIB),
      SUMMARY_OPEN,
      `${SUMMARY_OPEN}  "job_applications(email)",\n`,
    ),
  });
  assert.ok(
    failures.some((f) => f.startsWith(`embeds a resource: ${FETCH_JOBS}`)),
    failures.join("\n"),
  );
});

test("#27 the indirect table name changing fails its pin", () => {
  const tipState = "app/ai-dashboard/lib/tip-state.ts";
  const source = diskModule(tipState);
  const pinned = 'export const TIP_TABLE = "company_member_tips";';
  const renamed = rescan({
    [tipState]: editOnce(source, pinned, 'export const TIP_TABLE = "company_member_tips_v2";'),
  });
  assert.ok(
    renamed.some((f) => f.startsWith("table changed since it was reviewed: ")),
    renamed.join("\n"),
  );
  const toTenant = rescan({
    [tipState]: editOnce(source, pinned, `export const TIP_TABLE = "${TABLE}";`),
  });
  assert.ok(
    toTenant.some((f) => f.startsWith(`reaches ${TABLE}: `)),
    toTenant.join("\n"),
  );
});

test("#27 a projection the resolver cannot read fails closed and says so", () => {
  const cases = {
    "an unsupported call": {
      [JOBS_LIB]: editOnce(
        diskModule(JOBS_LIB),
        'export const LIST_SELECT = PUBLIC_JOB_SUMMARY_FIELDS.join(",");',
        'export const LIST_SELECT = PUBLIC_JOB_SUMMARY_FIELDS.filter(Boolean).join(",");',
      ),
    },
    "a local binding shadowing the import": {
      [FILTER]: editOnce(
        diskModule(FILTER),
        FETCH_JOBS_OPEN,
        `${FETCH_JOBS_OPEN}  const LIST_SELECT = [companyId].join(",");\n`,
      ),
    },
  };
  for (const [name, overlay] of Object.entries(cases)) {
    const failures = rescan(overlay);
    assert.ok(
      failures.some((f) => f.startsWith(`could not be resolved: ${FETCH_JOBS}`)),
      `${name}: did not fail closed\n    ${failures.join("\n    ")}`,
    );
  }
});

/* ── #65: the table inventory ──────────────────────────────────── */

/** The tables this file actually checks. Everything else read on the surface is in UNSCANNED_TABLES. */
const SCANNED_TABLES = new Set([TABLE]);
const UNSCANNED_REASONS = new Set([
  "pending-classification",
  "company-data-only",
  "different-trust-boundary",
  "no-tenant-data",
]);

/** Receivers whose `.from()` builds a value, not a query. */
const NOT_A_QUERY_ROOT = /^(Array|Buffer|(Big)?(Ui|I)nt\d+(Clamped)?Array|Float\d+Array)$/;

/**
 * Every table READ on the tenant surface, from its own pass over the source.
 *
 * Deliberately not built on the scan above: that one keeps only
 * job_applications sites and skips files that mention neither the table nor
 * `.from(`, and an inventory inheriting either filter would inherit its blind
 * spots. Every source file is parsed here, and every `.from()` that is not a
 * storage bucket or an Array/Buffer constructor must resolve to a table name:
 * a literal, a same-file const, or (through the #27 resolver) an imported
 * const. A name that resolves to nothing is returned in `unresolved`, which
 * the test treats as a failure, never as an absence.
 *
 * A read is a `.from()` whose own chain has no write method, the same rule
 * the scan uses. Pure over its arguments so the controls can feed it snippets.
 */
function tableInventory(files, readModule) {
  const reads = new Map();
  const unresolved = [];
  for (const { rel, text } of files) {
    if (!onTenantSurface(rel, text)) continue;
    const sf = parseModule(rel, text);
    const consts = stringConsts(sf);
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "from" &&
        !isStorageChain(n)
      ) {
        const root = chainRoot(n.expression);
        const arg = n.arguments[0];
        if (!(ts.isIdentifier(root) && NOT_A_QUERY_ROOT.test(root.text))) {
          const write = chainFrom(n).methods.some((m) => WRITES.has(m.name));
          const { table, why } = inventoryTable(arg, consts, { rel, sf, readModule });
          const where = `${rel} ${functionName(n)}(): .from(${arg?.getText().replace(/\s+/g, " ") ?? ""})`;
          if (table === undefined) unresolved.push(`${where}: ${why}`);
          else if (!write) {
            if (!reads.has(table)) reads.set(table, []);
            reads.get(table).push(where);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { reads, unresolved };
}

/** The table a `.from()` argument names: `{ table }`, or `{ why }` when it names none statically. */
function inventoryTable(arg, consts, mod) {
  if (!arg) return { why: "called with no argument" };
  if (ts.isStringLiteralLike(arg)) return { table: arg.text };
  if (ts.isIdentifier(arg) && consts.has(arg.text)) return { table: consts.get(arg.text) };
  const got = resolveExpr(arg, mod);
  if (got.why) return { why: got.why };
  return typeof got.value === "string"
    ? { table: got.value }
    : { why: "it does not resolve to a string" };
}

/** Every way an inventory disagrees with the listed tables. Empty is a pass. */
function inventoryFailures({ reads, unresolved }, listed = UNSCANNED_TABLES) {
  const failures = unresolved.map((u) => `unresolved table name, failing closed: ${u}`);
  for (const [table, where] of reads) {
    if (SCANNED_TABLES.has(table) || Object.hasOwn(listed, table)) continue;
    failures.push(
      `unlisted: ${table} is read on the tenant surface and is neither scanned nor in UNSCANNED_TABLES (${where[0]})`,
    );
  }
  for (const table of Object.keys(listed)) {
    if (SCANNED_TABLES.has(table)) failures.push(`listed as unscanned but scanned: ${table}`);
    else if (!reads.has(table))
      failures.push(
        `stale: ${table} is in UNSCANNED_TABLES and no longer read on the tenant surface`,
      );
  }
  return failures;
}

const treeInventory = () =>
  tableInventory(
    sourceFiles(SRC).map((file) => ({
      rel: relative(SRC, file).split(sep).join("/"),
      text: readFileSync(file, "utf8"),
    })),
    diskModule,
  );

test("#65 every table read on the tenant surface is scanned or listed in UNSCANNED_TABLES", () => {
  const inventory = treeInventory();
  const failures = inventoryFailures(inventory);
  assert.deepEqual(
    failures,
    [],
    `the table inventory does not match:\n    ${failures.join("\n    ")}`,
  );
  // Not vacuous: the scanned table is in the inventory, and so is every listed one.
  assert.ok(inventory.reads.has(TABLE), `the inventory did not find ${TABLE}`);
  assert.equal(inventory.reads.size, SCANNED_TABLES.size + Object.keys(UNSCANNED_TABLES).length);
});

test("#65 every UNSCANNED_TABLES entry carries a known reason and a note", () => {
  for (const [table, entry] of Object.entries(UNSCANNED_TABLES)) {
    assert.ok(UNSCANNED_REASONS.has(entry.reason), `${table}: unknown reason "${entry.reason}"`);
    assert.ok(
      typeof entry.note === "string" && entry.note.trim().length > 0,
      `${table}: empty note`,
    );
  }
});

const GATED_FILE = `${DASH}/inventory-control.ts`;
const snippet = (body, rel = GATED_FILE) => ({ rel, text: `${wrap(body)}\n` });
const onlyListed = { communication_logs: { reason: "pending-classification", note: "x" } };

test("#65 a read of a table absent from UNSCANNED_TABLES fails", () => {
  const inv = tableInventory(
    [
      snippet(
        'await service.from("communication_logs").select("id"); await service.from("brand_new_table").select("id");',
      ),
    ],
    diskModule,
  );
  const failures = inventoryFailures(inv, onlyListed);
  assert.ok(
    failures.some((f) => f.startsWith("unlisted: brand_new_table ")),
    failures.join("\n"),
  );
});

test("#65 a listed table with no read left is stale and fails", () => {
  const inv = tableInventory(
    [snippet('await service.from("communication_logs").insert({ id: 1 });')],
    diskModule,
  );
  const failures = inventoryFailures(inv, onlyListed);
  assert.ok(
    failures.some((f) => f.startsWith("stale: communication_logs ")),
    failures.join("\n"),
  );
});

test("#65 a table name the inventory cannot resolve fails closed", () => {
  const inv = tableInventory([snippet("await service.from(tableName).select('id');")], diskModule);
  const failures = inventoryFailures(inv, {});
  assert.ok(
    failures.some((f) => f.startsWith("unresolved table name, failing closed: ")),
    failures.join("\n"),
  );
});

test("#65 the inventory does not inherit the scan's filters", () => {
  // A surface file that never mentions job_applications, the scan's prefilter
  // key, still has its reads counted; a non-surface file does not; storage
  // buckets and Array.from are not tables; a same-file const is followed.
  const inv = tableInventory(
    [
      snippet(
        'const T = "via_const"; await service.from(T).select("id"); await service.storage.from("cvs").remove([p]); Array.from(xs);',
      ),
      snippet('await service.from("off_surface").select("id");', "app/talent/page.ts"),
    ],
    diskModule,
  );
  assert.deepEqual([...inv.reads.keys()], ["via_const"]);
  assert.deepEqual(inv.unresolved, []);
});
