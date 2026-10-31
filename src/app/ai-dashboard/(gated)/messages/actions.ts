"use server";

import { revalidatePath } from "next/cache";
import { actionFailed } from "@/app/ai-dashboard/lib/action-errors";
import { REDACTED_LINK } from "@/lib/candidate-links";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  canAccessJob,
  getJobScope,
  isEmptyScope,
  scopeJobIds,
} from "@/app/ai-dashboard/lib/job-scope";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import { MANUAL_DEFAULTS } from "@/lib/email/candidate/templates";
import {
  LOG_ONLY_EVENTS,
  type LoggedEvent,
  MESSAGE_EVENTS,
  type MessageEvent,
} from "@/lib/email/candidate/types";
import {
  buildPlaceholders,
  escapeHtml,
  escapePlaceholders,
  renderTemplate,
} from "@/lib/email/candidate/render";
import { toWhatsAppDigits } from "@/lib/normalize";
import { isIdentifierChange } from "@/lib/whatsapp/inbound-display";
import {
  confirmedOwners,
  type MatchRow,
  OWNER_LOOKUP_LIMIT,
  phonePrefilterPattern,
  soleOwnerAt,
} from "@/lib/whatsapp/number-owners";
import {
  APPLICATION_INBOUND_CAP,
  APPLICATION_MESSAGE_CAP,
  type ApplicationInboundRead,
  type ApplicationMessageRead,
  BODY_MAX,
  type InboundMatchBasis,
  type InboundMessageRow,
  MESSAGES_PAGE_SIZE,
  SUBJECT_MAX,
  type ManualTemplate,
  type MessageAggregates,
  type MessageKind,
  type MessagePage,
  type MessageRecipient,
  type MessageRow,
  type MessageTab,
} from "./types";

/**
 * The inbound walk: rows per prefilter page, and how many pages before the
 * read gives up and reports the list as possibly incomplete. Ten pages of a
 * hundred is far past one candidate's replies plus any tail-sharing number's.
 */
const INBOUND_PAGE = 100;
const INBOUND_MAX_PAGES = 10;

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./types.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

type Service = ReturnType<typeof createServiceClient>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many candidates the composer's recipient picker offers.
 *
 * Unchanged from the value this surface has always carried. Worth naming now
 * because it used to bind only scoped recruiters — owner and admin reached it
 * with an empty job filter and so never saw a row at all. With that fixed the
 * cap is live for every role, and the newest 500 by application date is what a
 * company past that size can pick from here.
 */
const RECIPIENT_LIMIT = 500;

/**
 * Rows we never show.
 *
 * 'cancelled' is a tombstone written by cancelPendingRejection to stop a
 * scheduled rejection that the recruiter took back. It has no subject, no
 * recipient and never reached anyone — listing it would put an empty row in
 * the log for something that deliberately did not happen.
 */
const HIDDEN_STATUS = "cancelled";

/**
 * Messages whose applicant has been deleted are hidden from this page.
 *
 * communication_logs.application_id is ON DELETE SET NULL, so the row survives
 * the applicant — which is right for the record and wrong for this surface.
 * Deleting an applicant already destroys their CV, their scorecard and their
 * pipeline history; the product's delete means erasure, and it is usually a
 * company acting on an erasure request. A Messages page that kept showing the
 * person's address and the text of what we wrote them would be the one place
 * their data survived, which defeats the delete.
 *
 * The ROW is untouched. It keeps its provider_id and its 'sent' status, so the
 * daily-cap accounting is unaffected and the record is still there in the
 * database for anyone who needs to prove the send happened. What changes is
 * only that it stops being rendered.
 *
 * Applied to the list, every aggregate and the sidebar badge together — a
 * filter on one of those and not the others is how a tab ends up disagreeing
 * with the rows beneath it. Written inline at each site rather than behind a
 * generic helper: wrapping the PostgREST builder in one defeats its type
 * inference (TS2589), and a mis-typed query is worse than a repeated pair.
 */
const ORPHAN_COLUMN = "application_id";

/**
 * How a stored row reads in the UI.
 *
 * Order matters: a queued row is Scheduled whatever its event, and a failed
 * row is Failed even though it was written by a person — the recruiter needs
 * to see that it did not arrive before they see who wrote it.
 */
function kindOf(event: string, status: string): MessageKind {
  if (status === "queued") return "scheduled";
  if (status === "failed") return "failed";
  return event === "manual" ? "written" : "automatic";
}

/**
 * The stored body is a full HTML document — the same one the candidate got.
 * The viewer shows what was said, not how it was marked up, so tags come out
 * and block boundaries become line breaks.
 */
function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type LogRow = {
  id: string;
  application_id: string | null;
  event: string | null;
  status: string | null;
  to_address: string | null;
  subject: string | null;
  body: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  sent_by_name: string | null;
  created_at: string;
};

type AppLite = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  /** Embedded live job. Null once the job is deleted. */
  jobs?: { title: string | null } | null;
};

/**
 * The role to show for an application.
 *
 * LIVE title first, the snapshot only as a fallback. job_title_snapshot is
 * written exactly twice in the codebase — by deleteCompanyJob and the admin
 * equivalent, immediately before the job row goes away — so it is null for
 * every application whose job still exists, which is nearly all of them.
 * Reading it alone is why this column rendered "—" for everybody.
 *
 * Same order Applicants, Overview, admin Applications and the dispatcher
 * already use; see CompanyApplicantRow.job_title.
 */
function roleOf(app: AppLite | undefined, fallback: string): string {
  return (
    app?.jobs?.title?.trim() || app?.job_title_snapshot?.trim() || fallback
  );
}

