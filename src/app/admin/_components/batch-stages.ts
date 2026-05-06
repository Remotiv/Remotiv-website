// Central pipeline-stage vocabulary for client batch candidates.
// Imported by every component that displays or sets a stage.

export const BATCH_STAGES = [
  "-",
  "CV Shortlisted",
  "CV Not Shortlisted",
  "1st Interview Scheduled",
  "1st Interview Feedback Pending",
  "Pass 1st Interview",
  "Rejected After 1st Interview",
  "2nd Interview",
  "2nd Interview Feedback Pending",
  "Pass 2nd Interview",
  "Rejected After 2nd Interview",
  "Pass After Assessment",
  "Rejected After Assessment",
  "Final Interview Scheduled",
  "Final Interview Feedback Pending",
  "Rejected After Final Interview",
  "Offer Sent",
  "Offer Accepted",
  "Hold For Now",
  "Under Consideration",
  "Back Off",
  "Already In Our Data / Rejected",
] as const;

export type BatchStage = (typeof BATCH_STAGES)[number];

export type StageColor = "gray" | "blue" | "green" | "red";

export const STAGE_COLORS: Record<string, StageColor> = {
  "-": "gray",
  "Hold For Now": "gray",
  "Under Consideration": "gray",
  "Back Off": "gray",
  "Already In our Data / Rejected": "gray",
  "CV Shortlisted": "blue",
  "1st Interview Scheduled": "blue",
  "1st Interview Feedback Pending": "blue",
  "2nd Interview": "blue",
  "2nd Interview Feedback Pending": "blue",
  "Final Interview Scheduled": "blue",
  "Final Interview Feedback Pending": "blue",
  "Pass 1st Interview": "green",
  "Pass 2nd Interview": "green",
  "Pass After Assessment": "green",
  "Offer Sent": "green",
  "Offer Accepted": "green",
  "CV Not Shortlisted": "red",
  "Rejected After 1st Interview": "red",
  "Rejected After 2nd Interview": "red",
  "Rejected After Assessment": "red",
  "Rejected After Final Interview": "red",
};

export const STAGE_BADGE_CLASSES: Record<StageColor, string> = {
  gray:  "bg-gray-100 text-gray-600",
  blue:  "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  red:   "bg-red-100 text-red-700",
};

export function stageColor(stage: string): StageColor {
  return STAGE_COLORS[stage] ?? "gray";
}

export function stageBadgeClass(stage: string): string {
  return STAGE_BADGE_CLASSES[stageColor(stage)];
}

// ── Client decision vocabulary ───────────────────────────────

import { CheckCircle2, Phone, XCircle, type LucideIcon } from "lucide-react";

export type ClientDecision = "approve" | "reject" | "request_interview";

/**
 * Lucide icon component reference for each client decision.
 * Consumers should render with `const Icon = CLIENT_DECISION_ICON[d]; <Icon className="size-4" />`.
 */
export const CLIENT_DECISION_ICON: Record<ClientDecision, LucideIcon> = {
  approve: CheckCircle2,
  reject: XCircle,
  request_interview: Phone,
};

export const CLIENT_DECISION_LABEL: Record<ClientDecision, string> = {
  approve: "Approve",
  reject: "Reject",
  request_interview: "Request Interview",
};
