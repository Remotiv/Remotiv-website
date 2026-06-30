export const claimInviteSubject = "Welcome to Remotiv!";

export function renderClaimInviteEmail(data: {
  candidateName: string;
  loginUrl: string;
  // adminName is accepted for backward compatibility with the existing call
  // site (src/app/api/admin/send-invite/route.ts); the attribution line now
  // hardcodes the talent@remotiv.work support inbox instead of surfacing the
  // triggering admin's email.
  adminName: string;
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

      <h2 style="margin: 0 0 16px; color: #111; font-size: 22px; font-weight: 500;">Hi ${data.candidateName},</h2>

      <p style="margin: 0 0 16px; color: #555; font-size: 15px; line-height: 1.6;">
        I'm Waleed, Founder &amp; CEO of Remotiv.
      </p>

      <p style="margin: 0 0 16px; color: #555; font-size: 15px; line-height: 1.6;">
        We built Remotiv to connect Pakistan's top talent with companies around the world for both full-time and freelance opportunities. Since launching, we've helped companies hire talent across the US, UK, Middle East, and Pakistan.
      </p>

      <p style="margin: 0 0 16px; color: #555; font-size: 15px; line-height: 1.6;">
        I wanted to let you know that <strong style="color: #111;">your profile is already live on Remotiv</strong>, but it hasn't been claimed yet.
      </p>

      <p style="margin: 0 0 8px; color: #555; font-size: 15px; line-height: 1.6;">
        By claiming your profile, you'll be able to:
      </p>
      <ul style="margin: 0 0 16px; padding: 0 0 0 20px; color: #555; font-size: 15px; line-height: 1.7;">
        <li style="margin: 0 0 4px;">Update your experience, skills, and availability.</li>
        <li style="margin: 0 0 4px;">Control how your profile appears to employers.</li>
        <li style="margin: 0 0 4px;">Increase your visibility to companies hiring through Remotiv.</li>
        <li style="margin: 0;">Keep your profile up to date as your career grows.</li>
      </ul>

      <p style="margin: 0 0 24px; color: #555; font-size: 15px; line-height: 1.6;">
        It only takes a minute to claim your profile, and you'll be ready when the right opportunity comes along.
      </p>

      <!-- CTA -->
      <div style="text-align: center; margin: 24px 0 8px;">
        <a href="${data.loginUrl}" style="display: inline-block; background: #7E47FF; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-size: 14px; font-weight: 700;">Claim My Profile →</a>
      </div>

      <p style="margin: 24px 0 16px; color: #555; font-size: 15px; line-height: 1.6;">
        Thank you for being part of the Remotiv community.
      </p>

      <p style="margin: 0; color: #555; font-size: 15px; line-height: 1.6;">
        Best,<br />
        Waleed<br />
        Founder &amp; CEO, Remotiv
      </p>

      <p style="margin: 24px 0 0; color: #888; font-size: 12px; line-height: 1.6;">
        This invitation was sent by talent@remotiv.work via Remotiv. If you weren't expecting this email, you can safely ignore it.
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
