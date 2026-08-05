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

/**
 * The editable lifecycle templates, in the order Settings lists them.
 *
 * `sending` records whether the event fires TODAY. Four of them do not —
 * STAGE_EVENTS maps only `rejected`, and shortlisted/interview/offer/hired are
 * commented out there. They still appear in Settings because the wording
 * matters the day they are switched on, and a company that has already written
 * theirs should not discover the default going out on their behalf.
 */
export type LifecycleTemplate = {
  event: Exclude<MessageEvent, "manual">;
  name: string;
  trigger: string;
  sending: boolean;
};

export const LIFECYCLE_TEMPLATES: ReadonlyArray<LifecycleTemplate> = [
  {
    event: "application_received",
    name: "Application received",
    trigger: "Sent the moment someone applies",
    sending: true,
  },
  {
    event: "screening",
    name: "Screening",
    trigger: "Sent when you move someone to Screening",
    sending: false,
  },
  {
    event: "shortlisted",
    name: "Shortlisted",
    trigger: "Sent when you move someone to Shortlisted",
    sending: false,
  },
  {
    event: "interview",
    name: "Interview",
    trigger: "Sent when you move someone to Interview",
    sending: false,
  },
  {
    event: "offer",
    name: "Offer",
    trigger: "Sent when you move someone to Offer",
    sending: false,
  },
  {
    event: "hired",
    name: "Hired",
    trigger: "Sent when you move someone to Hired",
    sending: false,
  },
  {
    event: "rejected",
    name: "Rejected",
    trigger: "Sent two days after moving to Rejected",
    sending: true,
  },
];

/** The Remotiv default for an event, or null for 'manual'. */
export function defaultTemplate(event: MessageEvent): DefaultTemplate | null {
  if (event === "manual") return null;
  return TEMPLATES[event] ?? null;
}

/**
 * Starting points for the composer's "Start from a template" picker.
 *
 * In CODE for the same reason as the automatic defaults above: a fresh
 * environment is never one missing INSERT away from an empty picker, which is
 * the state that made the feature read as broken.
 *
 * ── PLAIN TEXT, deliberately ─────────────────────────────────
 *
 * Unlike TEMPLATES, these bodies carry no HTML. They are loaded into the
 * composer's textarea for a person to edit, and sendManualMessage escapes what
 * it receives before rebuilding paragraphs from blank lines. A `<p>` here would
 * show as literal markup in the textarea and again in the candidate's inbox.
 *
 * ── Voice ────────────────────────────────────────────────────
 *
 * First person, because a person at the company is writing — the automatic
 * templates speak ABOUT the company ("{{company_name}} has shortlisted you")
 * because Remotiv writes those. These say "we".
 *
 * Signed "— The {{company_name}} team" rather than a name: there is no
 * placeholder for the sender, and a dangling "Thanks," reads unfinished. A
 * recruiter replacing it with their own name is the expected first edit.
 */
export type ManualDefault = {
  /**
   * Stable key, stored verbatim in message_templates.template_key when a
   * company overrides this template.
   *
   * Two disjoint namespaces share the column, separated by prefix:
   *   default:<slug>  a Remotiv-shipped template, enumerable from this array
   *   custom:<uuid>   a company-authored one, generated at creation
   *
   * A collision is therefore impossible by construction rather than by
   * checking — and saveManualTemplate rejects any `default:` key that is not
   * in MANUAL_DEFAULTS, so a client cannot invent one.
   */
  id: string;
  label: string;
  subject: string;
  body: string;
};

export const MANUAL_DEFAULTS: ReadonlyArray<ManualDefault> = [
  {
    id: "default:invite-interview",
    label: "Invite to interview",
    subject: "Interview invitation — {{job_title}}",
    body: `Hi {{candidate_first_name}},

Thanks for applying for {{job_title}}. We've been through your application and we'd like to meet you.

Could you share a few times that work for you over the next week or so? We'll confirm as soon as we find a slot that suits us both, and we'll tell you who you'll be speaking to and what to expect.

Looking forward to it.

— The {{company_name}} team`,
  },

  {
    id: "default:request-availability",
    label: "Request availability",
    subject: "Your availability for a short call",
    body: `Hi {{candidate_first_name}},

We'd like to set up a short intro call about the {{job_title}} role — around 20 minutes, and nothing to prepare.

Could you let us know two or three times that suit you this week or next? If none of those windows work, tell us what does and we'll fit around it.

— The {{company_name}} team`,
  },

  {
    id: "default:ask-portfolio",
    label: "Ask for a portfolio or work sample",
    subject: "Could you share some of your work?",
    body: `Hi {{candidate_first_name}},

Thanks for your application for {{job_title}}. Before we take it further, could you send over a portfolio or two or three examples of work you're proud of?

Links are fine — we're looking for a sense of how you work rather than a polished showcase. If your best work is under NDA, a short description of what you did and what you decided is just as useful.

— The {{company_name}} team`,
  },

  {
    id: "default:salary-expectations",
    label: "Ask for salary expectations",
    subject: "A quick question about {{job_title}}",
    body: `Hi {{candidate_first_name}},

Thanks for applying for {{job_title}}. So that neither of us spends time on a conversation that can't work, could you tell us the salary range you're looking for?

A range is fine, and it isn't a negotiation — we're checking we're in the same territory before we both invest more.

— The {{company_name}} team`,
  },

  {
    id: "default:following-up",
    label: "Following up",
    subject: "Following up on {{job_title}}",
    body: `Hi {{candidate_first_name}},

Just following up on our last message about {{job_title}} — we know these things get buried.

If you're still interested, a one-line reply is enough. If you've taken something else or changed your mind, that's completely fine — just let us know so we can close things off properly.

— The {{company_name}} team`,
  },

  {
    id: "default:keep-on-file",
    label: "Keeping you on file",
    subject: "Not this role — but we'd like to stay in touch",
    body: `Hi {{candidate_first_name}},

We've decided not to move forward with your application for {{job_title}}. We wanted to tell you directly rather than leave you waiting on it.

That said, we liked what we saw, and we'd genuinely like to keep your application on file. If something opens up that's a closer match for your experience, we'll get in touch.

Thanks for the time you put into applying.

— The {{company_name}} team`,
  },
];
