import { createHash } from "node:crypto";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import {
  COMPANY_ROLE_LABELS,
  type CompanyRole,
} from "@/app/ai-dashboard/lib/company-roles";
import { AcceptClient } from "./accept-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation — Remotiv" };

type InviteRow = {
  id: string;
  company_id: string;
  email: string;
  name: string | null;
  role: CompanyRole;
  status: string;
  expires_at: string;
};

type Invalid = "not_found" | "revoked" | "accepted" | "expired";

const INVALID_COPY: Record<Invalid, { title: string; body: string }> = {
  not_found: {
    title: "Invitation not found",
    body: "This link isn't valid. Ask whoever invited you to send a new invitation.",
  },
  revoked: {
    title: "Invitation revoked",
    body: "This invitation was cancelled. Ask your workspace admin to invite you again.",
  },
  accepted: {
    title: "Already accepted",
    body: "This invitation has already been used. Sign in with your Remotiv account to reach the workspace.",
  },
  expired: {
    title: "Invitation expired",
    body: "Invitations are valid for 7 days. Ask your workspace admin to send a fresh one.",
  },
};

/**
 * Best-effort check for whether this email already has a Remotiv login, used
 * only to choose the form's copy. Deliberately queries OUR tables rather than
 * auth.admin.listUsers, which paginates the whole project and truncates.
 * A wrong guess is harmless: acceptInvite handles both paths authoritatively.
 */
async function hasExistingAccount(
  service: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<boolean> {
  const probes = [
    service.from("company_members").select("id").eq("email", email).not("user_id", "is", null).limit(1),
    service.from("clients").select("id").eq("email", email).not("user_id", "is", null).limit(1),
    service.from("team_members").select("id").eq("email", email).not("auth_user_id", "is", null).limit(1),
    service.from("talent_profiles").select("id").eq("email", email).not("user_id", "is", null).limit(1),
  ];

  try {
    const results = await Promise.all(probes);
    return results.some((r) => (r.data?.length ?? 0) > 0);
  } catch {
    return false;
  }
}

function InvalidState({ kind }: { kind: Invalid }) {
  const copy = INVALID_COPY[kind];
  return (
    <div className="ai-shell flex min-h-screen items-center justify-center bg-[var(--ai-page)] px-6 py-16 font-sans">
      <div className="w-full max-w-md rounded-2xl border border-[var(--ai-line)] bg-white p-8 text-center shadow-sm">
        <span className="font-heading text-xl font-bold text-remotiv-purple">
          Remotiv.
        </span>
        <h1 className="mt-6 font-heading text-xl font-bold text-[var(--ai-t1)]">
          {copy.title}
        </h1>
        <p className="mt-2 text-sm text-[var(--ai-t2)]">{copy.body}</p>
        <Link
          href="/ai-dashboard/login"
          className="mt-7 inline-block w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Go to sign in
        </Link>
      </div>
    </div>
  );
}

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Only the hash is stored — hash the incoming raw token before lookup.
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const service = createServiceClient();

  const { data: inviteRow } = await service
    .from("company_invites")
    .select("id, company_id, email, name, role, status, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  const invite = inviteRow as InviteRow | null;
  if (!invite) return <InvalidState kind="not_found" />;
  if (invite.status === "revoked") return <InvalidState kind="revoked" />;
  if (invite.status === "accepted") return <InvalidState kind="accepted" />;
  if (invite.status !== "pending" || new Date(invite.expires_at) < new Date()) {
    return <InvalidState kind="expired" />;
  }

  const { data: companyRow } = await service
    .from("companies")
    .select("name")
    .eq("id", invite.company_id)
    .maybeSingle();

  const companyName = (companyRow as { name: string } | null)?.name ?? "your new workspace";
  const existingAccount = await hasExistingAccount(service, invite.email.toLowerCase());

  return (
    <AcceptClient
      token={token}
      email={invite.email}
      inviteeName={invite.name?.trim() || ""}
      companyName={companyName}
      roleLabel={COMPANY_ROLE_LABELS[invite.role]}
      existingAccount={existingAccount}
    />
  );
}