/**
 * May this viewer see (and write to) this applicant?
 *
 * Resolves the application's job server-side and checks the hiring team.
 * Company ownership is checked in the same query, so a caller gets one answer
 * for both boundaries and cannot satisfy one while missing the other.
 */
async function canSeeApplication(
  ctx: Awaited<ReturnType<typeof getCompanyContext>>,
  applicationId: string,
): Promise<boolean> {
  if (!applicationId) return false;
  const { data } = await createServiceClient()
    .from("job_applications")
    .select("id, job_id, company_id_snapshot")
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();
  const row = data as { job_id: string | null } | null;
  if (!row) return false;
  return canAccessJob(ctx, row.job_id ?? "");
}

/**
 * Narrow a stored event string back to the union, defaulting to 'manual'.
 *
 * LOG_ONLY_EVENTS is checked alongside MESSAGE_EVENTS because
 * communication_logs.event is a wider vocabulary than message_templates.event —
 * `interview_reminder` is written by the reminder handler and has no template
 * row. Without it, re-sending a scheduled reminder from the Messages page would
 * relabel it 'manual' on the way back out, filing an automatic message under
 * Written and writing the replacement row against the wrong event.
 */
function asEvent(value: string | null): LoggedEvent {
  const candidate = value ?? "";
  const known: readonly string[] = [...MESSAGE_EVENTS, ...LOG_ONLY_EVENTS];
  return known.includes(candidate) ? (candidate as LoggedEvent) : "manual";
}

function fullName(first: string | null, last: string | null, fallback: string): string {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || fallback;
}

/**
 * Hydrate log rows with the candidate they were sent to.
 *
 * A second query rather than a join: PostgREST embeds would need a declared FK
 * and would silently drop rows whose application has since been deleted. The
 * log outlives the application on purpose — a sent email is a fact about the
 * past — so a missing application degrades to the stored to_address.
 */
async function hydrate(
  ctx: Awaited<ReturnType<typeof getCompanyContext>>,
  service: Service,
  logs: LogRow[],
): Promise<MessageRow[]> {
  const ids = [...new Set(logs.map((l) => l.application_id).filter(Boolean))] as string[];
  const byId = new Map<string, AppLite>();

  // Chunked: a company with a long log would otherwise overflow the URL.
  for (let i = 0; i < ids.length; i += 200) {
    /*
     * Filtered on the company, not only on the ids. The ids arrive off
     * communication_logs rows already scoped to ctx.companyId, but that is a
     * write-time invariant — nothing ties a log's company to its application's
     * company_id_snapshot, and the only foreign key here points at
     * job_applications(id) alone. This read returns name, email and job title,
     * so it checks for itself rather than trusting the caller's ids.
     */
    const { data } = await service
      .from("job_applications")
      .select("id, first_name, last_name, email, job_id, job_title_snapshot, jobs(title)")
      .eq("company_id_snapshot", ctx.companyId)
      .in("id", ids.slice(i, i + 200));
    for (const row of (data ?? []) as unknown as AppLite[]) byId.set(row.id, row);
  }

  return logs.map((l) => {
    const app = l.application_id ? byId.get(l.application_id) : undefined;
    const email = (app?.email ?? l.to_address ?? "").trim();
    // No application row means the applicant was deleted. Naming them by the
    // address we mailed would put the identity straight back on screen, so the
    // row says what is true instead. Reachable only defensively now that
    // visibleOnly() hides these, and correct if they are ever surfaced.
    const deleted = l.application_id === null || app === undefined;
    const status = l.status ?? "sent";
    const event = l.event ?? "manual";
    return {
      id: l.id,
      applicationId: l.application_id,
      candidateName: deleted
        ? "Deleted applicant"
        : fullName(app?.first_name ?? null, app?.last_name ?? null, email),
      candidateEmail: deleted ? "" : email,
      jobId: app?.job_id ?? null,
      jobTitle: roleOf(app, "—"),
      subject: l.subject ?? "",
      body: htmlToPlain(l.body ?? ""),
      event,
      status,
      kind: kindOf(event, status),
      sentByName: (l.sent_by_name ?? "").trim() || null,
      sentAt: l.sent_at,
      scheduledFor: l.scheduled_for,
      createdAt: l.created_at,
    };
  });
}

/** Narrow a base query to one tab. Kept in one place so the list and the
 *  count can never disagree about what a tab means. */
function applyTab<T extends { eq: (c: string, v: unknown) => T; neq: (c: string, v: unknown) => T }>(
  q: T,
  tab: MessageTab,
): T {
  if (tab === "scheduled") return q.eq("status", "queued");
  if (tab === "written") return q.eq("event", "manual").neq("status", "queued");
  if (tab === "automatic") return q.neq("event", "manual").neq("status", "queued");
  return q;
}

/**
 * Workspace counts for the tabs, the hero and the footer total.
 *
 * Six HEAD counts, company-scoped, so nothing depends on which page the user
 * happens to be looking at. all = written + automatic + scheduled exactly.
 */
