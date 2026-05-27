export const claimVerificationSubject =
  "Verify your email to claim your Remotiv profile";

export function renderClaimVerificationEmail(data: {
  candidateName: string;
  loginUrl: string;
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

      <h2 style="margin: 0 0 8px; color: #111; font-size: 22px; font-weight: 500;">Hi ${data.candidateName},</h2>
      <p style="margin: 0 0 24px; color: #555; font-size: 15px; line-height: 1.6;">
        We received a request to link your email address to a Remotiv talent profile. Click the button below to verify your email and claim your profile.
      </p>

      <!-- CTA -->
      <div style="text-align: center; margin: 24px 0 8px;">
        <a href="${data.loginUrl}" style="display: inline-block; background: #7E47FF; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 500;">Verify &amp; Claim Profile →</a>
      </div>

      <p style="margin: 24px 0 0; color: #888; font-size: 12px; line-height: 1.6;">
        This link expires in 24 hours. If you did not request this, you can safely ignore this email.
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
