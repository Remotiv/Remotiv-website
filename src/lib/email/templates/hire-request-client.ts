export type HireRequestClientEmailData = {
  fullName: string;
  candidateName: string;
  engagementType: string;
  budgetRange: string;
  timeline: string;
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

export function renderHireRequestClientEmail(data: HireRequestClientEmailData): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin: 0; padding: 0; background: #f8f4f1; font-family: 'DM Sans', Arial, sans-serif; color: #111;">
  <div style="max-width: 560px; margin: 0 auto; padding: 32px 24px;">

    <!-- Logo -->
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="margin: 0; color: #7E47FF; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Remotiv.</h1>
    </div>

    <!-- Card -->
    <div style="background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.05);">

      <h2 style="margin: 0 0 8px; color: #111; font-size: 22px; font-weight: 500;">We received your request</h2>
      <p style="margin: 0 0 24px; color: #555; font-size: 15px; line-height: 1.6;">
        Hi ${data.fullName}, thanks for your interest in hiring <strong>${data.candidateName}</strong>. Our team will reach out within 24 hours to discuss your needs and arrange next steps.
      </p>

      <!-- Summary -->
      <div style="background: #f8f4f1; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <p style="margin: 0 0 12px; color: #7E47FF; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase;">What you submitted</p>
        <table style="width: 100%; font-size: 14px; color: #555;">
          <tr><td style="padding: 4px 0;">Candidate</td><td style="padding: 4px 0; text-align: right; color: #111; font-weight: 500;">${data.candidateName}</td></tr>
          <tr><td style="padding: 4px 0;">Engagement</td><td style="padding: 4px 0; text-align: right; color: #111;">${formatEngagement(data.engagementType)}</td></tr>
          <tr><td style="padding: 4px 0;">Budget</td><td style="padding: 4px 0; text-align: right; color: #111;">${data.budgetRange}</td></tr>
          <tr><td style="padding: 4px 0;">Timeline</td><td style="padding: 4px 0; text-align: right; color: #111;">${formatTimeline(data.timeline)}</td></tr>
        </table>
      </div>

      <!-- What happens next -->
      <div style="margin-bottom: 24px;">
        <p style="margin: 0 0 12px; color: #49d7a7; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase;">What happens next</p>
        <ol style="margin: 0; padding-left: 20px; color: #555; font-size: 14px; line-height: 1.8;">
          <li>Our team reviews your request</li>
          <li>We confirm availability and fit with the talent</li>
          <li>We schedule an intro call within 24 hours</li>
        </ol>
      </div>

      <p style="margin: 0 0 0; color: #888; font-size: 13px; line-height: 1.6;">
        Questions? Just email talent@remotiv.work and our team will get back to you.
      </p>

    </div>

    <!-- Footer -->
    <div style="text-align: center; margin-top: 24px; color: #888; font-size: 12px;">
      <p style="margin: 0;">Remotiv — Hire Pakistan's top 1% talent.</p>
      <p style="margin: 8px 0 0;">remotiv.work</p>
    </div>

  </div>
</body>
</html>`;
}
