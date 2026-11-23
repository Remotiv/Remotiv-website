/**
 * What a person reads when a rate limit refuses them (#57), shared by the
 * server routes and the pages that call them. No server-only import here, so
 * client components can use it.
 *
 * 429: this caller went over the limit. 503: the limit store could not answer
 * and a fail-closed route refused rather than guess. Neither is the caller's
 * input being wrong, so neither may read like it ("invalid link", "code sent").
 */
export const TRY_AGAIN_SOON = "Please try again in a minute.";
export const TOO_MANY_ATTEMPTS = "Too many attempts. Please try again in a minute.";

/** The sentence for a refused response, or null when the status is not a refusal. */
export function refusalMessage(status: number): string | null {
  if (status === 429) return TOO_MANY_ATTEMPTS;
  if (status === 503) return TRY_AGAIN_SOON;
  return null;
}
