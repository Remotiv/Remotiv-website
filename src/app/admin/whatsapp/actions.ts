"use server";

import { isSuperAdminEmail, type UserRole } from "@/app/admin/lib/roles";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { isIdentifierChange } from "@/lib/whatsapp/inbound-display";

/**
 * Inbound WhatsApp, read-only.
 *
 * ── Why this is an admin surface and not a dashboard one ─────
 *
 * Every company-scoped page filters on `company_id`, and `company_id` is null
 * on every row this table has ever held — as is `application_id`. A tenant
 * filter written today would not narrow the list, it would empty it. The
 * dashboard's own /messages page already encodes that: it reads
 * `.not("application_id", "is", null)`, so the rows below are exactly the ones
 * it is built to hide.
 *
 * Two reasons an inbound message attaches to nobody, and neither is transient:
 * the sender's number matches several applications and the matcher refuses to
 * guess, or the number is not Pakistani and `toWhatsAppDigits` cannot normalise
 * it at all. So "unattached" is a permanent population, not a backlog, and this
 * page is where it lives.
 */

export type InboundKind = "message" | "identifier-change";

export type InboundRow = {
  id: string;
  /** Meta's profile name. Absent when the sender has no profile name set. */
  profileName: string | null;
  phone: string | null;
  /** Business-scoped user id — the only identifier a username-only sender has. */
  bsuid: string | null;
  body: string | null;
  messageType: string;
  kind: InboundKind;
  /** Our insert time, not Meta's send time. Labelled "Received" in the UI. */
  receivedAt: string;
  applicationId: string | null;
  /** The applicant this attached to, when it attached to one. */
  applicant: { name: string; jobTitle: string | null } | null;
};

async function getAdminRole(): Promise<UserRole | null> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;
  if (isSuperAdminEmail(user.email)) return "super_admin";

  const supabase = createServiceClient();
  const { data: roleRow } = await supabase
    .from("admin_users")
    .select("role, status")
    .eq("user_id", user.id)
    .maybeSingle();

  type AdminRow = { role: UserRole | null; status: string | null };
  const r = roleRow as AdminRow | null;
  if (!r?.role) return null;
  if (r.status && r.status !== "active") return null;
  return r.role;
}

async function requireAdmin(): Promise<UserRole> {
  const role = await getAdminRole();
  if (!role || (role !== "super_admin" && role !== "admin")) {
    throw new Error("Forbidden");
  }
  return role;
}

/**
 * A system message announces that someone's WhatsApp identifier changed. It is
 * not something a person typed, so the UI must not dress it as one.
 *
 * The vocabulary lives in lib/whatsapp/inbound-display so this page and the
 * applicant drawer cannot disagree about which rows are messages.
 */
function kindOf(messageType: string): InboundKind {
  return isIdentifierChange(messageType) ? "identifier-change" : "message";
}

export async function fetchInboundMessages(): Promise<Read<InboundRow[]>> {
  await requireAdmin();
  const supabase = createServiceClient();

  // Ordered by `received_at` — our insert time. Meta's send time sits in
  // `raw.timestamp`, but it cannot be sorted on: the seed row carries a 2017
  // stamp and would pin itself below every real message for good. Measured
  // skew between the two on real traffic is a few seconds, so arrival order
  // and send order are the same list.
  const { data, error } = await supabase
    .from("whatsapp_inbound")
    .select("id, from_phone, bsuid, profile_name, body, message_type, application_id, received_at")
    .order("received_at", { ascending: false });

  if (error) {
    console.error("[whatsapp_inbound] read failed:", error);
    return unavailable();
  }

  type Row = {
    id: string;
    from_phone: string | null;
    bsuid: string | null;
    profile_name: string | null;
    body: string | null;
    message_type: string | null;
    application_id: string | null;
    received_at: string | null;
  };
  const rows = (data ?? []) as Row[];

  const applicantById = await fetchApplicants(rows.map((r) => r.application_id));

  return answered(
    rows.map((r) => {
      const messageType = r.message_type ?? "unknown";
      return {
        id: r.id,
        profileName: r.profile_name || null,
        phone: r.from_phone || null,
        bsuid: r.bsuid || null,
        body: r.body || null,
        messageType,
        kind: kindOf(messageType),
        receivedAt: r.received_at ?? "",
        applicationId: r.application_id,
        applicant: (r.application_id && applicantById.get(r.application_id)) || null,
      };
    }),
  );
}

/**
 * Names for the rows that did attach. A failure here is not worth failing the
 * whole read over: an unnamed but visible message is a far better outcome than
 * no inbox, and the identifiers on the row still say who sent it.
 */
async function fetchApplicants(
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, { name: string; jobTitle: string | null }>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const found = new Map<string, { name: string; jobTitle: string | null }>();
  if (unique.length === 0) return found;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("job_applications")
    .select("id, first_name, last_name, job_title_snapshot")
    .in("id", unique);

  if (error) {
    console.error("[whatsapp_inbound] applicant hydration failed:", error);
    return found;
  }

  type AppRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    job_title_snapshot: string | null;
  };
  for (const row of (data ?? []) as AppRow[]) {
    const name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
    found.set(row.id, { name, jobTitle: row.job_title_snapshot || null });
  }
  return found;
}
