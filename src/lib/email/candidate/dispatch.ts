import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import {
  buildCandidateHtml,
  deliverEmail,
  writeCommunicationLog,
} from "./deliver";
import { defaultTemplate } from "./templates";
import {
  buildPlaceholders,
  escapePlaceholders,
  renderTemplate,
} from "./render";
import type { MessageEvent, SendMessagePayload } from "./types";

/**
 * The send_message handler.
 *
 * Everything a candidate ever receives goes through here, so this file owns
 * idempotency, opt-outs, the daily cap and the audit row. It is called ONLY by
 * the background worker — never inline from a request, because a Resend outage
 * must not fail an application or a stage change.
 */

type ApplicationRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  company_id_snapshot: string | null;
  pipeline_stage: string | null;
};

/** Terminal-ish log statuses: a row in one of these means "already handled". */
const ALREADY_HANDLED = ["queued", "sent", "skipped", "cancelled"];

export async function handleSendMessage(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = job.payload as unknown as SendMessagePayload;
  const applicationId = payload?.applicationId;
  const event = payload?.event as MessageEvent | undefined;

  if (typeof applicationId !== "string" || !applicationId || !event) {
    throw new Error(`send_message: payload malformed (job ${job.id})`);
  }

  const service = createServiceClient();

  // ── 1. Idempotency ────────────────────────────────────────
  //
  // The FIRST thing, before any work. A log row for this (application, event)
  // means a previous attempt already got far enough to claim it, so this
  // attempt returns without sending. That covers the common case exactly: the
  // queue guarantees one worker per job row, so a retry of the same job always
  // finds the row its own earlier attempt wrote.
  //
  // 'failed' is deliberately NOT in the set — a genuine send failure SHOULD be
  // retried, and its row is updated in place rather than duplicated.
  const { data: existing } = await service
    .from("communication_logs")
    .select("id, status")
    .eq("application_id", applicationId)
    .eq("event", event)
    .in("status", ALREADY_HANDLED)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; status: string };
    // A cancelled rejection is the whole point of the 2-day window: the
    // candidate was moved off Rejected, so this job must expire quietly.
    console.log(
      `[send_message] skipping ${event} for ${applicationId} — already ${row.status}`,
    );
    return;
  }

  // ── 2. Load the application, job and company ──────────────
  const { data: appData } = await service
    .from("job_applications")
    .select(
      "id, first_name, last_name, email, job_id, job_title_snapshot, company_id_snapshot, pipeline_stage",
    )
    .eq("id", applicationId)
    .maybeSingle();

  const app = appData as ApplicationRow | null;
  if (!app) throw new Error(`send_message: application ${applicationId} not found`);

  const companyId = app.company_id_snapshot;
  if (!companyId) {
    // Remotiv-owned application. Candidate messaging is a company-product
    // feature; there is no company whose name could carry the content.
    console.log(`[send_message] skipping ${event} for ${applicationId} — no company`);
    return;
  }

  const [{ data: companyData }, { data: jobData }] = await Promise.all([
    service
      .from("companies")
      .select("id, name, candidate_reply_email")
      .eq("id", companyId)
      .maybeSingle(),
    app.job_id
      ? service.from("jobs").select("title").eq("id", app.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const company = companyData as {
    name: string | null;
    candidate_reply_email: string | null;
  } | null;
  if (!company) throw new Error(`send_message: company ${companyId} not found`);

  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) {
    await writeCommunicationLog(service, {
      companyId,
      applicationId,
      event,
      to: "",
      subject: "",
      body: "",
      status: "skipped",
      error: "Application has no email address.",
    });
    return;
  }

  // ── 3. Opt-out ────────────────────────────────────────────
  //
  // Scoped per company: opting out of one company's updates must not silence
  // another's, because they are unrelated hiring processes the candidate chose
  // to enter separately.
  const { data: optOut } = await service
    .from("communication_opt_outs")
    .select("id, reason")
    .eq("company_id", companyId)
    .eq("email", to)
    .maybeSingle();

  if (optOut) {
    const reason = (optOut as { reason: string | null }).reason;
    await writeCommunicationLog(service, {
      companyId,
      applicationId,
      event,
      to,
      subject: "",
      body: "",
      status: "skipped",
      error: `Recipient opted out${reason ? `: ${reason}` : ""}.`,
    });
    return;
  }

  // ── 4. Resolve the template ───────────────────────────────
  const companyName = (company.name ?? "").trim();
  const jobTitle =
    ((jobData as { title: string | null } | null)?.title ?? "").trim() ||
    (app.job_title_snapshot ?? "").trim();

  const resolved = await resolveTemplate(service, companyId, event, payload);
  if (!resolved) {
    await writeCommunicationLog(service, {
      companyId,
      applicationId,
      event,
      to,
      subject: "",
      body: "",
      status: "skipped",
      error: `No template for event '${event}'.`,
    });
    return;
  }

  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle,
    companyName,
  });
  // Subject is plain text; body is HTML, so its values are escaped.
  const subject = renderTemplate(resolved.subject, values);
  const inner = renderTemplate(resolved.body, escapePlaceholders(values));

  const html = buildCandidateHtml(inner, companyName, companyId, to);

  // ── 5. Send ───────────────────────────────────────────────
  //
  // The cap check, the pre-send log row and the Resend call all live in
  // deliverEmail, shared with the composer. What stays here is the queue's own
  // contract: a provider failure must RETHROW so the job retries with backoff,
  // and the 'failed' row it leaves behind is excluded from the idempotency set
  // so that retry legitimately tries again.
  const outcome = await deliverEmail(service, {
    companyId,
    applicationId,
    event,
    to,
    subject,
    html,
    companyName,
    replyTo: (company.candidate_reply_email ?? "").trim() || null,
  });

  if (!outcome.ok && outcome.kind === "provider") {
    throw new Error(`send_message: Resend rejected the message: ${outcome.message}`);
  }
  if (!outcome.ok && outcome.kind === "not_configured") {
    throw new Error("send_message: RESEND_API_KEY not configured");
  }
  // A cap skip is a decision, not a failure: the row is 'skipped' and the job
  // completes. Retrying tomorrow would deliver "we got your application" a day
  // late, which is worse than not sending it at all.
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * The company's own template for this event, else Remotiv's default.
 *
 * Company templates are matched on company_id so one tenant's wording can never
 * be served to another's candidate.
 */
async function resolveTemplate(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  event: MessageEvent,
  payload: SendMessagePayload,
): Promise<{ subject: string; body: string } | null> {
  if (payload.subjectOverride || payload.bodyOverride) {
    return {
      subject: payload.subjectOverride ?? "",
      body: payload.bodyOverride ?? "",
    };
  }

  const { data } = await service
    .from("message_templates")
    .select("subject, body")
    .eq("company_id", companyId)
    .eq("event", event)
    .eq("channel", "email")
    .maybeSingle();

  const own = data as { subject: string | null; body: string | null } | null;
  if (own?.subject && own?.body) {
    return { subject: own.subject, body: own.body };
  }
  return defaultTemplate(event);
}
