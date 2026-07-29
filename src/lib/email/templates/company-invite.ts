export const companyInviteSubject = "You've been invited to a Remotiv workspace";

export function renderCompanyInviteEmail(data: {
  inviteeName: string;
  companyName: string;
  inviterName: string;
  /** Human-readable role label, e.g. "Recruiter". */
  role: string;
  acceptUrl: string;
}): string {
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

      <h2 style="margin: 0 0 16px; color: #111; font-size: 22px; font-weight: 500;">Hi ${data.inviteeName},</h2>

      <p style="margin: 0 0 16px; color: #555; font-size: 15px; line-height: 1.6;">
        <strong style="color: #111;">${data.inviterName}</strong> has invited you to join the
        <strong style="color: #111;">${data.companyName}</strong> workspace on Remotiv as a
        <strong style="color: #111;">${data.role}</strong>.
      </p>

      <p style="margin: 0 0 8px; color: #555; font-size: 15px; line-height: 1.6;">
        Remotiv is where ${data.companyName} runs its hiring — post roles, screen applicants with AI, and review video interviews in one place. As a ${data.role} you'll be able to:
      </p>
      <ul style="margin: 0 0 16px; padding: 0 0 0 20px; color: #555; font-size: 15px; line-height: 1.7;">
        <li style="margin: 0 0 4px;">See the roles your team is hiring for.</li>
        <li style="margin: 0 0 4px;">Review candidates and their AI scorecards.</li>
        <li style="margin: 0;">Leave feedback and move people through the pipeline.</li>
      </ul>

      <p style="margin: 0 0 24px; color: #555; font-size: 15px; line-height: 1.6;">
        Accept your invitation to set up your account — it only takes a minute.
      </p>

      <!-- CTA -->
      <div style="text-align: center; margin: 24px 0 8px;">
        <a href="${data.acceptUrl}" style="display: inline-block; background: #7E47FF; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 700;">Accept Invitation →</a>
      </div>

      <p style="margin: 24px 0 0; color: #888; font-size: 12px; line-height: 1.6;">
        This invitation expires in 7 days and can only be used once. If the button doesn't work, paste this link into your browser:<br />
        <span style="color: #7E47FF; word-break: break-all;">${data.acceptUrl}</span>
      </p>

      <p style="margin: 16px 0 0; color: #888; font-size: 12px; line-height: 1.6;">
        If you weren't expecting this invitation, you can safely ignore this email — no account is created until you accept.
      </p>

    </div>

    <!-- Footer -->
    <div style="text-align: center; margin-top: 24px; color: #888; font-size: 12px;">
      <p style="margin: 0;">Remotiv - Hire Pakistan's top 1% talent.</p>
      <p style="margin: 8px 0 0;">remotiv.work</p>
    </div>

  </div>
</body>
</html>`;
}
