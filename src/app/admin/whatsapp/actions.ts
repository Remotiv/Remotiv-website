"use server";

import { isSuperAdminEmail, type UserRole } from "@/app/admin/lib/roles";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { isIdentifierChange } from "@/lib/whatsapp/inbound-display";

/**
 * Inbound WhatsApp that attached to nobody. Read-only, super admins only.
 *
 * ── What this shows ──────────────────────────────────────────
 *
 * Only rows with `application_id IS NULL`: messages the webhook could not
 * match to an application. Two reasons a message attaches to nobody, and
 * neither is transient: the sender's number matches several applications and
 * the matcher refuses to guess, or the number cannot be normalised at all. So
 * "unattached" is a permanent population, not a backlog, and this page is
 * where it lives. A reply that DID attach is read in the applicant drawer, by
 * the company it belongs to, and has no business here.
 *
 * ── Why it is this narrow (#66, 11 Nov 2026) ─────────────────
 *
 * Until #66 this read had no filter: every inbound row reached the browser,
 * attached or not, with the matched applicant's name and job title, and any
 * active `admin` could open it. The "Unattached" tab only filtered in the
 * browser, after the data had already been sent. Now:
 *
 *   - the guard admits super_admin only (allowlist email, or an
 *     admin_users row with role super_admin), and refuses a paused or
 *     archived row even for an allowlisted email; admin and viewer get the
 *     same refusal, before whatsapp_inbound is read;
 *   - the query itself carries `.is("application_id", null)`;
 *   - no applicant name or job title is looked up or returned.
 *
 * Do NOT "tidy" either of the first two away. The page gate does not protect
 * this function: an exported "use server" function is a POST endpoint anyone
 * signed in can call, so the guard here is the real one. And a filter moved to
 * the browser is a filter on data that has already leaked.
 *
 * ── Not built yet ────────────────────────────────────────────
 *
 * Reads are NOT logged. admin_access_logs (migration 046) cannot hold a
 * WhatsApp read, so logging needs its own migration. Separate follow-up.
 */

export type InboundKind = "message" | "identifier-change";

export type InboundRow = {
  id: string;
  /** Meta's profile name. Absent when the sender has no profile name set. */
  profileName: string | null;
  phone: string | null;
  /** Business-scoped user id, the only identifier a username-only sender has. */
  bsuid: string | null;
  body: string | null;
  messageType: string;
  kind: InboundKind;
  /** Our insert time, not Meta's send time. Labelled "Received" in the UI. */
  receivedAt: string;
};

/**
 * Who is asking. super_admin is the email allowlist, or an admin_users row
 * with role super_admin; either way the row's status is read first:
 *
 *   - lookup failed            -> refused. A failed read is not "no row".
 *   - row paused or archived   -> refused, allowlisted or not. The admin
 *                                 layout skips the status check for an
 *                                 allowlisted email, so this is the only place
 *                                 a paused allowlisted account is stopped.
 *   - allowlisted, no row      -> super_admin, as before.
 *   - otherwise                -> the row's role, if any.
 */
async function getAdminRole(): Promise<UserRole | null> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;

  const supabase = createServiceClient();
  const { data: roleRow, error } = await supabase
    .from("admin_users")
    .select("role, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error(`[whatsapp_inbound] admin lookup failed: ${error.code ?? "error"}`);
    return null;
  }

  type AdminRow = { role: UserRole | null; status: string | null };
  const r = roleRow as AdminRow | null;
  if (r?.status && r.status !== "active") return null;
  if (isSuperAdminEmail(user.email)) return "super_admin";
  return r?.role ?? null;
}

async function requireSuperAdmin(): Promise<void> {
  const role = await getAdminRole();
  if (role !== "super_admin") {
    throw new Error("Forbidden");
  }
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
  await requireSuperAdmin();
  const supabase = createServiceClient();

  // Ordered by `received_at`, our insert time. Meta's send time sits in
  // `raw.timestamp`, but it cannot be sorted on: the seed row carries a 2017
  // stamp and would pin itself below every real message for good. Measured
  // skew between the two on real traffic is a few seconds, so arrival order
  // and send order are the same list.
  const { data, error } = await supabase
    .from("whatsapp_inbound")
    .select("id, from_phone, bsuid, profile_name, body, message_type, received_at")
    .is("application_id", null)
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
    received_at: string | null;
  };
  const rows = (data ?? []) as Row[];

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
      };
    }),
  );
}
