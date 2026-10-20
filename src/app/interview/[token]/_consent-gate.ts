import { CONSENT_NOT_SAVED_MESSAGE, CONSENT_REQUIRED } from "@/lib/interviews/consent";

/**
 * The async interview's consent, as the candidate page handles it. Pure, so
 * the decisions are tested without rendering the flow.
 *
 * ── Saved, or the candidate does not continue ────────────────
 *
 * saveConsent is true only when the consent route says ok: the route answers
 * ok only once the agreement is saved (api/interview/consent). A dropped
 * connection, a refusal or an unreadable reply is false, and the page stays
 * on the consent screen with CONSENT_SAVE_FAILED and a Try again button.
 *
 * ── Asked again, nothing lost ────────────────────────────────
 *
 * upload-url, confirm and submit refuse with CONSENT_REQUIRED when the
 * session has no saved agreement to the current text. The page then shows
 * the consent screen again, and once the agreement is saved it goes back to
 * what it was doing (screenAfterConsent): a recorded answer still on the
 * device is uploaded again, and a submit goes back to the review.
 */

/** What the candidate was doing when the server asked for consent again. */
export type ConsentResume = "upload" | "submit" | null;

export const CONSENT_SAVE_FAILED = CONSENT_NOT_SAVED_MESSAGE;

/** Shown above the consent screen when it comes back. Hyphens only. */
export const CONSENT_AGAIN: Record<Exclude<ConsentResume, null>, string> = {
  upload:
    "Before we save your answers, please confirm you agree. Your answer is still on this device and will upload as soon as you continue.",
  submit: "Please confirm you agree before you submit. Your answers are saved.",
};

/** Save the agreement. True only when the server says it is saved. */
export async function saveConsent(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl("/api/interview/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Whether a refusal from upload-url, confirm or submit is the server asking for consent. */
export function isConsentRequired(status: number, body: unknown): boolean {
  return (
    status === 403 &&
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === CONSENT_REQUIRED
  );
}

/** Where the page goes once the agreement is saved. */
export function screenAfterConsent(resume: ConsentResume): "tech" | "record" | "review" {
  if (resume === "upload") return "record";
  if (resume === "submit") return "review";
  return "tech";
}

export type ConsentStep =
  | { kind: "not_agreed" }
  | { kind: "busy" }
  | { kind: "save_failed" }
  | { kind: "continue"; screen: "tech" | "record" | "review"; retryUpload: boolean };

/**
 * What tapping Continue on the consent screen does. Not ticked: say so. Already
 * saving: nothing. Saved: go back to what the server interrupted (a waiting
 * answer is uploaded again). Not saved: stay, with Try again.
 */
export async function consentStep(input: {
  agreed: boolean;
  saving: boolean;
  resume: ConsentResume;
  save: () => Promise<boolean>;
}): Promise<ConsentStep> {
  if (!input.agreed) return { kind: "not_agreed" };
  if (input.saving) return { kind: "busy" };
  if (!(await input.save())) return { kind: "save_failed" };
  return {
    kind: "continue",
    screen: screenAfterConsent(input.resume),
    retryUpload: input.resume === "upload",
  };
}