export async function fetchMessageAggregates(): Promise<Read<MessageAggregates>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /*
   * communication_logs has no job_id, so per-job scoping travels through the
   * applications belonging to scoped jobs — but through the JOIN, not through
   * an application-id allow-list.
   *
   * The old shape resolved every application id the member could see and passed
   * the array to `.in("application_id", allowedApps)`. That list was unbounded.
   * One uuid costs 39 bytes in a PostgREST query string, so somewhere between
   * 204 and 415 ids the request line crosses a gateway limit and PostgREST
   * answers 414 — which supabase-js reports as an `error` beside a null count
   * rather than throwing. Every `count ?? 0` below would then read 0, so the
   * page would tell a recruiter they have no messages while the list underneath
   * showed some. Seven counts, silently wrong, together.
   *
   * Filtering on the embedded job_id costs one bounded `.in()` over the
   * member's jobs instead, and scopedApplicationIds is no longer called here at
   * all — which is also what removes this site's exposure to its unordered
   * `.range()` paging.
   */
  const scope = await getJobScope(ctx);
  // Fails closed before the database, like fetchRecipients: `.in(col, [])`
  // matches no rows, but it is not worth a request to learn that.
  if (isEmptyScope(scope)) {
    return answered({
      all: 0, written: 0, automatic: 0, scheduled: 0,
      sent: 0, failed: 0, sentThisWeek: 0,
    });
  }

  /*
   * A FUNCTION, deliberately — not a shared builder. postgrest-js filter
   * methods mutate the builder and return `this` (PostgrestFilterBuilder.ts:171
   * and friends), so one builder shared across the seven callers below would
   * accumulate every one of their filters. `.select()` is what clones, so each
   * call here gets its own request.
   *
   * `!inner` is load-bearing twice. It excludes the null application_id that
   * `.not(ORPHAN_COLUMN, "is", null)` excluded, because a non-null FK always
   * resolves to a live row. And without it PostgREST builds a LEFT join and the
   * embedded filters stop restricting the logs at all — the cv-purge.ts:309
   * failure mode. Verified read-only against production: 146 either way, and
   * 231 once the join is widened.
   *
   * The callers chain `status`, `event` and `sent_at`. job_applications also has
   * a `status` column, but an unprefixed filter binds to the top-level resource,
   * so none of them become ambiguous under the join — only the
   * `job_applications.`-prefixed filters below reach the embed. Verified
   * read-only against production: `status=eq.new` is impossible on a log and
   * common on an application, and counts 0 through the embed.
   */
  const base = () => {
    const q = service
      .from("communication_logs")
      .select("id, job_applications!inner(job_id, company_id_snapshot)", {
        count: "exact",
        head: true,
      })
      .eq("company_id", ctx.companyId)
      .neq("status", HIDDEN_STATUS)
      // Unconditional, not inside the scoped branch below. The job-id filter is
      // what narrows a recruiter; THIS is the tenant boundary on the joined
      // side, and every role needs it. It also has to be unconditional to be
      // honest: tenant-isolation.test.ts reads this as source text and cannot
      // tell a conditional filter from an applied one, so a version that only
      // filtered when scoped would show green while owners read the join
      // unguarded. Verified read-only against production: 146 with it and 146
      // without, so no count moves.
      .eq("job_applications.company_id_snapshot", ctx.companyId);
    return scope.scoped ? q.in("job_applications.job_id", scope.jobIds) : q;
  };

  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();

  const [all, written, automatic, scheduled, sent, failed, thisWeek] = await Promise.all([
    base(),
    applyTab(base(), "written"),
    applyTab(base(), "automatic"),
    applyTab(base(), "scheduled"),
    base().eq("status", "sent"),
    base().eq("status", "failed"),
    base().eq("status", "sent").gte("sent_at", weekAgo),
  ]);

  return answered({
    all: all.count ?? 0,
    written: written.count ?? 0,
    automatic: automatic.count ?? 0,
    scheduled: scheduled.count ?? 0,
    sent: sent.count ?? 0,
    failed: failed.count ?? 0,
    sentThisWeek: thisWeek.count ?? 0,
  });
}

/**
 * One page of the log under the active filters.
 *
 * `matching` is the count for THESE filters and drives pagination only. The
 * tab badges come from fetchMessageAggregates and are deliberately unaffected
 * by the search box.
 */
