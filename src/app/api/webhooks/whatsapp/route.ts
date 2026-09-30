import { NextResponse } from "next/server";
import { normalizeEmail, toWhatsAppDigits } from "@/lib/normalize";
import { createServiceClient } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/usage";
import {
  constantTimeEquals,
  verifyMetaSignature,
} from "@/lib/whatsapp/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WhatsApp Cloud API webhook.
 *
 * ── What this endpoint is, and is not ────────────────────────
 *
 * It RECEIVES. It does not send, does not render templates and does not
 * register numbers. Meta needs a live Callback URL and Verify Token before any
 * of that is possible, so this is the first piece and deliberately the only
 * one.
 *
 * ── It is public, so the signature is the entire security model ──
 *
 * No session, no cookie, no bearer token. The URL is pasted into Meta's
 * dashboard and appears in their logs, so it is not a secret. Every POST is
 * HMAC-verified against WHATSAPP_APP_SECRET over the raw body before a single
 * field is read, and an unsigned or mismatched request is refused before
 * parsing. See lib/whatsapp/verify.ts.
 *
 * ── Why nothing is enqueued ──────────────────────────────────
 *
 * The brief says anything real goes through the queue, and I looked hard at
 * doing that. It is the wrong call here, for two reasons:
 *
 *   1. background_jobs.type carries a CHECK constraint listing the accepted
 *      job types, and it has no WhatsApp entry. Adding one is a schema change
 *      I cannot make, so there is no type to enqueue against today.
 *   2. Even with the type available it would be worse. Everything this route
 *      does is a small number of indexed statements — one select plus one
 *      update for a status, one insert plus one bounded select for an inbound
 *      message. Enqueuing costs an INSERT of the same order and then waits for
 *      a worker tick, so a "delivered" receipt would land up to five minutes
 *      stale in exchange for saving nothing.
 *
 * The queue earns its keep when work is slow, external or retryable. None of
 * this is. What WOULD justify it is any future work that calls Meta back —
 * downloading inbound media, say — and that is the point to add the type.
 *
 * Every query below is bounded. Nothing here scans, and nothing loops over a
 * collection Meta controls the size of without a limit.
 *
 * ── Returning 200 ────────────────────────────────────────────
 *
 * Meta retries aggressively on non-200 and on slow responses. After the
 * signature passes, this route returns 200 whatever happens downstream: a
 * database hiccup must not cause Meta to redeliver an event forever, and for
 * statuses a lost event is self-healing because the next one supersedes it
 * (sent → delivered → read). Failures are logged loudly instead.
 */

/** Meta's status vocabulary, in the order a message moves through it. */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

/** A terminal failure outranks nothing — it replaces whatever was there. */
const FAILED = "failed";

type MetaStatus = {
  id?: unknown;
  status?: unknown;
  timestamp?: unknown;
  errors?: { code?: unknown; title?: unknown }[];
};

type MetaMessage = {
  id?: unknown;
  from?: unknown;
  /**
   * The business-scoped user id. Present alongside `from` today, and the ONLY
   * identifier once a candidate adopts a WhatsApp username — at which point
   * `from` stops arriving entirely.
   */
  from_user_id?: unknown;
  type?: unknown;
};

/**
 * ── GET: Meta's verification handshake ──
 *
 * Meta calls this once when the Callback URL is saved, and again whenever it
 * is edited. It expects the raw challenge echoed back as plain text — not
 * JSON, not quoted — with a 200.
 *
 * Fails CLOSED: an unset WHATSAPP_WEBHOOK_VERIFY_TOKEN refuses every request
 * rather than accepting any token, so a misconfigured deploy cannot be
 * verified by an attacker who guesses the URL first.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    console.error("[whatsapp] WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set — refusing.");
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Every failure returns the same bare 403. Naming which check failed would
  // tell a prober whether the token was close, or whether the route exists in
  // a configured state at all.
  if (mode !== "subscribe" || !token || !constantTimeEquals(token, expected)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * ── POST: events ──
 *
 * Signature first, parse second. Nothing below the verification may read a
 * field from a payload whose origin has not been proven.
 */
