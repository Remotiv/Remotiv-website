/**
 * Every error code the booking route can return, in the candidate's words.
 *
 * Extracted from _booking-client.tsx so a test can hold it against the route:
 * every `fail(status, "code")` in src/app/api/book/[token]/route.ts and every
 * `reason` in src/lib/calendar/bookings.ts must have a sentence here, because
 * the fallback ("check your connection") is wrong advice for a rule refusal.
 *
 * The recovery line for a failure the candidate cannot fix is deliberately
 * NOT "reply to your email": the invitation came from the company's recruiter,
 * not from Remotiv, and that is who owns the booking.
 */
export const RECOVERY_LINE =
  "Try again in a moment. If it still doesn't work, contact the recruiter who invited you.";

export const ERROR_COPY: Record<string, string> = {
  not_found:
    "This booking link isn't valid. Check the link in your email, or contact the recruiter who invited you.",
  expired:
    "This booking link has expired. Contact the recruiter who invited you and they'll send a new one.",
  cancelled:
    "This interview was cancelled. Contact the recruiter who invited you if that's unexpected.",
  slot_taken: "That time was just taken. Pick another below.",
  too_late_to_move:
    "This interview is less than 24 hours away, so it can't be moved now - but you can still cancel it.",
  too_late:
    "This interview is less than 24 hours away, so the time can't be changed now. Your booking is unchanged - you can still cancel it.",
  too_late_to_cancel: "This interview has already started.",
  already_cancelled: "This interview is already cancelled.",
  not_booked: "This interview isn't booked, so there's nothing to change.",
  provider_failed:
    "We couldn't move it in the interviewer's calendar, so nothing was changed. Try again in a moment.",
  already_booked: "This interview is already booked.",
  bad_timezone: "That timezone wasn't recognised. Pick one from the list.",
  bad_slot: "That time couldn't be read. Pick a time from the list.",
  write_failed: `We couldn't save that change - your booking is exactly as it was. ${RECOVERY_LINE}`,
  calendar_failed: "We couldn't put that on the interviewer's calendar. Try another time.",
  unavailable: "Times aren't available right now. Try again shortly.",
  /*
   * NOT `not_found`, and deliberately not folded into `unavailable` above -
   * that one is about the interviewer having no slots, which would be a second
   * wrong answer. This is the lookup itself failing, and it is the one message
   * on this page where getting the tone wrong costs someone an interview: told
   * their link is invalid, a candidate concludes the process is over and stops.
   * So it says plainly that the link is fine.
   */
  lookup_failed:
    "We couldn't check your link just now - that's on us, not your link. Refresh the page, or try again in a minute.",
  network: `Something went wrong and nothing was changed. ${RECOVERY_LINE}`,
};

export function errorCopyFor(code: string | undefined | null): string {
  return (code && ERROR_COPY[code]) || ERROR_COPY.network;
}