export async function fetchMessages(input: {
  tab: MessageTab;
  jobId: string;
  search: string;
  page: number;
}): Promise<Read<MessagePage>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /*
   * Scoped through the JOIN, not through an application-id allow-list — the
   * same replacement fetchMessageAggregates carries above, for the same reason.
   *
   * The old shape resolved every application id the member could see and passed
   * the array to `.in("application_id", allowedApps)`. That list was unbounded.
   * Measured against production: one uuid costs 37 bytes in a PostgREST query
   * string, and the request line stops being answered between 668 and 675 ids
   * (~25 kB), where PostgREST replies 400. supabase-js reports that as an
   * `error` beside a null count rather than throwing, so the old `count ?? 0`
   * read 0 and the page told a recruiter they had no messages — over a list
   * that also came back empty, because the same filter was on both queries.
   *
   * Filtering on the embedded job_id costs one bounded `.in()` over the
   * member's jobs instead, and scopedApplicationIds is no longer called here at
   * all — which is also what removes this site's exposure to its unordered
   * `.range()` paging.
   */
  const scope = await getJobScope(ctx);
  // Fails closed before the database, as the aggregates do: `.in(col, [])`
  // matches no rows, but it is not worth a request to learn that.
  if (isEmptyScope(scope)) return answered({ rows: [], matching: 0 });

  const tab: MessageTab = input.tab;
  const search = (input.search ?? "").trim();
  const page = Math.max(0, Math.trunc(input.page ?? 0));

  /*
   * This read resolves applicant NAMES only. The job filter used to come
   * through here as well, and that was a leak.
   *
   * The old shape turned the chosen job into a list of application ids and gave
   * it to `.in("application_id", …)` on the log query. With a search also
   * present that list became one side of an `or()` — and an `or()` is a
   * disjunction, so the `subject.ilike` side matched logs on EVERY job the
   * viewer could see. Measured on production: an owner filtering to the busiest
   * job and searching a broad needle was served 144 rows where 47 were that
   * job's. The filter could not be rescued from here, because the job predicate
   * cannot join the disjunction: PostgREST answers PGRST100 for an `or()`
   * spanning a parent column and an embedded one (measured). To bind the whole
   * disjunction it has to AND with it, which means it has to sit on the builder
   * — see build() below.
   *
   * It is still narrowed by the chosen job, even though the builder's `eq` is
   * what enforces correctness now. The caps here and in build() are NOT
   * URL-limit guards — 500 ids is 18.5 kB and answers fine, measured — they
   * silently truncate, and keeping this filter spends the 1000/300 budget on
   * the one job rather than across every application in scope. Dropping it
   * would make the name search begin truncating at a LOWER applicant count
   * than it does today. The truncation is its own follow-up.
   */
  let appIds: string[] | null = null;
  if (search) {
    let q = service
      .from("job_applications")
      .select("id, first_name, last_name, email, job_title_snapshot, jobs(title)")
      .eq("company_id_snapshot", ctx.companyId)
      .limit(1000);
    if (scope.scoped) q = q.in("job_id", scope.jobIds);
    if (input.jobId) q = q.eq("job_id", input.jobId);
    const { data, error } = await q;
    // An unread filter is not an empty filter. Falling through with `data ??
    // []` turns a failed request into `appIds = []`, and an empty appIds means
    // "no applicant matched" — so a broken read would render as a confident
    // "No messages" for a filter the user can see is set.
    if (error) return unavailable();
    // Unguarded now: the only way into this block is a non-empty search, so the
    // `if (search)` that used to wrap this was always true once the job filter
    // stopped entering here.
    const needle = search.toLowerCase();
    const rows = ((data ?? []) as unknown as AppLite[]).filter((r) =>
      [r.first_name, r.last_name, r.email, roleOf(r, "")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
    appIds = rows.map((r) => r.id);
  }

  // A search that matches no applicant still has to match subjects, so the id
  // list is only ever one side of an OR. The job filter is no longer one of its
  // sides; it is an embedded predicate that ANDs with the whole disjunction.
  const build = (head: boolean) => {
    let q = service
      .from("communication_logs")
      // One literal projection for both shapes, deliberately. The count request
      // used to select a shorter list, which made this argument a ternary — and
      // tenant-isolation.test.ts can only recognise an embedded read of
      // job_applications when it can read the select() argument as a string
      // literal. A ternary is dropped before the site is ever recorded, so the
      // tenant filter below was unverified by the scanner; a negative control
      // confirmed it, failing the moment this became a literal. `head: true`
      // returns no body, so the wider projection changes nothing in the
      // response and the count comes off the same filters and the same join.
      .select(
        "id, application_id, event, status, to_address, subject, body, scheduled_for, sent_at, sent_by_name, created_at, job_applications!inner(job_id, company_id_snapshot)",
        head ? { count: "exact", head: true } : undefined,
      )
      .eq("company_id", ctx.companyId)
      .neq("status", HIDDEN_STATUS)
      .not(ORPHAN_COLUMN, "is", null)
      // Unconditional, not inside the scoped branch below. The job-id filter is
      // what narrows a recruiter; THIS is the tenant boundary on the joined
      // side, and every role needs it. It also has to be unconditional to be
      // honest: tenant-isolation.test.ts reads this as source text and cannot
      // tell a conditional filter from an applied one.
      .eq("job_applications.company_id_snapshot", ctx.companyId);

    if (scope.scoped) q = q.in("job_applications.job_id", scope.jobIds);

    // The job filter, on the same embedded column the scope above uses.
    // Measured against production: two filters on one embedded column AND, in
    // either order — neither overwrites the other — so a job outside the
    // member's scope intersects to nothing instead of being honoured.
    // Unconditional with respect to search, deliberately: this is the predicate
    // the subject side of the or() below cannot escape, and exactness at any
    // applicant count is what the id list could not give.
    if (input.jobId) q = q.eq("job_applications.job_id", input.jobId);

    q = applyTab(q, tab);

    if (appIds !== null) {
      const idList = appIds.slice(0, 300);
      q = idList.length
        ? q.or(`subject.ilike.%${search}%,application_id.in.(${idList.join(",")})`)
        : q.ilike("subject", `%${search}%`);
    }
    return q;
  };

  const from = page * MESSAGES_PAGE_SIZE;
  const [total, listed] = await Promise.all([
    build(true),
    build(false)
      .order("created_at", { ascending: false })
      // created_at alone is not a total order: the seed puts 300 logs on one
      // timestamp and real sends share seconds too. Rows sharing a created_at
      // had no defined order between pages, so a page boundary inside a tie
      // could show one row twice and another never. id is unique; this closes
      // #23. Pinned by scripts/staging/query-order.test.mjs.
      .order("id", { ascending: false })
      .range(from, from + MESSAGES_PAGE_SIZE - 1),
  ]);

  /*
   * A failed read is not an empty page.
   *
   * `count ?? 0` is what made the overflow silent: supabase-js answers a 4xx
   * with `{ data: null, error, count: null }` instead of throwing, so the page
   * rendered "No messages" and a zero total. The join removes that particular
   * 400, but it is not the only way a request fails, and the honest answer to
   * an unread page is "we could not load this" — which is what Read's
   * unavailable() renders. A null count beside no error is counted as a failure
   * too: `count: "exact"` always carries one, so its absence means the response
   * was not what we asked for, and pagination built on a guess is worse than
   * none.
   */
  if (total.error || listed.error || total.count === null) return unavailable();

  return answered({
    rows: await hydrate(ctx, service, (listed.data ?? []) as unknown as LogRow[]),
    matching: total.count,
  });
}

/** The message trail for one applicant, for the drawer. Ownership-checked. */
export async function fetchApplicationMessages(
  applicationId: string,
): Promise<ApplicationMessageRead> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  // The drawer opens on one applicant, so the list's allow-list never ran.
  // Denied is `ok` with nothing in it: there is no failure to report, the
  // reader simply may not see this person's mail.
  if (!(await canSeeApplication(ctx, applicationId))) {
    return { ok: true, rows: [], truncated: false };
  }

  // One row PAST the cap. Asking for exactly the cap and getting it back can't
  // distinguish "there are this many" from "there are more", and a count query
  // to settle it would be a second round-trip for a number we can read off the
  // end of this one.
  const { data, error } = await service
    .from("communication_logs")
    .select(
      "id, application_id, event, status, to_address, subject, body, scheduled_for, sent_at, sent_by_name, created_at",
    )
    .eq("company_id", ctx.companyId)
    .eq("application_id", applicationId)
    .neq("status", HIDDEN_STATUS)
    .order("created_at", { ascending: false })
    .limit(APPLICATION_MESSAGE_CAP + 1);

  if (error) {
    console.error("[messages] fetchApplicationMessages failed:", error.message);
    return { ok: false, rows: [], truncated: false };
  }

  const logs = (data ?? []) as unknown as LogRow[];
  const truncated = logs.length > APPLICATION_MESSAGE_CAP;

  return {
    ok: true,
    rows: await hydrate(ctx, service, truncated ? logs.slice(0, APPLICATION_MESSAGE_CAP) : logs),
    truncated,
  };
}