export async function POST(request: Request) {
  // Read ONCE, as text. The HMAC is over these exact bytes — re-serialising
  // parsed JSON changes key order and whitespace and breaks valid signatures.
  const raw = await request.text();

  if (
    !verifyMetaSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      process.env.WHATSAPP_APP_SECRET,
    )
  ) {
    // Deliberately terse and deliberately 403. No detail about which part
    // failed, and nothing about the payload is logged — an unverified body is
    // attacker-controlled and must not reach the logs.
    console.warn("[whatsapp] rejected an unsigned or mismatched webhook POST.");
    return new NextResponse("Forbidden", { status: 403 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Signed but unparseable. 200 anyway: retrying will not make it parse, and
    // a retry loop on a malformed payload is worse than dropping it.
    console.error("[whatsapp] signed payload was not valid JSON.");
    return NextResponse.json({ ok: true });
  }

  try {
    await handleEvents(body);
  } catch (err) {
    // Never turns into a non-200. See the module comment.
    console.error("[whatsapp] event handling failed (non-fatal):", err);
  }

  return NextResponse.json({ ok: true });
}

async function handleEvents(body: unknown): Promise<void> {
  const entries = asArray((body as { entry?: unknown })?.entry);

  for (const entry of entries) {
    for (const change of asArray((entry as { changes?: unknown })?.changes)) {
      const value = (change as { value?: unknown })?.value as
        | { statuses?: unknown; messages?: unknown; contacts?: unknown }
        | undefined;
      if (!value) continue;

      for (const status of asArray(value.statuses)) {
        await applyStatus(status as MetaStatus);
      }
      // contacts[] carries the sender's WhatsApp profile name, which is a
      // different field from the message itself.
      const profileName = firstProfileName(value);
      for (const message of asArray(value.messages)) {
        await storeInbound(message as MetaMessage, profileName);
      }
    }
  }
}

/**
 * Map one Meta status event back onto OUR record.
 *
 * ── How the row is found ──
 *
 * `communication_logs.provider_message_id` was added and indexed for exactly
 * this. A status event finds its row by `provider_message_id = wamid`, scoped
 * to `channel = 'whatsapp'` — the channel filter matters because provider ids
 * come from different vendors and nothing guarantees they cannot collide.
 *
 * ── Idempotency, without a dedup table ──
 *
 * Meta redelivers, and it does not guarantee order: a retried `sent` can
 * arrive after `read`. Deduplicating on the event id would need a table I
 * cannot create, and would not fix the ordering problem anyway.
 *
 * Ranking the statuses solves both at once. A status is only written when it
 * OUTRANKS what is stored, so a redelivered event is a no-op by construction
 * and a late `sent` cannot demote a message that has already been read. That
 * is idempotency as a property of the data rather than a lookup.
 *
 * `failed` is the exception: it is terminal and always wins, because a message
 * that failed after being marked sent is genuinely failed.
 */
async function applyStatus(event: MetaStatus): Promise<void> {
  const wamid = str(event.id);
  const metaStatus = str(event.status).toLowerCase();
  if (!wamid || !metaStatus) return;

  const isFailure = metaStatus === FAILED;
  const incomingRank = STATUS_RANK[metaStatus];
  if (!isFailure && incomingRank === undefined) {
    // A status Meta has added since this was written. Logged rather than
    // guessed at — mapping an unknown state onto a known one would quietly
    // report something we do not actually know.
    console.warn(`[whatsapp] unrecognised status "${metaStatus}" for ${wamid}`);
    return;
  }

  const service = createServiceClient();
  const { data, error } = await service
    .from("communication_logs")
    .select("id, status, company_id")
    .eq("provider_message_id", wamid)
    .eq("channel", "whatsapp")
    .maybeSingle();

  if (error) {
    console.error(`[whatsapp] status lookup failed for ${wamid}:`, error.message);
    return;
  }

  const row = data as { id: string; status: string | null; company_id: string | null } | null;

  if (!row) {
    /*
     * ── An orphan status, logged loudly and never silently dropped ──
     *
     * A receipt for a message we have no record of sending is one of three
     * things, and they are not equally benign:
     *
     *   1. A message sent from OUTSIDE this system — Meta's own test console,
     *      or a manual send during setup. Expected right now, while the
     *      integration is being wired up, and harmless.
     *   2. A race: Meta delivered the receipt before our own send path wrote
     *      provider_message_id. Real, and the correct fix is a short retry,
     *      which is queue-shaped work — see the module comment.
     *   3. A forged payload. It would have to be signed with the app secret to
     *      get this far, so this reading means the secret has leaked.
     *
     * Silently ignoring it would hide (2) and (3) behind (1). The tag is fixed
     * and greppable so these can be counted; the wamid is Meta's own opaque id
     * and carries no personal data.
     */
    console.warn(
      `[whatsapp][orphan-status] no communication_logs row for wamid=${wamid} status=${metaStatus}`,
    );
    return;
  }

  const current = (row.status ?? "").toLowerCase();
  if (current === FAILED) return; // terminal
  if (!isFailure) {
    const currentRank = STATUS_RANK[current];
    // Unknown current status (e.g. 'cancelled', 'skipped') is left alone —
    // those are OUR decisions and a provider receipt must not overwrite one.
    if (currentRank === undefined) return;
    if (incomingRank <= currentRank) return; // redelivery, or out of order
  }

  const patch: Record<string, unknown> = { status: metaStatus };
  if (isFailure) {
    const first = asArray(event.errors)[0] as
      | { code?: unknown; title?: unknown }
      | undefined;
    const title = str(first?.title);
    const code = str(first?.code);
    patch.error = [code, title].filter(Boolean).join(" ").slice(0, 500) || "WhatsApp delivery failed.";
  }

  const { error: updErr } = await service
    .from("communication_logs")
    .update(patch)
    .eq("id", row.id);

  /*
   * ── Metering, on the DELIVERY THRESHOLD ──
   *
   * Meta charges for a message that reached the handset, not one we handed
   * over — so `sent` is the wrong trigger and would over-count every message
   * that failed after acceptance.
   *
   * Fired when the row CROSSES delivered for the first time, which is what
   * makes it exactly-once without a dedup table: the rank guard above has
   * already discarded every redelivery, so reaching this line at all means
   * the status genuinely advanced. `read` counts too, because a message that
   * was read was necessarily delivered — Meta occasionally coalesces the two
   * and a lost `delivered` webhook would otherwise mean a free message.
   */
  if (!updErr && !isFailure && row.company_id) {
    const priorRank = STATUS_RANK[current] ?? -1;
    const crossedDelivered =
      priorRank < STATUS_RANK.delivered && incomingRank >= STATUS_RANK.delivered;
    if (crossedDelivered) {
      // Never throws — see lib/usage.ts. Metering must not be able to turn a
      // received webhook into a retried one.
      await recordUsage({
        companyId: row.company_id,
        type: "whatsapp_sent",
        refId: row.id,
      });
    }
  }

  if (updErr) {
    /*
     * The most likely cause is communication_logs.status carrying a CHECK
     * constraint written for the email path, which knows nothing of
     * 'delivered' or 'read'. That is a schema change, not a code fix — the
     * message names it explicitly so it is not mistaken for a transient fault.
     */
    console.error(
      `[whatsapp] could not write status "${metaStatus}" for ${wamid} — ` +
        `if this is a constraint violation, communication_logs.status needs ` +
        `'delivered' and 'read' added to its CHECK. ${updErr.message}`,
    );
  }
}

/**
 * An inbound message from a candidate.
 *
 * ── Storage ──
 *
 * `whatsapp_inbound` exists now, with `wa_message_id` unique — so idempotency
 * is the database's job rather than a read-then-write race. A redelivery hits
 * the unique constraint and is swallowed as the no-op it is.
 *
 * ── Tenancy is resolved, never guessed ──
 *
 * `company_id` and `application_id` are NULLABLE on purpose. A message from an
 * unrecognised number belongs to nobody, and inventing a tenancy for it would
 * put a stranger's message in some company's inbox. So the phone is matched
 * against applications and attached on a single hit, or on several that are
 * provably the same person — see `isOnePerson`. A number shared by DIFFERENT
 * people, or matching nothing, leaves both null and surfaces unattached.
 *
 * ── Both identifiers are stored, because one of them is going away ──
 *
 * `bsuid` is Meta's business-scoped user id. It arrives ALONGSIDE the phone
 * today, and becomes the only identifier once a candidate adopts a WhatsApp
 * username. Storing both now is what makes a phone→BSUID link learnable while
 * the two still appear together; once `from` stops arriving there is no way
 * left to associate the two, so a row captured today is the only bridge to a
 * candidate who goes username-only tomorrow.
 */
async function storeInbound(message: MetaMessage, profileName: string | null): Promise<void> {
  const wamid = str(message.id);
  if (!wamid) return;

  // Null, not "": a message that carried no phone is a different fact from one
  // that carried an empty one, and only the first is now expected.
  const fromPhone = str(message.from) || null;
  const bsuid = str(message.from_user_id) || null;
  const type = str(message.type) || "unknown";
  const body = extractBody(message);

  const service = createServiceClient();
  const resolved = await resolveTenancy(service, fromPhone);

  const { error } = await service.from("whatsapp_inbound").insert({
    wa_message_id: wamid,
    from_phone: fromPhone,
    bsuid,
    profile_name: profileName,
    body,
    message_type: type,
    raw: message as unknown as Record<string, unknown>,
    company_id: resolved.companyId,
    application_id: resolved.applicationId,
    received_at: new Date().toISOString(),
  });

  if (error) {
    // 23505 is the unique violation on wa_message_id — a redelivery, which is
    // the expected case and not worth a line in the log.
    if (!String(error.code) .includes("23505")) {
      console.error(`[whatsapp] inbound insert failed for ${wamid}:`, error.message);
    }
    return;
  }

  // Only after the message is safely stored, so an opt-out can never be
  // recorded for a message we failed to keep evidence of.
  await maybeOptOut(service, fromPhone, bsuid, body);
}

/**
 * Match an inbound number to an application, or return nulls.
 *
 * ── Why the prefilter is a regex and not an `ilike` ──
 *
 * The `phone` column holds whatever the apply form was given — "0300-1234567",
 * "+92 300 1234567", "0336 23 22 584" — so a direct equality match would miss
 * almost everything. A prefilter narrows the table to a handful of rows, and
 * `toWhatsAppDigits` then confirms each one; the prefilter is a cheap filter,
 * the normaliser is the actual test.
 *
 * That prefilter used to be `ilike '%<last 9 digits>%'`, and the comment here
 * claimed it survived any formatting the column carried. It did not. The
 * pattern is a contiguous digit run matched against the RAW text, so a space
 * or a dash falling anywhere inside those nine digits hid the row completely
 * — 177 of the 3,124 addressable numbers in this table could not find
 * themselves, and the normaliser never got the chance to correct it because
 * the row was already excluded. Measured, not theorised.
 *
 * So the digits are joined by `[^0-9]*` instead, which tolerates a separator
 * run of any length between any two of them. The pattern is built ONLY from
 * the output of `toWhatsAppDigits`, which is digits by construction, so there
 * is nothing in it that could be a regex metacharacter.
 *
 * Still bounded: the nine trailing digits in order are selective enough that
 * this stays a handful of rows, and the `limit` below caps it regardless.
 */
async function resolveTenancy(
  service: ReturnType<typeof createServiceClient>,
  fromPhone: string | null,
): Promise<{ companyId: string | null; applicationId: string | null }> {
  const none = { companyId: null, applicationId: null };
  const digits = toWhatsAppDigits(fromPhone);
  if (!digits) return none;

  // Last nine digits, each allowed to be followed by a run of non-digits.
  const tail = digits.slice(-9);
  const pattern = tail.split("").join("[^0-9]*");
  const { data, error } = await service
    .from("job_applications")
    .select("id, phone, email, first_name, last_name, company_id_snapshot, created_at")
    .filter("phone", "imatch", pattern)
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) return none;

  // Ordered newest-first by the query above, and `filter` preserves that — so
  // matches[0] is the most recent application on this number.
  const matches = ((data ?? []) as MatchRow[]).filter((r) => toWhatsAppDigits(r.phone) === digits);

  if (matches.length === 0) return none;

  if (matches.length > 1 && !isOnePerson(matches)) {
    /*
     * Genuinely shared: two or more DIFFERENT people on one number. Still
     * refused, and now said out loud rather than dropped — attaching the
     * message would attribute one person's words to another, which is worse
     * than leaving the row unattached for a human to read.
     */
    console.warn(
      `[whatsapp][ambiguous-sender] ${matches.length} applications from ` +
        `different people share this number — left unattached.`,
    );
    return none;
  }

  return {
    companyId: matches[0].company_id_snapshot,
    applicationId: matches[0].id,
  };
}

