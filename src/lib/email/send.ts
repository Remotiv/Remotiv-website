import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL ?? "noreply@remotiv.work";

let resendClient: Resend | null = null;

function getResend(): Resend | null {
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not set — emails will be skipped");
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

export type EmailPayload = {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
};

export async function sendEmail(payload: EmailPayload): Promise<{ ok: boolean; error?: string }> {
  const client = getResend();
  if (!client) {
    return { ok: false, error: "Resend not configured" };
  }
  try {
    const { error } = await client.emails.send({
      from: `Remotiv <${fromEmail}>`,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      replyTo: payload.replyTo,
    });
    if (error) {
      console.error("[email] Resend error:", error);
      return { ok: false, error: error.message ?? "Unknown Resend error" };
    }
    return { ok: true };
  } catch (e) {
    console.error("[email] sendEmail threw:", e);
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