/**
 * This candidate's inbound WhatsApp, for the drawer. Ownership-checked twice:
 * once for the viewer, once for the number.
 *
 * ── Why this matches on the phone and not on `application_id` ──
 *
 * `whatsapp_inbound.application_id` and `.company_id` are written once, by the
 * webhook's resolveTenancy, and only when the sender's number maps to one
 * person: a single application, or several that `isOnePerson` accepts. For a
 * candidate who applied to two companies from one phone, that rule attaches
 * the message to the NEWEST application's company - not to the company whose
 * message they were answering, which nothing in the row records: every tenant
 * sends from the one business number, and no reply context is parsed. So the
 * stored company_id is wrong by construction for exactly the candidates a
 * company filter would be protecting, and filtering on it would look correct
 * while being wrong. It is deliberately not consulted here.
 *
 * The drawer already knows which applicant is open, so it asks "is this
 * message from THIS applicant's number?" - `toWhatsAppDigits` on both sides,
 * the same function the webhook normalises with, so the two agree by
 * construction.
 *
 * ── The rule that decides whether to show anything (#64) ──
 *
 * Rows render only when the applicant's number maps to exactly ONE person at
 * exactly ONE company, and that company is the viewer's - `soleOwnerAt`, the
 * decision resolveTenancy already makes for attachment, applied at read time.
 * The owner lookup is the webhook's own prefilter run across ALL companies'
 * applications: it has to be, because "does anyone else, at any company, hold
 * this number" cannot be answered inside one company's rows. Those rows are
 * never rendered; they are compared, then dropped.
 *
 * Anything else renders the `number-not-unique` basis note instead of rows:
 * the same person at a second company, two different people on one phone, an
 * owner lookup that failed, or one whose page came back full and may be
 * incomplete. Fail closed on every one of them. The note says the replies
 * cannot be attributed with certainty and nothing more, because "this
 * candidate also applied elsewhere" is itself a fact the viewer must not learn
 * here.
 *
 * ── The cost, stated ──
 *
 * Measured on 2026-09-30 over 3,396 applications: 2,675 distinct normalisable
 * numbers, 364 shared by one person applying twice (still shown), and 8 shared
 * by different people. Those 8, and every candidate with applications at more
 * than one company, now see a note where they used to see replies. The
 * recruiter LOSES information they could read before. That is the trade and
 * it is the right way round - a stranger's private messages under another
 * candidate's name, or company B's conversation inside company A's drawer, is
 * worse than a missing tab - and it is written here so it is not rediscovered
 * later as a regression.
 *
 * ── Why this is the interim and not the answer ──
 *
 * The permanent fix is attribution at ingest. Meta sends `context.id` on a
 * reply - the id of the message being answered - and `communication_logs`
 * already stores every outbound WhatsApp id in `provider_message_id` beside
 * its company_id and application_id. Capturing context.id in the webhook and
 * joining it would attribute a reply to the company that was written to, with
 * no guessing from the phone at all. That changes the webhook and what the
 * row records, so it is a separate pass; this read-time rule is what stops the
 * leak until then, at the cost above.
 *
 * ── Why the inbound read pages instead of taking one capped slice ──
 *
 * The nine-digit prefilter on `from_phone` can match a DIFFERENT number that
 * shares the tail. A single `.limit(cap + 1)` taken before the exact match
 * could be filled entirely by that other number's rows, and the candidate's
 * own replies would then be cut off silently. So the read walks the prefilter
 * in ordered pages - newest first, id as the tiebreaker, so the sequence is
 * total - confirms each page by exact number, and stops once the cap is
 * exceeded or the prefilter runs out. Bounded by INBOUND_MAX_PAGES; a walk
 * that hits the bound reports `truncated` rather than claiming completeness.
 */
