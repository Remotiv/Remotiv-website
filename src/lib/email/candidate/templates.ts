import type { MessageEvent } from "./types";

/**
 * Remotiv's default candidate templates.
 *
 * These are the fallback for a company with no template of its own. They ship
 * in CODE rather than as seeded rows so a fresh environment is never one
 * missing INSERT away from silently sending nothing — a company_id-null
 * is_default row in message_templates still takes precedence if one exists, so
 * seeding later changes nothing about this contract.
 *
 * ── Voice ────────────────────────────────────────────────────
 *
 * The COMPANY's name carries the content and the decision; Remotiv is the
 * postal service. Every template names the company explicitly and never claims
 * the mail came from their domain — see the sender identity in send.ts.
 *
 * Deliberately plain: no company logo, no colour, no marketing. A candidate
 * getting a rejection does not want a branded experience, and a template that
 * looks like a newsletter gets filed like one.
 */
export type DefaultTemplate = { subject: string; body: string };

/**
 * Wraps a body in the shared shell. The unsubscribe link is appended by the
 * dispatcher, which is the only place that knows the signed token.
 */
export const EMAIL_SHELL = (inner: string, footer: string): string => `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.6;color:#17131F;max-width:560px;margin:0 auto;padding:24px">
${inner}
<hr style="border:none;border-top:1px solid #e7e3ee;margin:28px 0 16px">
<p style="font-size:12px;line-height:1.5;color:#847E8C;margin:0">${footer}</p>
</div>`.trim();

const TEMPLATES: Record<Exclude<MessageEvent, "manual">, DefaultTemplate> = {
  application_received: {
    subject: "{{company_name}} received your application for {{job_title}}",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p>Thanks for applying for <strong>{{job_title}}</strong> at <strong>{{company_name}}</strong>. Your application is in and their hiring team can see it.</p>
<p>They review applications as they come in. If they'd like to take things further, you'll hear from them here.</p>
<p>Good luck.</p>`,
  },

  screening: {
    subject: "Your application for {{job_title}} is being reviewed",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p><strong>{{company_name}}</strong> has started reviewing your application for <strong>{{job_title}}</strong>.</p>
<p>There's nothing you need to do right now — we'll let you know when there's an update.</p>`,
  },

  shortlisted: {
    subject: "You've been shortlisted for {{job_title}}",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p>Good news — <strong>{{company_name}}</strong> has shortlisted you for <strong>{{job_title}}</strong>.</p>
<p>That means your application stood out and they'd like to look at it more closely. Expect to hear from them about next steps.</p>`,
  },

  interview: {
    subject: "{{company_name}} would like to interview you for {{job_title}}",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p><strong>{{company_name}}</strong> would like to interview you for <strong>{{job_title}}</strong>.</p>
<p>They'll be in touch with the details. If you have questions in the meantime, just reply to this email — it goes straight to them.</p>`,
  },

  offer: {
    subject: "An update on your application for {{job_title}}",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p><strong>{{company_name}}</strong> has moved your application for <strong>{{job_title}}</strong> to the offer stage.</p>
<p>They'll contact you directly with the details. Congratulations.</p>`,
  },

  hired: {
    subject: "Welcome aboard — {{job_title}} at {{company_name}}",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p>Congratulations. <strong>{{company_name}}</strong> has confirmed you for <strong>{{job_title}}</strong>.</p>
<p>They'll take it from here with everything you need to get started. All the best.</p>`,
  },

  /**
   * The one template that has to be genuinely kind, because it is the one most
   * people will receive. No false encouragement ("we'll keep you on file" when
   * nobody will), no explanation we can't stand behind, and no invitation to
   * ask why — the company has not told us, and pretending otherwise wastes the
   * candidate's time.
   */
  rejected: {
    subject: "An update on your application for {{job_title}}",
    body: `
<p>Hi {{candidate_first_name}},</p>
<p>Thanks for taking the time to apply for <strong>{{job_title}}</strong> at <strong>{{company_name}}</strong>.</p>
<p>They've decided not to move forward with your application this time. It's a genuinely competitive process and this isn't a reflection of your ability.</p>
<p>Other roles are open on Remotiv, and applying to one takes a couple of minutes.</p>`,
  },
};

/** The Remotiv default for an event, or null for 'manual'. */
export function defaultTemplate(event: MessageEvent): DefaultTemplate | null {
  if (event === "manual") return null;
  return TEMPLATES[event] ?? null;
}
