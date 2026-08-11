import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
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
 * The instruction was to enqueue anything real, and I looked at doing exactly
 * that. Two reasons it would be worse here:
 *
 *   1. background_jobs.type carries a CHECK constraint that is the
 *      authoritative list of job types, and it does not yet accept a WhatsApp
 *      type. Adding one is a schema change I cannot make.
 *   2. Even with the type available, it would make delivery status WORSE. The
 *      only synchronous work is one indexed UPDATE on communication_logs by
 *      provider_id — a couple of milliseconds. Enqueuing costs an INSERT of
 *      the same order, then waits for a worker tick, so a "delivered" receipt
 *      would land up to five minutes stale in exchange for saving nothing.
 *
 * The queue earns its keep when work is slow, external or retryable. Marking a
 * row delivered is none of those. If inbound-message STORAGE lands later (see
 * the note below) that IS queue-shaped, and the type should be added then.
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
        | { statuses?: unknown; messages?: unknown }
        | undefined;
      if (!value) continue;

      for (const status of asArray(value.statuses)) {
        await applyStatus(status as MetaStatus);
      }
      for (const message of asArray(value.messages)) {
        noteInboundMessage(message as MetaMessage);
      }
    }
  }
}

/**
 * Map one Meta status event back onto OUR record.
 *
 * ── How the row is found ──
 *
 * `communication_logs.provider_id` already holds the provider's own id for the
 * email path (Resend's message id), and a Meta `wamid` is the same kind of
 * thing. So a status event finds its row by `provider_id = wamid` scoped to
 * `channel = 'whatsapp'` — the channel filter matters because provider ids
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
    .select("id, status")
    .eq("provider_id", wamid)
    .eq("channel", "whatsapp")
    .maybeSingle();

  if (error) {
    console.error(`[whatsapp] status lookup failed for ${wamid}:`, error.message);
    return;
  }

  const row = data as { id: string; status: string | null } | null;

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
     *      provider_id. Real, and the correct fix is a short retry, which is
     *      queue-shaped work — see the module comment on why that is deferred.
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
 * ── Deliberately not stored ──
 *
 * Storage was excluded from this task, and the design question is genuinely
 * unresolved rather than merely unbuilt — see the report. The blocking fact is
 * that `communication_logs.company_id` is NOT NULL, and a message from an
 * unrecognised number belongs to no company, so the existing table cannot hold
 * one without either inventing a tenancy or relaxing that column.
 *
 * So this acknowledges and drops. NOTHING about the message content or the
 * sender's number is logged: this is candidate personal data arriving on a
 * public endpoint, and a log line is the easiest place for it to end up
 * somewhere nobody is auditing. Only Meta's opaque id and the message type are
 * recorded, which is enough to prove receipt without retaining anything about
 * the person.
 */
function noteInboundMessage(message: MetaMessage): void {
  const wamid = str(message.id);
  const type = str(message.type) || "unknown";
  console.log(
    `[whatsapp][inbound] received wamid=${wamid} type=${type} — not stored (see route comment)`,
  );
}

// ── Narrow helpers ───────────────────────────────────────────

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
