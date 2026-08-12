import "server-only";
import { toWhatsAppDigits } from "@/lib/normalize";

/**
 * WhatsApp Cloud API — the send side.
 *
 * ── Templates are not a formality ────────────────────────────
 *
 * Meta only allows free-form text inside a 24-hour window that the CANDIDATE
 * opens by messaging first. Every message this product sends is
 * business-initiated — an interview invitation nobody asked for — so that
 * window never applies and a pre-approved template is the only legal shape.
 *
 * Both templates below are Utility category. Utility matters: Marketing
 * templates are rate-limited harder, cost more, and are the ones Meta blocks
 * when a business's quality rating drops. An interview invitation genuinely IS
 * utility — it is transactional follow-up to something the candidate started
 * by applying — so the category is accurate rather than convenient.
 *
 * ── Neither template is approved yet ─────────────────────────
 *
 * Sending against a name Meta has not approved returns HTTP 400 with
 * `error.code` 132001 and a message naming the template. That is a PERMANENT
 * failure — retrying cannot approve a template — so it is classified as
 * terminal and the job is not retried into the dead letter three times over.
 * See classifyMetaError.
 */

const GRAPH_VERSION = "v21.0";

/** Template names as they must be registered in Meta's Template Manager. */
export const WHATSAPP_TEMPLATES = {
  interview_invitation: "interview_invitation",
  interview_reminder: "interview_reminder",
} as const;

export type WhatsAppTemplateName =
  (typeof WHATSAPP_TEMPLATES)[keyof typeof WHATSAPP_TEMPLATES];

/**
 * The five body variables both templates take, in positional order.
 *
 * Positional ({{1}}…{{5}}) rather than named: named parameters are a newer
 * Cloud API feature and the two must not be mixed, so the simpler one that
 * every account supports is the safer choice for a first integration.
 */
export type InterviewTemplateVars = {
  /** {{1}} candidate first name */
  candidateName: string;
  /** {{2}} company name */
  companyName: string;
  /** {{3}} job title */
  jobTitle: string;
  /** {{4}} approximate minutes to complete */
  minutes: string;
  /** {{5}} human-readable deadline */
  deadline: string;
};

export type SendResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      /**
       * `terminal` must not be retried — the same request will fail the same
       * way until a human changes something in Meta's dashboard.
       * `transient` is worth a retry through the queue's normal backoff.
       */
      kind: "terminal" | "transient" | "config";
      message: string;
      code: number | null;
    };

/**
 * Meta error codes that will never succeed on retry.
 *
 * 132001 template does not exist / not approved in this language
 * 132000 parameter count mismatch — the template shape and our vars disagree
 * 132005 template text was edited and needs re-approval
 * 132007 template format/policy violation
 * 131047 outside the 24h window and no template used
 * 131026 the number cannot receive WhatsApp messages
 * 100    malformed request — a bug on our side, not a blip
 * 190    the access token is invalid or expired
 */
const TERMINAL_CODES = new Set([132001, 132000, 132005, 132007, 131047, 131026, 100, 190]);

export function classifyMetaError(
  httpStatus: number,
  code: number | null,
): "terminal" | "transient" {
  if (code !== null && TERMINAL_CODES.has(code)) return "terminal";
  // 4xx that isn't a known code: still our problem, not a blip. 429 and 5xx
  // are the genuine "try again later" cases.
  if (httpStatus === 429 || httpStatus >= 500) return "transient";
  if (httpStatus >= 400) return "terminal";
  return "transient";
}

/**
 * The exact JSON body sent to Meta.
 *
 * Exported so it can be asserted in isolation — the payload shape is the part
 * a template rejection actually blames, and being able to print it without
 * making a network call is what makes a 132000 debuggable.
 */
export function buildTemplatePayload(
  toDigits: string,
  template: WhatsAppTemplateName,
  vars: InterviewTemplateVars,
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toDigits,
    type: "template",
    template: {
      name: template,
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: vars.candidateName },
            { type: "text", text: vars.companyName },
            { type: "text", text: vars.jobTitle },
            { type: "text", text: vars.minutes },
            { type: "text", text: vars.deadline },
          ],
        },
      ],
    },
  };
}

/**
 * Normalise a phone number for Meta, or explain why it cannot be.
 *
 * Reuses `toWhatsAppDigits` from lib/normalize.ts unchanged — it is already the
 * one place that knows which shapes are Pakistani and returns null rather than
 * guessing at anything else. A second normaliser here would drift from the one
 * the wa.me links already use.
 *
 * The null case is a SKIP, not a failure: sending an unnormalisable number to
 * Meta would burn a message, return 131026, and tell us nothing we could not
 * determine locally for free.
 */
export function resolveRecipient(
  phone: string | null | undefined,
): { ok: true; digits: string } | { ok: false; reason: string } {
  const raw = (phone ?? "").trim();
  if (!raw) return { ok: false, reason: "No phone number on this application." };
  const digits = toWhatsAppDigits(raw);
  if (!digits) {
    // The number itself is never logged or echoed — it is personal data, and
    // the reason is diagnostic without it.
    return {
      ok: false,
      reason:
        "Phone number isn't a recognised Pakistani mobile format, so it can't be addressed on WhatsApp.",
    };
  }
  return { ok: true, digits };
}

/**
 * POST one template message to the Cloud API.
 *
 * Never logs, returns or embeds the access token. Meta's error text is passed
 * through verbatim because that is the whole point — a template rejection is
 * only actionable if you can read what Meta actually said.
 */
export async function sendTemplateMessage(input: {
  toDigits: string;
  template: WhatsAppTemplateName;
  vars: InterviewTemplateVars;
}): Promise<SendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return {
      ok: false,
      kind: "config",
      message:
        "WhatsApp is not configured — WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is missing.",
      code: null,
    };
  }

  const body = buildTemplatePayload(input.toDigits, input.template, input.vars);

  let res: Response;
  try {
    res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          // The only place the token appears. Nothing below reads it back.
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    return {
      ok: false,
      kind: "transient",
      message: `Couldn't reach Meta: ${err instanceof Error ? err.message : "network error"}`,
      code: null,
    };
  }

  const json = (await res.json().catch(() => null)) as
    | {
        messages?: { id?: unknown }[];
        error?: { message?: unknown; code?: unknown; error_subcode?: unknown };
      }
    | null;

  if (!res.ok || json?.error) {
    const code =
      typeof json?.error?.code === "number" ? json.error.code : null;
    const detail =
      typeof json?.error?.message === "string"
        ? json.error.message
        : `HTTP ${res.status}`;
    return {
      ok: false,
      kind: classifyMetaError(res.status, code),
      // Meta's own words, kept intact. A 132001 reads "Template name does not
      // exist in the translation" and names the template — paraphrasing that
      // would remove the one clue that makes it fixable.
      message: `Meta ${code ?? res.status}: ${detail}`,
      code,
    };
  }

  const messageId = json?.messages?.[0]?.id;
  if (typeof messageId !== "string" || !messageId) {
    return {
      ok: false,
      kind: "transient",
      message: "Meta accepted the message but returned no message id.",
      code: null,
    };
  }

  return { ok: true, messageId };
}