export async function fetchApplicationInbound(
  applicationId: string,
): Promise<ApplicationInboundRead> {
  const empty = (basis: InboundMatchBasis): ApplicationInboundRead => ({
    ok: true,
    rows: [],
    basis,
    truncated: false,
  });
  const failed: ApplicationInboundRead = { ok: false, rows: [], basis: "phone", truncated: false };

  const ctx = await getCompanyContext();
  const service = createServiceClient();

  if (!(await canSeeApplication(ctx, applicationId))) return empty("phone");

  const { data: appData, error: appError } = await service
    .from("job_applications")
    .select("phone")
    .eq("id", applicationId)
    .maybeSingle();

  if (appError) {
    console.error("[whatsapp] applicant phone read failed:", appError.message);
    return failed;
  }

  const stored = ((appData as { phone: string | null } | null)?.phone ?? "").trim();
  if (!stored) return empty("no-phone-on-file");

  // Null means the number is not a shape toWhatsAppDigits will vouch for —
  // 268 applications are in that position, and a WhatsApp reply from one of
  // them could never reach this tab. The caller says so rather than showing an
  // empty list that reads as "they have not replied".
  const digits = toWhatsAppDigits(stored);
  if (!digits) return empty("phone-not-normalisable");

  const pattern = phonePrefilterPattern(digits);

  // Who holds this number, at ANY company. Deliberately unscoped - see the
  // docblock - and never rendered: compared, then dropped.
  const { data: ownerRows, error: ownerError } = await service
    .from("job_applications")
    .select("id, phone, email, first_name, last_name, company_id_snapshot")
    .filter("phone", "imatch", pattern)
    .order("created_at", { ascending: false })
    .limit(OWNER_LOOKUP_LIMIT);

  if (ownerError) {
    console.error("[whatsapp] number ownership lookup failed:", ownerError.message);
    return failed;
  }
  const prefiltered = (ownerRows ?? []) as MatchRow[];
  // A full page may be an incomplete one, and an incomplete set of owners
  // cannot prove the number is unique. Refused, not trusted.
  if (prefiltered.length >= OWNER_LOOKUP_LIMIT) return empty("number-not-unique");
  if (!soleOwnerAt(confirmedOwners(prefiltered, digits), applicationId, ctx.companyId)) {
    return empty("number-not-unique");
  }

  type InboundDbRow = {
    id: string;
    from_phone: string | null;
    body: string | null;
    message_type: string | null;
    received_at: string | null;
  };

  // The prefilter is a cheap narrowing; the normaliser is the actual test.
  // Identifier changes are dropped here rather than rendered: they are account
  // events, not something the candidate said, and /admin/whatsapp already
  // carries them where there is room to explain what they mean.
  const matched: InboundDbRow[] = [];
  let exhausted = false;
  for (
    let page = 0;
    page < INBOUND_MAX_PAGES && matched.length <= APPLICATION_INBOUND_CAP;
    page += 1
  ) {
    const from = page * INBOUND_PAGE;
    const { data, error } = await service
      .from("whatsapp_inbound")
      .select("id, from_phone, body, message_type, received_at")
      .filter("from_phone", "imatch", pattern)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + INBOUND_PAGE - 1);

    if (error) {
      console.error("[whatsapp] fetchApplicationInbound failed:", error.message);
      return failed;
    }

    const rows = (data ?? []) as InboundDbRow[];
    for (const r of rows) {
      if (
        toWhatsAppDigits(r.from_phone) === digits &&
        !isIdentifierChange(r.message_type ?? "unknown")
      ) {
        matched.push(r);
      }
    }
    if (rows.length < INBOUND_PAGE) {
      exhausted = true;
      break;
    }
  }

  // Over the cap, or the walk stopped before the prefilter ran out: either
  // way the list is not known to be complete.
  const truncated = matched.length > APPLICATION_INBOUND_CAP || !exhausted;
  const kept = matched.slice(0, APPLICATION_INBOUND_CAP);

  return {
    ok: true,
    basis: "phone",
    truncated,
    rows: kept.map((r) => ({
      id: r.id,
      body: r.body || null,
      messageType: r.message_type ?? "unknown",
      receivedAt: r.received_at ?? "",
    })) satisfies InboundMessageRow[],
  };
}

/**
 * Candidates this company can write to. Every role may email.
 *
 * The job filter is OMITTED for owner and admin rather than passed as an empty
 * list. `.in("job_id", [])` matches no rows, so the ternary this replaces
 * emptied the composer for exactly the two roles entitled to the whole company
 * — see the same warning in `job-scope.ts` and `search-actions.ts`.
 *
 * RECIPIENT_LIMIT bounds the dropdown, so a company past that many applicants
 * cannot reach the remainder from this picker. The drawer composer, which is
 * fed the one applicant it has open, is unaffected.
 */
export async function fetchRecipients(): Promise<MessageRecipient[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  // The composer may only offer candidates the sender can already see. An
  // assigned-to-nothing member never reaches a query at all.
  const recipientScope = await getJobScope(ctx);
  if (isEmptyScope(recipientScope)) return [];
  const allowedJobIds = scopeJobIds(recipientScope);

  // The company filter is applied unconditionally; job scoping narrows within a
  // tenant and is never the tenant boundary.
  const scoped = service
    .from("job_applications")
    .select("id, first_name, last_name, email, job_title_snapshot, jobs(title), created_at")
    .eq("company_id_snapshot", ctx.companyId)
    .not("email", "is", null);

  const { data } = await (allowedJobIds ? scoped.in("job_id", allowedJobIds) : scoped)
    .order("created_at", { ascending: false })
    .limit(RECIPIENT_LIMIT);

  return ((data ?? []) as unknown as (AppLite & { created_at: string })[])
    .filter((r) => (r.email ?? "").trim())
    .map((r) => ({
      applicationId: r.id,
      name: fullName(r.first_name, r.last_name, (r.email ?? "").trim()),
      email: (r.email ?? "").trim(),
      jobTitle: roleOf(r, "—"),
    }));
}

