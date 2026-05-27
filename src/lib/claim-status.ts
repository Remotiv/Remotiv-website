export type InviteStatus =
  | "not_invited"
  | "pending"
  | "opened"
  | "claimed"
  | "expired";

export function getInviteStatus(profile: {
  claimed_at: string | null;
  inviteStatus?: string | null;
}): InviteStatus {
  if (profile.claimed_at) return "claimed";
  if (!profile.inviteStatus) return "not_invited";
  return ((profile.inviteStatus as InviteStatus) ?? "not_invited") as InviteStatus;
}

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  not_invited: "Not invited",
  pending: "Invite sent",
  opened: "Invite opened",
  claimed: "Claimed",
  expired: "Invite expired",
};

export const INVITE_STATUS_COLOR: Record<
  InviteStatus,
  { bg: string; text: string; border: string }
> = {
  not_invited: { bg: "#f5f5f5", text: "#999",    border: "#e5e5e5" },
  pending:     { bg: "#fff8e6", text: "#b45309", border: "#fde68a" },
  opened:      { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe" },
  claimed:     { bg: "#e8faf4", text: "#0f6e56", border: "#9FE1CB" },
  expired:     { bg: "#fff1f0", text: "#b91c1c", border: "#fecaca" },
};
