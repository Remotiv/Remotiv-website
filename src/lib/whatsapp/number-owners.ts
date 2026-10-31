/**
 * Who owns a WhatsApp number, decided the same way everywhere.
 *
 * Two surfaces answer "which applicant does this phone belong to": the webhook
 * when it attaches an inbound message (resolveTenancy), and the applicant
 * drawer when it decides whether to SHOW inbound messages at all
 * (fetchApplicationInbound). Until #64 the drawer had no such decision - it
 * rendered every row whose sender normalised to the open applicant's number,
 * which showed a candidate's replies to company B inside company A's drawer,
 * and showed two different people on one shared phone each other's messages.
 *
 * The predicate lives here so there is ONE of it. A privacy rule duplicated
 * across a webhook and a server action is two rules the moment either is
 * edited, and the drift would be invisible until the wrong message rendered.
 *
 * Nothing here reads the database. Each caller runs its own prefilter and
 * passes the rows in, so this module stays a pure function of rows and the
 * tenant-isolation scan keeps seeing each read where it is issued.
 */
import { normalizeEmail, toWhatsAppDigits } from "@/lib/normalize";

/**
 * The application columns the ownership rule needs. `first_name` and
 * `last_name` are carried because both callers already select them (the
 * webhook stores the profile name beside the row); `isOnePerson` does NOT
 * read them - see its docblock for why the name is not evidence here.
 */
export type MatchRow = {
  id: string;
  phone: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_id_snapshot: string | null;
};

/**
 * How many prefiltered applications a caller reads before giving up.
 *
 * A page that comes back FULL may be incomplete, and an incomplete set of
 * owners cannot prove the number belongs to one person - so the drawer treats
 * a full page as "not provably unique" and shows nothing. Twenty-five rows
 * sharing nine trailing digits is far past any one person's re-applications.
 */
export const OWNER_LOOKUP_LIMIT = 25;

/**
 * The regex prefilter both sides run against the RAW `phone` column.
 *
 * The column holds whatever the apply form was given - "0300-1234567",
 * "+92 300 1234567", "0336 23 22 584" - so equality cannot find it. The nine
 * trailing digits, each allowed to be followed by a separator run, narrow the
 * table cheaply; `confirmedOwners` then applies the real test. Built ONLY from
 * `toWhatsAppDigits` output, which is digits by construction, so nothing in it
 * is a regex metacharacter.
 *
 * Nine digits drop the country code and the first local digit, so the
 * prefilter can also catch a DIFFERENT Pakistani number that differs only in
 * that first digit. That is why it is a prefilter and not the match.
 */
export function phonePrefilterPattern(digits: string): string {
  return digits.slice(-9).split("").join("[^0-9]*");
}

/** The prefiltered rows whose number is EXACTLY `digits` once normalised. */
export function confirmedOwners<T extends { phone: string | null }>(
  rows: T[],
  digits: string,
): T[] {
  return rows.filter((r) => toWhatsAppDigits(r.phone) === digits);
}

/**
 * Are all of these applications the same person?
 *
 * ── The rule, exactly ──
 *
 * True only when EVERY match carries a non-empty email and all of them are
 * equal once normalised by `normalizeEmail` (lowercased, trimmed). Nothing
 * else is consulted: not the name, not the company, not the dates. An empty
 * set is false.
 *
 * ── Why the email alone, and not the name ──
 *
 * An email address is near-unique and self-controlled, so two applications
 * carrying the same one are strong evidence of one person. A name is weak
 * evidence in either direction: common names collide (the original #64
 * concern), and one person's name is typed differently from one application
 * to the next - "Ali Khan" once, "Muhammad Ali Khan" the next time. When the
 * emails match the name adds nothing; requiring it to agree as well would
 * refuse exactly those ordinary re-applicants and hide their replies, to
 * close a hole the email check already closes.
 *
 * ── What changed on 2026-10-31 (#64), and in which direction ──
 *
 * Until then either ground sufficed: `email-equal OR name-equal`. One person
 * holding two addresses passed on the name; two people sharing an address
 * passed on the email. Now the email alone decides. Every set that passes
 * today also passed before (on its email), so nothing is loosened; what passed
 * before and no longer does is the same-name-different-email set, which is
 * the name collision. Strictly tighter than what shipped. It is deliberately
 * LOOSER than an `email-equal AND name-equal` rule, for the reason above.
 *
 * The webhook attaches on this predicate too, so the same tightening applies
 * there: applications that agree on the name but not the email are no longer
 * one person, and such a row stays unattributed for the admin inbox.
 *
 * ── Why "every", and not "all the ones that have it" ──
 *
 * This is the whole difference between a rule that merges and a rule that
 * refuses. Comparing only the emails that happen to be present would treat a
 * missing one as agreement, so an application with no email would be folded
 * into whoever else shares the number - silently, and on no evidence at all.
 * Absent evidence is not matching evidence: a blank anywhere refuses the set.
 * Blanks are real - /api/apply accepts an application with no email.
 *
 * ── What an email match is, and is not ──
 *
 * Nothing verifies that an applicant owns the address they typed. /api/apply
 * checks its SHAPE (`isValidEmail`) and normalises it; the manual-upload and
 * batch doors store the recruiter's text as given; no door sends anything the
 * applicant must click to prove the address is theirs, and `job_applications`
 * has no verified flag. So an equal email is a conservative interim heuristic
 * for "one person", not verified identity. It is the strongest signal the
 * table holds, and its failure mode runs the safe way: an address typed
 * differently on one application REFUSES the set, it never merges a stranger
 * in. Merging a stranger needs the residual below.
 *
 * ── Residual, accepted knowingly ──
 *
 * Two DIFFERENT people who share both a phone and an email address pass: a
 * household that runs one identity is treated as one identity, and their
 * replies render under whichever of them is open. That is far narrower than
 * a name collision, and it is accepted. The permanent answer is reply context
 * (Meta's `context.id`) captured at ingest, which ties a reply to the message
 * it answers and needs no identity inference at all.
 */
export function isOnePerson(matches: MatchRow[]): boolean {
  if (matches.length === 0) return false;
  const emails = matches.map((r) => normalizeEmail(r.email ?? ""));
  return emails.every((e) => e.length > 0) && new Set(emails).size === 1;
}

/**
 * May inbound messages from this number be shown as `applicationId`'s, inside
 * `companyId`? Only when the number maps to exactly ONE person at exactly ONE
 * company, and that company is the viewer's. The decision the webhook makes
 * for attachment, applied at read time.
 *
 *   - `owners` must contain the open application: if the prefilter did not
 *     find the applicant's own row, the lookup is not one to trust.
 *   - every owner must carry the viewer's company_id_snapshot. A null snapshot
 *     is a different tenant for this purpose, not a missing value, and a
 *     second company anywhere in the set means the candidate's replies cannot
 *     be told apart by company - one business number receives them all, and
 *     no reply context is captured (see fetchApplicationInbound).
 *   - more than one application is fine only when `isOnePerson` holds: the
 *     same candidate applying twice, not two people on a family phone.
 *
 * Fails closed on every other shape, including an empty set.
 */
export function soleOwnerAt(owners: MatchRow[], applicationId: string, companyId: string): boolean {
  if (owners.length === 0) return false;
  if (!owners.some((o) => o.id === applicationId)) return false;
  if (!owners.every((o) => o.company_id_snapshot === companyId)) return false;
  return owners.length === 1 || isOnePerson(owners);
}