type MatchRow = {
  id: string;
  phone: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_id_snapshot: string | null;
};

/** Lowercased, whitespace-collapsed "first last", or "" if neither is set. */
function fullName(row: MatchRow): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Are all of these applications the same person?
 *
 * ── The rule, exactly ──
 *
 * True on either of two grounds, in this order:
 *
 *   1. EVERY match carries a non-empty email and all of them are equal once
 *      lowercased and trimmed.
 *   2. EVERY match carries a non-empty "first last" name and all of them are
 *      equal once lowercased and whitespace-collapsed.
 *
 * Anything else is false.
 *
 * ── Why "every", and not "all the ones that have it" ──
 *
 * This is the whole difference between a rule that merges and a rule that
 * refuses. Comparing only the values that happen to be present would treat a
 * missing email as agreement, so an application with no email would be folded
 * into whoever else shares the number — silently, and on no evidence at all.
 * Absent evidence is not matching evidence. A row that cannot prove it is the
 * same person makes the whole group ambiguous, and an ambiguous group is
 * refused.
 *
 * Ground 2 accepts one person holding two email addresses, which is the common
 * real case — somebody applying twice months apart with a work address and a
 * personal one. It does mean two different people who share BOTH a phone and
 * an identical name would be merged. That is a real residual, accepted
 * knowingly: it needs two coincidences at once, and the alternative refuses
 * hundreds of genuine re-applications to avoid it.
 */
