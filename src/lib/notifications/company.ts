import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * In-app notifications for COMPANY members.
 *
 * ── Deliberately not src/lib/notifications.ts ────────────────
 *
 * That module notifies REMOTIV's own staff: it fans out to `admin_users` with
 * role super_admin/admin plus the SUPER_ADMIN_EMAIL shortcut, and writes to
 * the admin `notifications` table. This one notifies a customer's own people,
 * fans out through `job_hiring_team`, and writes to `notifications_company`.
 *
 * Different tables, different audiences, different recipient rules, and a
 * different failure story — an admin notification nobody reads is an internal
 * inconvenience, a company one leaking to the wrong member is a tenancy bug.
 * Merging them would mean one fan-out function with a mode flag, and the first
 * time someone edited it for one product they would be editing the other's
 * security boundary without noticing. They share no code and no types on
 * purpose; the two live in separate directories so an import of the wrong one
 * looks wrong at the call site.
 *
 * ── Failure contract ─────────────────────────────────────────
 *
 * Nothing in here throws. A notification is a courtesy attached to an action
 * that has already happened; failing the stage change because the bell entry
 * could not be written would be strictly worse than a missing bell entry. Same
 * contract as recordUsage and the candidate-email triggers.
 */

export const COMPANY_NOTIFICATION_TYPES = [
  "score_ready",
  "stage_change",
  "applicant_deleted",
  /*
   * An interview window closed with nothing submitted. The only entry here with
   * no human behind it, which is exactly why it needs a notification — every
   * other type is something a member did and already knows about.
   *
   * notifications_company.type is plain `text` with NO check constraint
   * (verified in schema.sql), so this needs no migration; the union is a
   * codebase convention rather than a mirror of the database.
   */
  "interview_expired",
  /*
   * The three booking events. A candidate cancelling tomorrow's interview is
   * the clearest case this bell exists for: nobody on the team did it, the
   * email lands in one person's inbox, and the diary entry disappears without
   * explanation unless something says why.
   *
   * Verified by probe insert that notifications_company.type accepts these —
   * the column is unconstrained, so no migration is needed.
   */
  "interview_booked",
  "interview_rescheduled",
  "interview_cancelled",
  /*
   * The recording bot's two host alerts (recording step 3). Sent to the host
   * alone with notifyCompanyMember, never fanned out. Same unconstrained
   * column as the booking events above, so no migration. final_recording_ready
   * is the import's bell (recording step 4), to the host alone the same way.
   */
  "final_recording_lobby",
  "final_recording_failed",
  "final_recording_ready",
  /*
   * A candidate message that did not arrive (#71A). Written by
   * lib/notifications/send-failure.ts from every path that marks a
   * communication_logs row failed. Same unconstrained column: the production
   * catalog read of 6 Nov 2026 shows no CHECK on type, so no migration.
   */
  "message_failed",
  "job_published",
  "job_closed",
  "job_archived",
  "added_to_job",
  "invite_accepted",
  "member_removed",
  "member_role_changed",
] as const;

export type CompanyNotificationType = (typeof COMPANY_NOTIFICATION_TYPES)[number];

/** Types that are company administration, not hiring work. Owner/admin only. */
const TEAM_ADMIN_TYPES = new Set<CompanyNotificationType>([
  "invite_accepted",
  "member_removed",
  "member_role_changed",
]);

const APPLICANTS_PATH = "/ai-dashboard/applicants";

/**
 * Types that are ABOUT one candidate, and therefore land on that candidate.
 *
 * Every one of these used to pass `href: "/ai-dashboard/applicants"` by hand
 * and land on the list showing everyone — including score_ready, which was the
 * pattern the others copied. The application id was written to the row and read
 * by nothing: the feed maps it out and the bell pushes `href` verbatim, so the
 * column had no effect on where a click went.
 *
 * Deriving it here rather than at each call site is deliberate. Six sites
 * shared one destination and one fallback; six copies of a rule is six chances
 * for the next one to be written differently, which is how they all ended up on
 * the list to begin with.
 */
const APPLICANT_TYPES = new Set<CompanyNotificationType>([
  "score_ready",
  "stage_change",
  "applicant_deleted",
  "interview_booked",
  "interview_rescheduled",
  "interview_cancelled",
  "final_recording_lobby",
  "final_recording_failed",
  "final_recording_ready",
  "message_failed",
]);

