export type HireRequestTeamEmailData = {
  fullName: string;
  email: string;
  company: string;
  notes: string | null;
  candidateName: string;
  candidateRate: string;
  candidateId: string;
  engagementType: string;
  budgetRange: string;
  projectDescription: string;
  timeline: string;
  adminUrl: string;
};

function formatEngagement(type: string): string {
  if (type === "per_hour") return "Per hour (project-based)";
  if (type === "per_month") return "Per month (retainer)";
  if (type === "full_time") return "Full time (long-term)";
  return type;
}

function formatTimeline(timeline: string): string {
  if (timeline === "asap") return "ASAP";
  if (timeline === "within_2_weeks") return "Within 2 weeks";
  if (timeline === "within_1_month") return "Within 1 month";
  if (timeline === "flexible") return "Flexible";
  return timeline;
}

export function renderHireRequestTeamEmail(data: HireRequestTeamEmailData): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin: 0; padding: 0; background: #f8f4f1; font-family: 'DM Sans', Arial, sans-serif; color: #111;">
  <div style="max-width: 640px; margin: 0 auto; padding: 32px 24px;">

    <div style="text-align: center; margin-bottom: 24px;">
      <h1 style="margin: 0; color: #7E47FF; font-size: 24px; font-weight: 600; letter-spacing: -0.5px;">Remotiv.</h1>
    </div>

    <div style="background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.05);">

      <div style="background: #49d7a7; color: #fff; display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 12px;">New hire request</div>

      <h2 style="margin: 0 0 8px; color: #111; font-size: 22px; font-weight: 500;">${data.candidateName}</h2>
      <p style="margin: 0 0 24px; color: #555; font-size: 14px;">Requested by <strong>${data.fullName}</strong> · ${data.company}</p>

      <!-- Client info -->
      <p style="margin: 0 0 8px; color: #7E47FF; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase;">Client</p>
      <table style="width: 100%; font-size: 14px; color: #555; margin-bottom: 24px;">
        <tr><td style="padding: 4px 0; width: 120px;">Name</td><td style="padding: 4px 0; color: #111;">${data.fullName}</td></tr>
        <tr><td style="padding: 4px 0;">Email</td><td style="padding: 4px 0;"><a href="mailto:${data.email}" style="color: #7E47FF; text-decoration: none;">${data.email}</a></td></tr>
        <tr><td style="padding: 4px 0;">Company</td><td style="padding: 4px 0; color: #111;">${data.company}</td></tr>
      </table>

      <!-- Request details -->
      <p style="margin: 0 0 8px; color: #7E47FF; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase;">Request</p>
      <table style="width: 100%; font-size: 14px; color: #555; margin-bottom: 16px;">
        <tr><td style="padding: 4px 0; width: 120px;">Candidate</td><td style="padding: 4px 0; color: #111;">${data.candidateName} · ${data.candidateRate}</td></tr>
        <tr><td style="padding: 4px 0;">Engagement</td><td style="padding: 4px 0; color: #111;">${formatEngagement(data.engagementType)}</td></tr>
        <tr><td style="padding: 4px 0;">Budget</td><td style="padding: 4px 0; color: #111;">${data.budgetRange}</td></tr>
        <tr><td style="padding: 4px 0;">Timeline</td><td style="padding: 4px 0; color: #111;">${formatTimeline(data.timeline)}</td></tr>
      </table>

      <!-- Project description -->
      <div style="background: #f8f4f1; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px;">
        <p style="margin: 0 0 6px; color: #7E47FF; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase;">Project description</p>
        <p style="margin: 0; color: #111; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${data.projectDescription}</p>
      </div>

      ${data.notes ? `
      <!-- Notes -->
      <div style="background: #f8f4f1; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px;">
        <p style="margin: 0 0 6px; color: #49d7a7; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase;">Notes from client</p>
        <p style="margin: 0; color: #111; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${data.notes}</p>
      </div>
      ` : ""}

      <!-- CTA -->
      <div style="text-align: center; margin-top: 24px;">
        <a href="${data.adminUrl}" style="display: inline-block; background: #7E47FF; color: #fff; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 500;">View in admin →</a>
      </div>

    </div>

    <div style="text-align: center; margin-top: 16px; color: #888; font-size: 12px;">
      <p style="margin: 0;">Reply directly to ${data.email} to contact the client.</p>
    </div>

  </div>
</body>
</html>`;
}