function isOnePerson(matches: MatchRow[]): boolean {
  const emails = matches.map((r) => normalizeEmail(r.email ?? "")).filter((e) => e.length > 0);
  if (emails.length === matches.length && new Set(emails).size === 1) return true;

  const names = matches.map(fullName).filter((n) => n.length > 0);
  if (names.length === matches.length && new Set(names).size === 1) return true;

  return false;
}

/**
 * Keywords that opt a phone out, matched against the WHOLE message.
 *
 * ── The matching rule, and why it is strict ──
 *
 * The body is reduced to letters and digits only, uppercased, and must then
 * EQUAL one of these. So "STOP", "stop.", "Stop!" and "opt-out" all match,
 * because punctuation and case are stripped — while "please stop" becomes
 * PLEASESTOP and "I'll stop by tomorrow" becomes ILLSTOPBYTOMORROW, neither of
 * which equals anything here.
 *
 * Substring matching was the alternative and is worse. A false POSITIVE
 * silently blocks a candidate from every future WhatsApp with no way for them
 * to know; a false NEGATIVE ("STOP SENDING ME MESSAGES" does not match) leaves
 * the message sitting in whatsapp_inbound where a human can see it and act.
 * Given one of those is recoverable and the other is not, strict wins.
 */
const OPT_OUT_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "REMOVE",
]);