/**
 * The bell types the orphan sweep (#72, migration 056) deletes once their
 * applicant is gone: ONLY the types whose title or body can carry the
 * candidate's name. A type that never writes a name gains nothing from a
 * sweep and costs the company an unread notification. The SQL twin is
 * sweepable_notification_types() in migration 056; migration-056.test.ts
 * holds the two equal, and orphan-sweep-scan.test.ts proves every writer of
 * these types passes an application id from a live row.
 *
 * Writers named by file and function rather than line, which drifts:
 *   score_ready            cv-scoring.ts (the score_ready notifyCompany), title "<name> scored"
 *   stage_change           applicants/actions.ts updateApplicationStage, title "<name> moved to"
 *   interview_booked       api/book/[token]/route.ts (booking), title "<name> booked"
 *   interview_rescheduled  api/book/[token]/route.ts (reschedule), title "<name> moved their interview"
 *   interview_cancelled    api/book/[token]/route.ts (cancel), booking-actions.ts,
 *                          final-interview-actions.ts, title "<name> cancelled"
 *   interview_expired      interviews/expiry.ts, title "<name>'s deadline passed"
 *
 * Since #88 neither delete path waits for the sweep: deleteApplication in
 * applicants/actions.ts and in admin/applications/actions.ts delete the
 * applicant's bells before the row (by application_id) and again after it
 * (by the href resolveHref builds). The sweep stays the backstop for a
 * failed second clean and for older orphans.
 *
 * Each name is read from the application row the id names, so a bell written
 * after the applicant is gone carries the fallback label and no name: every
 * name-bearing write has a live application. That is what closes the
 * structural hole of a bell born with a NULL application_id, which is never
 * updated and so never stamped orphaned_at: such a bell of these types has no
 * name in it. What is left unswept is that nameless residue, not personal.
 *
 * Deliberately absent:
 *   applicant_deleted      always written with a NULL application_id
 *                          (applicants/actions.ts deleteApplication): orphaned
 *                          from birth, and the one bell meant to outlive the
 *                          applicant. Since #88 it names nobody: the title is
 *                          "An applicant was deleted" and the body names only
 *                          the team member who deleted them.
 *   final_recording_*      alerts.ts:550-551 and :669-670: the title is the
 *                          email subject and the body a fixed sentence; no name.
 *   message_failed         send-failure.ts names the applicant by six id
 *                          characters, by design.
 *   team and job types     no candidate at all.
 */
export const SWEEPABLE_NOTIFICATION_TYPES = [
  "score_ready",
  "stage_change",
  "interview_booked",
  "interview_rescheduled",
  "interview_cancelled",
  "interview_expired",
] as const satisfies readonly CompanyNotificationType[];

/**
 * Where the row navigates to.
 *
 * Exported for its test — it is the whole rule, and a rule six call sites now
 * depend on deserves an assertion rather than a reading.
 *
 * An explicitly passed `href` always wins, including `null` for "this row is
 * not a link" — interview_expired points at the interview itself, and nothing
 * here should second-guess a caller that named its destination.
 *
 * Otherwise an applicant-scoped type deep-links to its candidate, and falls
 * back to the bare list when there is no application id. The fallback is the
 * list rather than nothing, because the notification still says something true
 * that the reader may want to act on; it just cannot say who any more. This is
 * the case applicant_deleted has always reasoned about — its candidate is gone
 * by construction — and it is now also the booking events, whose
 * `application_id` goes NULL if the candidate is deleted after booking.
 */
export function resolveHref(input: {
  type: CompanyNotificationType;
  applicationId?: string | null;
  href?: string | null;
}): string | null {
  if (input.href !== undefined) return input.href;
  if (!APPLICANT_TYPES.has(input.type)) return null;
  return input.applicationId
    ? `${APPLICANTS_PATH}?applicant=${input.applicationId}`
    : APPLICANTS_PATH;
}

type NotifyInput = {
  companyId: string;
  type: CompanyNotificationType;
  title: string;
  body: string;
  /** Drives the recipient set for job/applicant events. */
  jobId?: string | null;
  applicationId?: string | null;
  /** Where the row navigates to. Must be a route the recipient can open. */
  href?: string | null;
  /**
   * The member who caused it. Excluded from the fan-out — a recruiter who
   * moves a candidate does not need telling that they did.
   */
  actorMemberId?: string | null;
};

type MemberRow = { id: string; role: string };

/**
 * Who hears about this.
 *
 * ── The rule ─────────────────────────────────────────────────
 *
 * Job- and applicant-scoped events go to the people ON THAT JOB'S HIRING TEAM,
 * plus every owner and admin — because those two roles see every job anyway,
 * so a notification about one tells them nothing they could not already read.
 * Never the whole company: a recruiter on two roles must not learn that a
 * candidate on a third was rejected.
 *
 * Team-administration events (invite accepted, member removed, role changed)
 * are not about a job at all and go to owners and admins only. A recruiter
 * does not need to know who joined.
 *
 * An event with no jobId that is not team-administration — nothing produces
 * one today — falls back to owners and admins rather than everyone. The safe
 * direction for an unknown case is fewer recipients, not more.
 */
