import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { sendEmail } from "@/lib/email/send";
import {
  claimInviteSubject,
  renderClaimInviteEmail,
} from "@/lib/email/templates/claim-invite";

export const runtime = "nodejs";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

const ALLOWED_SOURCE_TABLES: ReadonlyArray<SourceTable> = [
  "talent_profiles",
  "hire_remote_profiles",
];

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

type SkippedReason =
  | "not_found"
  | "missing_email"
  | "already_claimed"
  | "insert_failed"
  | "internal_error";

export async function POST(request: Request) {
  const rl = rateLimit(request, {
    bucketKey: "send-invite",
    max: 20,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let adminCtx;
  try {
    adminCtx = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { profileIds, sourceTable } =
    (body ?? {}) as { profileIds?: unknown; sourceTable?: unknown };

  if (
    !Array.isArray(profileIds) ||
    profileIds.length === 0 ||
    !profileIds.every((id) => typeof id === "string" && id.length > 0) ||
    typeof sourceTable !== "string" ||
    !ALLOWED_SOURCE_TABLES.includes(sourceTable as SourceTable)
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const source = sourceTable as SourceTable;
  const supabase = createServiceClient();

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://remotiv.work";

  const sent: string[] = [];
  const failed: Array<{ profileId: string; reason: string }> = [];
  const skipped: Array<{ profileId: string; reason: SkippedReason }> = [];
  // Sends for profiles whose token insert succeeded; settled after the loop.
  const pendingSends: Array<{
    profileId: string;
    promise: Promise<{ ok: boolean; error?: string }>;
  }> = [];

  for (const profileId of profileIds as string[]) {
    try {
      const { data: profile, error: profileErr } = await supabase
        .from(source)
        .select("id, first_name, last_name, email, claimed_at")
        .eq("id", profileId)
        .maybeSingle();

      if (profileErr || !profile) {
        skipped.push({ profileId, reason: "not_found" });
        continue;
      }

      const row = profile as {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        claimed_at: string | null;
      };

      if (!row.email) {
        skipped.push({ profileId, reason: "missing_email" });
        continue;
      }

      if (row.claimed_at) {
        skipped.push({ profileId, reason: "already_claimed" });
        continue;
      }

      // Expire any active token for this candidate + source so only the newest
      // is honoured. Status enum: 'pending' | 'opened' | 'claimed' | 'expired'.
      await supabase
        .from("talent_claim_tokens")
        .update({ status: "expired" })
        .eq("candidate_id", profileId)
        .eq("source_table", source)
        .in("status", ["pending", "opened"])
        .gt("expires_at", new Date().toISOString());

      // Token: two UUID v4 values concatenated with hyphens stripped — 64 char
      // hex string. High-entropy; bcrypt would add cost without much benefit
      // for a 7-day single-use invite.
      const token =
        (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

      const { error: insertErr } = await supabase
        .from("talent_claim_tokens")
        .insert({
          token_hash: token,
          candidate_id: profileId,
          source_table: source,
          status: "pending",
          expires_at: new Date(Date.now() + TOKEN_EXPIRY_MS).toISOString(),
        });

      if (insertErr) {
        console.error("[send-invite] token insert failed:", insertErr);
        skipped.push({ profileId, reason: "insert_failed" });
        continue;
      }

      const loginUrl = `${baseUrl}/talent/login?token=${token}`;
      const candidateName =
        (row.first_name?.trim() ?? "") || "there";

      // Collected, not fire-and-forget: an un-awaited send is torn down with
      // the container when the handler returns, so the Resend request never
      // dispatches. Awaited together after the loop.
      pendingSends.push({
        profileId,
        promise: sendEmail({
          to: row.email,
          subject: claimInviteSubject,
          html: renderClaimInviteEmail({
            candidateName,
            loginUrl,
            adminName: adminCtx.user.email,
          }),
          replyTo: "talent@remotiv.work",
        }),
      });
    } catch (e) {
      console.error("[send-invite] unexpected error for", profileId, e);
      skipped.push({ profileId, reason: "internal_error" });
    }
  }

  // Await every send BEFORE returning — the response must not resolve while a
  // Resend request is still pending, or the container is frozen mid-flight.
  const results = await Promise.allSettled(pendingSends.map((s) => s.promise));
  results.forEach((result, i) => {
    const { profileId } = pendingSends[i];
    if (result.status === "fulfilled" && result.value.ok) {
      sent.push(profileId);
      return;
    }
    const reason =
      result.status === "rejected"
        ? result.reason instanceof Error
          ? result.reason.message
          : "Unknown error"
        : (result.value.error ?? "Unknown error");
    console.error("[send-invite] email error", profileId, reason);
    failed.push({ profileId, reason });
  });

  return NextResponse.json({
    ok: true,
    sent: sent.length,
    failed: failed.length,
    skipped,
  });
}
