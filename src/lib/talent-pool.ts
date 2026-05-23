// Shared role-type palette for /ai-results card badges.
// Originally this file also exported a `Talent` interface + a hand-written
// `TALENT_POOL: Talent[]` fixture used by the AI Matching demo. Both were
// retired when /ai-results was wired to the real /api/ai-matching response
// (Phase 4A). Only the palette + its key type remain, kept here so the import
// path in /ai-results doesn't churn.

export type TalentType = "Eng" | "Design" | "Data" | "PM" | "Ops";

export interface RoleConfig {
  label: string;
  color: string;
  border: string;
  background: string;
}

export const ROLE_CONFIG: Record<TalentType, RoleConfig> = {
  Eng: {
    label: "Engineering",
    color: "#3b82f6",
    border: "rgba(59,130,246,0.3)",
    background: "rgba(59,130,246,0.08)",
  },
  Design: {
    label: "Design",
    color: "#a855f7",
    border: "rgba(168,85,247,0.3)",
    background: "rgba(168,85,247,0.08)",
  },
  Data: {
    label: "Data",
    color: "#f59e0b",
    border: "rgba(245,158,11,0.3)",
    background: "rgba(245,158,11,0.08)",
  },
  PM: {
    label: "Product",
    color: "#10b981",
    border: "rgba(16,185,129,0.3)",
    background: "rgba(16,185,129,0.08)",
  },
  Ops: {
    label: "Operations",
    color: "#ef4444",
    border: "rgba(239,68,68,0.3)",
    background: "rgba(239,68,68,0.08)",
  },
};