/**
 * Templates offered in the composer picker.
 *
 * Resolved BY KEY, which is the whole point of message_templates.template_key:
 * a company row carrying `default:invite-interview` REPLACES Remotiv's
 * template of that key rather than appearing next to it. Before the column
 * existed every composer template shared event='manual' with nothing to match
 * on, so an edited template showed up as a second entry and the original kept
 * being offered — which is the bug this fixes.
 *
 * Order: the shipped templates in their authored order (each showing whichever
 * copy is in force), then any the company wrote itself, newest last.
 *
 * Remotiv's own copy still comes from CODE, so an environment with an empty
 * message_templates table offers a complete picker.
 */
export async function fetchManualTemplates(): Promise<ManualTemplate[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("message_templates")
    .select("id, template_key, subject, body")
    .eq("company_id", ctx.companyId)
    .eq("event", "manual")
    .eq("channel", "email")
    .not("template_key", "is", null)
    .order("created_at", { ascending: true })
    .limit(100);

  const own = new Map<string, { subject: string; body: string }>();
  const custom: ManualTemplate[] = [];

  for (const row of (data ?? []) as {
    template_key: string | null;
    subject: string | null;
    body: string | null;
  }[]) {
    const key = (row.template_key ?? "").trim();
    if (!key || !row.subject || !row.body) continue;
    own.set(key, { subject: row.subject, body: row.body });
    if (!key.startsWith("default:")) {
      custom.push({
        id: key,
        subject: row.subject,
        body: row.body,
        label: row.subject.slice(0, 60),
      });
    }
  }

  const shipped = MANUAL_DEFAULTS.map((t) => {
    const override = own.get(t.id);
    return {
      id: t.id,
      subject: override?.subject ?? t.subject,
      body: override?.body ?? t.body,
      label: t.label,
    };
  });

  return [...shipped, ...custom];
}

/**
 * Send a message a person wrote, right now.
 *
 * Immediate rather than queued: a recruiter pressing Send is waiting for an
 * answer and needs to know it left. The cost is that a Resend outage surfaces
 * as a failed send instead of a retry — which is the correct trade here,
 * because a message that quietly retries twenty minutes later is worse than
 * one the sender knows to try again.
 *
 * The recipient's address is resolved from the application id server-side and
 * never taken from the client: a posted email field would let any member mail
 * an arbitrary address under the company's name.
 */
export async function sendManualMessage(input: {
  applicationId: string;
  subject: string;
  body: string;
}): Promise<MutationResult<{ logId: string }>> {
  // Every role, including hiring managers — writing to a candidate you are
  // already allowed to see is not a privileged action.
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const applicationId = (input.applicationId ?? "").trim();
  if (!applicationId) {
    return { success: false, error: "Choose who this email goes to." };
  }

  const subject = (input.subject ?? "").trim();
  if (!subject) return { success: false, error: "Add a subject line." };
  if (subject.length > SUBJECT_MAX) {
    return { success: false, error: `Subject is over ${SUBJECT_MAX} characters.` };
  }

  const body = (input.body ?? "").trim();
  if (!body) return { success: false, error: "Write a message before sending." };
  if (body.length > BODY_MAX) {
    return {
      success: false,
      error: `Message is over the ${BODY_MAX.toLocaleString()} character limit.`,
    };
  }

  // Ownership: the application must belong to THIS company. Scoped on
  // company_id_snapshot like every other applicant query, so a member cannot
  // reach another tenant's candidate by guessing an id.
  const { data: appData } = await service
    .from("job_applications")
    .select(
      "id, first_name, last_name, email, job_title_snapshot, jobs(title), company_id_snapshot",
    )
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  const app = appData as unknown as (AppLite & { company_id_snapshot: string }) | null;
  if (!app) return { success: false, error: "That applicant isn't in your workspace." };
  // Same message for not-yours as for not-found, as everywhere else.
  if (!(await canAccessJob(ctx, app.job_id ?? ""))) {
    return { success: false, error: "That applicant isn't in your workspace." };
  }

  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) return { success: false, error: "This applicant has no email address." };

  const { data: companyData } = await service
    .from("companies")
    .select("name, candidate_reply_email")
    .eq("id", ctx.companyId)
    .maybeSingle();
  const company = companyData as {
    name: string | null;
    candidate_reply_email: string | null;
  } | null;
  const companyName = (company?.name ?? "").trim();

  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle: roleOf(app, ""),
    companyName,
  });

  const renderedSubject = renderTemplate(subject, values);
  // The recruiter typed plain text. Escaping first is what stops a pasted
  // angle bracket becoming markup in the candidate's client; the newline
  // conversion then rebuilds the paragraphs they actually intended.
  const renderedBody = renderTemplate(escapeHtml(body), escapePlaceholders(values))
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");

  const html = buildCandidateHtml(renderedBody, companyName, ctx.companyId, to);

  /*
   * Opt-outs do NOT block a manual send, and the sender sees no warning: this
   * is a person answering a person, not a broadcast, and an unsubscribe from
   * automated updates was never consent to be ignored by a human.
   *
   * It is recorded, though. The log row carries the note so the fact is
   * auditable later — `error` is the only free-text column on the table, and
   * it is written on a SENT row here, which is worth knowing when reading it.
   */
  const { data: optOut } = await service
    .from("communication_opt_outs")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("email", to)
    .maybeSingle();

  const note = optOut
    ? `Note: sent manually to a recipient who opted out of automated updates. Sender: ${ctx.memberName}.`
    : undefined;

  const outcome = await deliverEmail(service, {
    companyId: ctx.companyId,
    applicationId,
    event: "manual",
    to,
    subject: renderedSubject,
    html,
    companyName,
    replyTo: (company?.candidate_reply_email ?? "").trim() || null,
    note,
    sentByName: ctx.memberName,
  });

  if (!outcome.ok) {
    // The cap message is written for the sender, not for a log — someone is
    // waiting on this reply, so they are told plainly rather than finding a
    // silently skipped row later.
    return { success: false, error: outcome.message };
  }

  revalidatePath("/ai-dashboard/messages");
  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { logId: outcome.logId } };
}

