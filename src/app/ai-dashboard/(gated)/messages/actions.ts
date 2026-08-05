"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import { MANUAL_DEFAULTS } from "@/lib/email/candidate/templates";
import { MESSAGE_EVENTS, type MessageEvent } from "@/lib/email/candidate/types";
import {
  buildPlaceholders,
  escapeHtml,
  escapePlaceholders,
  renderTemplate,
} from "@/lib/email/candidate/render";
import {
  BODY_MAX,
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

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./types.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

type Service = ReturnType<typeof createServiceClient>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Narrow a stored event string back to the union, defaulting to 'manual'. */
function asEvent(value: string | null): MessageEvent {
  return (MESSAGE_EVENTS as readonly string[]).includes(value ?? "")
    ? (value as MessageEvent)
    : "manual";
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
async function hydrate(service: Service, logs: LogRow[]): Promise<MessageRow[]> {
  const ids = [...new Set(logs.map((l) => l.application_id).filter(Boolean))] as string[];
  const byId = new Map<string, AppLite>();

  // Chunked: a company with a long log would otherwise overflow the URL.
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await service
      .from("job_applications")
      .select("id, first_name, last_name, email, job_id, job_title_snapshot, jobs(title)")
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
export async function fetchMessageAggregates(): Promise<MessageAggregates> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const base = () =>
    service
      .from("communication_logs")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId)
      .neq("status", HIDDEN_STATUS)
      .not(ORPHAN_COLUMN, "is", null);

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

  return {
    all: all.count ?? 0,
    written: written.count ?? 0,
    automatic: automatic.count ?? 0,
    scheduled: scheduled.count ?? 0,
    sent: sent.count ?? 0,
    failed: failed.count ?? 0,
    sentThisWeek: thisWeek.count ?? 0,
  };
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
}): Promise<MessagePage> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const tab: MessageTab = input.tab;
  const search = (input.search ?? "").trim();
  const page = Math.max(0, Math.trunc(input.page ?? 0));

  // The job filter and the free-text search both live on job_applications, not
  // on the log, so they resolve to a set of application ids first. Capped: the
  // filter is a convenience, and an unbounded IN list would overflow the URL.
  let appIds: string[] | null = null;
  if (input.jobId || search) {
    let q = service
      .from("job_applications")
      .select("id, first_name, last_name, email, job_title_snapshot, jobs(title)")
      .eq("company_id_snapshot", ctx.companyId)
      .limit(1000);
    if (input.jobId) q = q.eq("job_id", input.jobId);
    const { data } = await q;
    let rows = (data ?? []) as unknown as AppLite[];
    if (search) {
      const needle = search.toLowerCase();
      rows = rows.filter((r) =>
        [r.first_name, r.last_name, r.email, roleOf(r, "")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    }
    appIds = rows.map((r) => r.id);
  }

  // A search that matches no applicant still has to match subjects, so the
  // id filter is only applied as one side of an OR when a search is present.
  const build = (head: boolean) => {
    let q = service
      .from("communication_logs")
      .select(
        head
          ? "id"
          : "id, application_id, event, status, to_address, subject, body, scheduled_for, sent_at, sent_by_name, created_at",
        head ? { count: "exact", head: true } : undefined,
      )
      .eq("company_id", ctx.companyId)
      .neq("status", HIDDEN_STATUS)
      .not(ORPHAN_COLUMN, "is", null);

    q = applyTab(q, tab);

    if (appIds !== null) {
      if (search) {
        const idList = appIds.slice(0, 300);
        q = idList.length
          ? q.or(`subject.ilike.%${search}%,application_id.in.(${idList.join(",")})`)
          : q.ilike("subject", `%${search}%`);
      } else {
        // Job filter with no search: an empty set really means no results.
        q = q.in("application_id", appIds.slice(0, 500));
      }
    }
    return q;
  };

  const from = page * MESSAGES_PAGE_SIZE;
  const [{ count }, { data }] = await Promise.all([
    build(true),
    build(false)
      .order("created_at", { ascending: false })
      .range(from, from + MESSAGES_PAGE_SIZE - 1),
  ]);

  return {
    rows: await hydrate(service, (data ?? []) as unknown as LogRow[]),
    matching: count ?? 0,
  };
}

/** The message trail for one applicant, for the drawer. Ownership-checked. */
export async function fetchApplicationMessages(
  applicationId: string,
): Promise<MessageRow[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("communication_logs")
    .select(
      "id, application_id, event, status, to_address, subject, body, scheduled_for, sent_at, sent_by_name, created_at",
    )
    .eq("company_id", ctx.companyId)
    .eq("application_id", applicationId)
    .neq("status", HIDDEN_STATUS)
    .order("created_at", { ascending: false })
    .limit(50);

  return hydrate(service, (data ?? []) as unknown as LogRow[]);
}

/** Candidates this company can write to. Every role may email. */
export async function fetchRecipients(): Promise<MessageRecipient[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("job_applications")
    .select("id, first_name, last_name, email, job_title_snapshot, jobs(title), created_at")
    .eq("company_id_snapshot", ctx.companyId)
    .not("email", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

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
    .select("id, status")
    .eq("id", logId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  const row = existing as { id: string; status: string } | null;
  if (!row) return { success: false, error: "That message isn't in your workspace." };

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

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/messages");
  return { success: true, data: undefined };
}

/** Jobs to populate the page's job filter. */
export async function fetchMessageJobs(): Promise<{ id: string; title: string }[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();
  const { data } = await service
    .from("jobs")
    .select("id, title")
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false })
    .limit(200);
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
  if (row.status !== "queued") {
    return { success: false, error: "This message has already been sent." };
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