async function resolveRecipients(
  service: ReturnType<typeof createServiceClient>,
  input: NotifyInput,
  /** Aborts both reads. notifyCompany passes one it never aborts. */
  signal: AbortSignal,
): Promise<string[]> {
  const { data: memberRows } = await service
    .from("company_members")
    .select("id, role")
    .eq("company_id", input.companyId)
    .eq("status", "active")
    .limit(1000)
    .abortSignal(signal);

  const members = (memberRows ?? []) as MemberRow[];
  const siteWide = members.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.id);

  if (TEAM_ADMIN_TYPES.has(input.type)) return siteWide;
  if (!input.jobId) return siteWide;

  const { data: teamRows } = await service
    .from("job_hiring_team")
    .select("member_id")
    .eq("company_id", input.companyId)
    .eq("job_id", input.jobId)
    .limit(500)
    .abortSignal(signal);

  const assigned = ((teamRows ?? []) as { member_id: string | null }[])
    .map((r) => r.member_id)
    .filter((id): id is string => Boolean(id));

  // A member who has since left the company must not get a row — their
  // company_members row is no longer active, so intersecting with `members`
  // drops them.
  const active = new Set(members.map((m) => m.id));
  return [...new Set([...siteWide, ...assigned.filter((id) => active.has(id))])];
}

/**
 * Write one notification row per recipient.
 *
 * One row each, not one row with a recipient list, because read state is per
 * person: `read_at` on a shared row would mean the first person to open the
 * bell marked it read for everyone.
 */
export async function notifyCompany(input: NotifyInput): Promise<void> {
  try {
    if (!input.companyId || !input.title) return;
    const service = createServiceClient();

    // Never aborted: this path has no deadline of its own. The signal exists
    // so resolveRecipients has one shape for both callers.
    const signal = new AbortController().signal;
    const recipients = (await resolveRecipients(service, input, signal)).filter(
      (id) => id !== input.actorMemberId,
    );
    if (recipients.length === 0) return;

    const rows = recipients.map((memberId) => ({
      company_id: input.companyId,
      member_id: memberId,
      type: input.type,
      title: input.title,
      body: input.body,
      job_id: input.jobId ?? null,
      application_id: input.applicationId ?? null,
      href: resolveHref(input),
    }));

    // Chunked: a large company with a wide hiring team would otherwise send
    // one very large insert.
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await service.from("notifications_company").insert(rows.slice(i, i + 200));
      if (error) {
        console.error("[notify-company] insert failed:", error.message);
        return;
      }
    }
  } catch (err) {
    console.error("[notify-company] failed (non-fatal):", err);
  }
}

/**
 * Notify exactly one member, bypassing the fan-out.
 *
 * Used by "you were added to a job" — the recipient is the subject of the
 * event, and telling the rest of the team that someone else was added is the
 * kind of noise this system is trying to avoid.
 */
/**
 * notifyCompany, with one bell per recipient per KEY rather than per call.
 *
 * The caller derives each row's id from its own key and the member
 * (deterministicUuid), so the primary key is the dedup: notifications_company
 * has no other unique index (production catalog, 6 Nov 2026), and a second
 * insert of the same id is refused with 23505, which is read as "already
 * there" exactly as final-interviews/alerts.ts reads it. One insert per
 * recipient rather than one chunked insert, because one duplicate inside a
 * chunk would refuse the whole chunk and silence the members who had no row.
 *
 * Takes the caller's service client, so a queue handler or a webhook passes
 * the one it already holds, and the caller's abort signal, which goes into
 * every read and insert so a caller with a deadline can abandon the requests
 * rather than merely stop waiting. Same recipient rule as notifyCompany:
 * resolveRecipients decides who, the actor is left out. Unlike notifyCompany
 * this one THROWS on an abort or a failed read, so the caller's own handler
 * sees it; a refused duplicate (23505) is "already there" and not an error.
 */
export async function notifyCompanyOnce(
  service: ReturnType<typeof createServiceClient>,
  input: NotifyInput & { idFor: (memberId: string) => string; signal: AbortSignal },
): Promise<void> {
  if (!input.companyId || !input.title) return;
  const recipients = (await resolveRecipients(service, input, input.signal)).filter(
    (id) => id !== input.actorMemberId,
  );
  const href = resolveHref(input);
  for (const memberId of recipients) {
    const { error } = await service
      .from("notifications_company")
      .insert({
        id: input.idFor(memberId),
        company_id: input.companyId,
        member_id: memberId,
        type: input.type,
        title: input.title,
        body: input.body,
        job_id: input.jobId ?? null,
        application_id: input.applicationId ?? null,
        href,
      })
      .abortSignal(input.signal);
    if (error && error.code !== "23505") {
      console.error("[notify-company] once insert failed:", error.message);
    }
  }
}

export async function notifyCompanyMember(input: {
  companyId: string;
  memberId: string;
  type: CompanyNotificationType;
  title: string;
  body: string;
  jobId?: string | null;
  applicationId?: string | null;
  href?: string | null;
  actorMemberId?: string | null;
}): Promise<void> {
  try {
    if (!input.companyId || !input.memberId) return;
    // Adding yourself to a job is not news to you.
    if (input.memberId === input.actorMemberId) return;

    const service = createServiceClient();
    const { error } = await service.from("notifications_company").insert({
      company_id: input.companyId,
      member_id: input.memberId,
      type: input.type,
      title: input.title,
      body: input.body,
      job_id: input.jobId ?? null,
      application_id: null,
      href: resolveHref(input),
    });
    if (error) console.error("[notify-company] member insert failed:", error.message);
  } catch (err) {
    console.error("[notify-company] member notify failed (non-fatal):", err);
  }
}
