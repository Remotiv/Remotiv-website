import { escapeHtml } from "@/lib/email/candidate/render";

/**
 * The code a person enters to accept a team invitation (#51). Sent by us,
 * through Resend, never by Supabase: Supabase's own templates are shared with
 * client signup and talent login and must not change.
 */
export function inviteCodeSubject(companyName: string): string {
  return `Your code to join ${companyName} on Remotiv`;
}

export function renderInviteCodeEmail(data: { companyName: string; code: string }): string {
  const company = escapeHtml(data.companyName);
  const code = escapeHtml(data.code);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin: 0; padding: 0; background: #f8f4f1; font-family: 'DM Sans', Arial, sans-serif; color: #111;">
  <div style="max-width: 560px; margin: 0 auto; padding: 32px 24px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="margin: 0; color: #7E47FF; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Remotiv.</h1>
    </div>
    <div style="background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.05);">
      <p style="margin: 0 0 24px; color: #555; font-size: 15px; line-height: 1.6;">
        Enter this code to accept your invitation to join ${company} on Remotiv.
      </p>
      <p style="margin: 0 0 24px; text-align: center; color: #111; font-size: 32px; font-weight: 600; letter-spacing: 8px;">${code}</p>
      <p style="margin: 0; color: #888; font-size: 12px; line-height: 1.6;">
        This code expires in 1 hour. If you were not expecting this, you can ignore this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}
