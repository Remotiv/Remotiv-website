"use server";

import { headers } from "next/headers";
import { isValidEmail, trimRequired, trimToNull } from "@/app/admin/lib/validators";
import { sendEmail } from "@/lib/email/send";
import { renderHireRequestClientEmail } from "@/lib/email/templates/hire-request-client";
import { renderHireRequestTeamEmail } from "@/lib/email/templates/hire-request-team";
import { notifyAllAdmins } from "@/lib/notifications";
import { createServiceClient } from "@/lib/supabase/server";

type EngagementType = "per_hour" | "per_month" | "full_time";
type Timeline = "asap" | "within_2_weeks" | "within_1_month" | "flexible";

export type HireRequestInput = {
  engagementType: EngagementType;
  budgetRange: string;
  projectDescription: string;
  timeline: Timeline;
  fullName: string;
  email: string;
  company: string;
  notes?: string;
  candidateId: string;
  candidateName: string;
  candidateRate: string;
  companyUrl?: string;
};

type Result = { success: true } | { success: false; error: string };

const GENERIC_ERROR =
  "We couldn't send your request. Please try again or email us at waleed.nazim@remotiv.work.";

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

const FIELD_LIMITS = {
  fullName: 100,
  email: 254,
  company: 100,
  notes: 5000,
  projectDescription: 5000,
  budgetRange: 50,
  candidateName: 200,
  candidateRate: 50,
} as const;

const VALID_ENGAGEMENT: ReadonlyArray<EngagementType> = ["per_hour", "per_month", "full_time"];
const VALID_TIMELINE: ReadonlyArray<Timeline> = [
  "asap",
  "within_2_weeks",
  "within_1_month",
  "flexible",
];

type Bucket = { count: number; resetAt: number };
type HRGlobal = typeof globalThis & {
  __submitHireRequestBuckets?: Map<string, Bucket>;
};
const hg = globalThis as HRGlobal;
if (!hg.__submitHireRequestBuckets) {
  hg.__submitHireRequestBuckets = new Map();
}
const submitBuckets = hg.__submitHireRequestBuckets;

async function getClientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown"
  );
}

async function getUserAgent(): Promise<string> {
  const h = await headers();
  return h.get("user-agent") ?? "unknown";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = submitBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    submitBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

export async function submitHireRequest(data: HireRequestInput): Promise<Result> {
  // Honeypot: bots fill hidden fields; humans don't.
  if (data.companyUrl && data.companyUrl.trim().length > 0) {
    return { success: true };
  }

  const ip = await getClientIp();
  if (!checkRateLimit(ip)) {
    return {
      success: false,
      error: "Too many submissions. Please wait a moment and try again.",
    };
  }

  if ((data.fullName ?? "").length > FIELD_LIMITS.fullName) return { success: false, error: GENERIC_ERROR };
  if ((data.email ?? "").length > FIELD_LIMITS.email) return { success: false, error: GENERIC_ERROR };
  if ((data.company ?? "").length > FIELD_LIMITS.company) return { success: false, error: GENERIC_ERROR };
  if ((data.notes ?? "").length > FIELD_LIMITS.notes) return { success: false, error: GENERIC_ERROR };
  if ((data.projectDescription ?? "").length > FIELD_LIMITS.projectDescription) return { success: false, error: GENERIC_ERROR };
  if ((data.budgetRange ?? "").length > FIELD_LIMITS.budgetRange) return { success: false, error: GENERIC_ERROR };
  if ((data.candidateName ?? "").length > FIELD_LIMITS.candidateName) return { success: false, error: GENERIC_ERROR };
  if ((data.candidateRate ?? "").length > FIELD_LIMITS.candidateRate) return { success: false, error: GENERIC_ERROR };

  const fullName = trimRequired(data.fullName);
  if (!fullName) return { success: false, error: "Full name is required." };

  const email = (data.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) return { success: false, error: "Please enter a valid email address." };

  const company = trimRequired(data.company);
  if (!company) return { success: false, error: "Company name is required." };

  const projectDescription = trimRequired(data.projectDescription);
  if (!projectDescription) return { success: false, error: "Project description is required." };

  const budgetRange = trimRequired(data.budgetRange);
  if (!budgetRange) return { success: false, error: "Budget range is required." };

  const candidateName = trimRequired(data.candidateName);
  if (!candidateName) return { success: false, error: GENERIC_ERROR };

  const candidateRate = trimRequired(data.candidateRate);
  if (!candidateRate) return { success: false, error: GENERIC_ERROR };

  const candidateId = trimRequired(data.candidateId);
  if (!candidateId) return { success: false, error: GENERIC_ERROR };

  if (!VALID_ENGAGEMENT.includes(data.engagementType)) {
    return { success: false, error: GENERIC_ERROR };
  }
  if (!VALID_TIMELINE.includes(data.timeline)) {
    return { success: false, error: GENERIC_ERROR };
  }

  const notes = trimToNull(data.notes ?? "");

  const supabase = createServiceClient();
  const userAgent = await getUserAgent();

  const { error: insertError } = await supabase.from("hire_requests").insert({
    full_name: fullName,
    email,
    company,
    notes,
    engagement_type: data.engagementType,
    budget_range: budgetRange,
    project_description: projectDescription,
    timeline: data.timeline,
    candidate_id: candidateId,
    candidate_name: candidateName,
    candidate_rate: candidateRate,
    ip_address: ip,
    user_agent: userAgent,
  });

  if (insertError) {
    console.error("[submitHireRequest] Supabase insert error:", insertError);
    return { success: false, error: GENERIC_ERROR };
  }

  const teamEmail = process.env.RESEND_TEAM_EMAIL ?? "waleed.nazim@remotiv.work";
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://remotiv-website-m3jo.vercel.app";
  const adminUrl = `${siteUrl}/admin/hire-requests`;

  sendEmail({
    to: email,
    subject: `We received your request to hire ${candidateName}`,
    html: renderHireRequestClientEmail({
      fullName,
      candidateName,
      engagementType: data.engagementType,
      budgetRange,
      timeline: data.timeline,
    }),
  }).catch((err) => {
    console.error("[submitHireRequest] client email failed:", err);
  });

  sendEmail({
    to: teamEmail,
    replyTo: email,
    subject: `New hire request — ${candidateName} from ${company}`,
    html: renderHireRequestTeamEmail({
      fullName,
      email,
      company,
      notes,
      candidateName,
      candidateRate,
      candidateId,
      engagementType: data.engagementType,
      budgetRange,
      projectDescription,
      timeline: data.timeline,
      adminUrl,
    }),
  }).catch((err) => {
    console.error("[submitHireRequest] team email failed:", err);
  });

  notifyAllAdmins({
    event_type: "new_inquiry",
    title: `New hire request — ${candidateName}`,
    message: `${fullName} from ${company} wants to hire ${candidateName} (${data.engagementType.replace("_", " ")}, ${budgetRange})`,
    link: "/admin/hire-requests",
    metadata: { kind: "hire_request", email, candidate_id: candidateId },
  }).catch((err) => {
    console.error("[submitHireRequest] notifyAllAdmins failed:", err);
  });

  return { success: true };
}