export function isOptOutMessage(body: string | null): boolean {
  if (!body) return false;
  const normalised = body.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!normalised || normalised.length > 12) return false;
  return OPT_OUT_KEYWORDS.has(normalised);
}

/**
 * Record a global opt-out, on WHICHEVER identifier arrived.
 *
 * Global by design: an opt-out row carries no company column, so STOP means
 * "no WhatsApp from Remotiv, ever" rather than "not about this one job".
 * Someone silencing a channel is not making a per-tenant distinction, and
 * asking them to repeat it per company would be absurd.
 *
 * ── Why this takes two identifiers ──
 *
 * It used to take the phone alone and return in silence when the phone could
 * not be normalised. That was a compliance hole rather than a tidy guard: a
 * candidate who has adopted a WhatsApp username sends no phone at all, so
 * their STOP normalised to null, nothing was written, and the next dispatch
 * read their still-valid stored number and sent anyway. The candidate had
 * said stop, and Meta counts that against the business.
 *
 * So the phone is now one of two keys, and the row is written whenever EITHER
 * is present. Both are recorded when both arrive, which is what lets a
 * phone-keyed enforcement check keep working while also building the
 * BSUID-keyed history a username-only candidate will need.
 *
 * The remaining gap is deliberate and documented rather than papered over:
 * `dispatch.ts` enforces on the phone stored against the application, so a
 * BSUID-only opt-out is recorded here but not yet consulted there. Closing
 * that needs a candidate→BSUID link, which cannot exist until rows captured
 * by storeInbound provide one.
 */