/**
 * Cancel a scheduled message before it sends.
 *
 * Writes the SAME 'cancelled' tombstone the stage-change path already uses:
 * the dispatcher's first act is to look for a log row for this
 * (application, event) in ('queued','sent','skipped','cancelled') and return
 * if it finds one, so flipping this row to 'cancelled' makes the scheduled job
 * exit quietly when it fires. There is no background_jobs row to hunt down and
 * no second mechanism to keep in step.
 */
export async function cancelScheduledMessage(
  logId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data: existing } = await service
    .from("communication_logs")
    .select("id, status, application_id")
    .eq("id", logId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  const row = existing as {
    id: string;
    status: string;
    application_id: string | null;
  } | null;
  if (!row) return { success: false, error: "That message isn't in your workspace." };
  if (!(await canSeeApplication(ctx, row.application_id ?? ""))) {
    return { success: false, error: "That message isn't in your workspace." };
  }

  // Only a message that has not gone out can be cancelled. A 'sent' row means
  // the candidate has it; marking that cancelled would make the log lie.
  if (row.status !== "queued") {
    return { success: false, error: "This message has already been sent." };
  }

  const { error } = await service
    .from("communication_logs")
    .update({ status: "cancelled", error: "Cancelled from Messages." })
    .eq("id", row.id)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: actionFailed("cancel that scheduled message", error) };

  revalidatePath("/ai-dashboard/messages");
  return { success: true, data: undefined };
}

/** Jobs to populate the page's job filter. */
export async function fetchMessageJobs(): Promise<{ id: string; title: string }[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  // The filter dropdown must not name a job the viewer can't open.
  const scope = await getJobScope(ctx);
  if (scope.scoped && scope.jobIds.length === 0) return [];

  let q = service
    .from("jobs")
    .select("id, title")
    .eq("company_id", ctx.companyId)
    .is("deleted_at", null);
  if (scope.scoped) q = q.in("id", scope.jobIds);

  const { data } = await q.order("created_at", { ascending: false }).limit(200);
  return ((data ?? []) as { id: string; title: string | null }[]).map((j) => ({
    id: j.id,
    title: (j.title ?? "").trim() || "Untitled role",
  }));
}

/** Log a scheduled message that the sender chose to send immediately. */
export async function sendScheduledNow(
  logId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("communication_logs")
    .select("id, status, application_id, event, to_address, subject, body")
    .eq("id", logId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  const row = data as {
    id: string;
    status: string;
    application_id: string | null;
    event: string | null;
    to_address: string | null;
    subject: string | null;
    body: string | null;
  } | null;

  if (!row) return { success: false, error: "That message isn't in your workspace." };
  if (!(await canSeeApplication(ctx, row.application_id ?? ""))) {
    return { success: false, error: "That message isn't in your workspace." };
  }
  if (row.status !== "queued") {
    return { success: false, error: "This message has already been sent." };
  }
  /*
   * The stored body is what gets re-sent, and stored bodies have their
   * interview and booking tokens removed (deliverEmail → redactCandidateLinks).
   * No queued message carries such a link today - those sends are immediate -
   * so this is a guard against a future one, not a live path: re-sending it
   * would deliver a dead link, which is worse than refusing.
   */
  if ((row.body ?? "").includes(REDACTED_LINK)) {
    return {
      success: false,
      error:
        "This message carried a one-time link that isn't kept on file. Send a fresh one from the applicant instead.",
    };
  }

  const { data: companyData } = await service
    .from("companies")
    .select("name, candidate_reply_email")
    .eq("id", ctx.companyId)
    .maybeSingle();
  const company = companyData as {
    name: string | null;
    candidate_reply_email: string | null;
  } | null;

  const to = (row.to_address ?? "").trim().toLowerCase();
  if (!to) return { success: false, error: "This message has no recipient." };

  /*
   * The queued row is retired as 'cancelled' first, then the send writes its
   * own row. Cancelling before sending is deliberate: it is exactly what the
   * scheduled job checks for, so even if the send below fails, the two-day job
   * can no longer fire and deliver a duplicate.
   */
  await service
    .from("communication_logs")
    .update({ status: "cancelled", error: "Superseded — sent immediately." })
    .eq("id", row.id)
    .eq("company_id", ctx.companyId);

  const outcome = await deliverEmail(service, {
    companyId: ctx.companyId,
    applicationId: row.application_id ?? "",
    event: asEvent(row.event),
    to,
    subject: row.subject ?? "",
    html: row.body ?? "",
    companyName: (company?.name ?? "").trim(),
    replyTo: (company?.candidate_reply_email ?? "").trim() || null,
    note: `Sent immediately by ${ctx.memberName} instead of waiting for the scheduled time.`,
  });

  if (!outcome.ok) return { success: false, error: outcome.message };

  revalidatePath("/ai-dashboard/messages");
  return { success: true, data: undefined };
}