async function maybeOptOut(
  service: ReturnType<typeof createServiceClient>,
  fromPhone: string | null,
  bsuid: string | null,
  body: string | null,
): Promise<void> {
  if (!isOptOutMessage(body)) return;
  const digits = toWhatsAppDigits(fromPhone);

  if (!digits && !bsuid) {
    /*
     * A STOP nobody can act on. This is the loud path the silent return
     * replaced: the message is already stored, so the evidence exists, but
     * there is no key to write an opt-out against and the candidate WILL be
     * messaged again. The tag is fixed and greppable because this needs a
     * human, not a metric — and it is console.error rather than warn because
     * an unrecorded opt-out is a compliance failure, not a curiosity.
     */
    console.error(
      "[whatsapp][opt-out-unrecorded] an inbound opt-out keyword arrived with " +
        "neither a normalisable phone nor a BSUID — nothing could be recorded, " +
        "and this candidate can still be messaged. Needs manual follow-up.",
    );
    return;
  }

  /*
   * Whichever identifier is present becomes the conflict target. An absent
   * identifier is OMITTED rather than sent as null: merge-duplicates overwrites
   * every column it is given, so sending `bsuid: null` on a later phone-only
   * STOP would erase a BSUID learned earlier — discarding the only identifier
   * that will still work once the phone stops arriving.
   */
  const row: { phone?: string; bsuid?: string; reason: string } = {
    reason: "Inbound opt-out keyword.",
  };
  if (digits) row.phone = digits;
  if (bsuid) row.bsuid = bsuid;

  const { error } = await service
    .from("whatsapp_opt_outs")
    .upsert(row, { onConflict: digits ? "phone" : "bsuid" });

  if (error) {
    // Loud, and never swallowed: a failed write here means the opt-out did not
    // happen, which is the same outcome as the bug above by a different route.
    console.error(
      `[whatsapp][opt-out-unrecorded] opt-out write failed (keyed on ` +
        `${digits ? "phone" : "bsuid"}): ${error.message}`,
    );
    return;
  }
  // Neither identifier is logged — the opt-out is recorded, and that is the
  // fact worth keeping. Personal data in the logs is data nobody audits.
  console.log(
    `[whatsapp] recorded a global opt-out from an inbound keyword ` +
      `(phone: ${digits ? "yes" : "no"}, bsuid: ${bsuid ? "yes" : "no"}).`,
  );
}

/** Text, or the caption on a media message. Never anything else. */
function extractBody(message: MetaMessage): string | null {
  const m = message as unknown as Record<string, unknown>;
  const text = (m.text as { body?: unknown } | undefined)?.body;
  if (typeof text === "string") return text.slice(0, 4000);
  for (const kind of ["image", "video", "document", "audio"]) {
    const caption = (m[kind] as { caption?: unknown } | undefined)?.caption;
    if (typeof caption === "string") return caption.slice(0, 4000);
  }
  return null;
}

// ── Narrow helpers ───────────────────────────────────────────

function firstProfileName(value: { contacts?: unknown }): string | null {
  const contact = asArray(value.contacts)[0] as
    | { profile?: { name?: unknown } }
    | undefined;
  const name = contact?.profile?.name;
  return typeof name === "string" ? name.slice(0, 200) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
