import "server-only";
import { createHash } from "node:crypto";
import { retentionPassed } from "@/lib/interviews/async-score-purge";
import { readFrozenQuestionSet } from "@/lib/interviews/frozen-questions";
import { exportEndMs, stampLiveEnded } from "@/lib/interviews/live-events";
import {
  CONFIRMED_EXIT_CODES,
  type EvidenceNotRetained,
  type ImportFailure,
  type IngestDeps,
  type IngestResult,
  isImportFailure,
  LIVE_OUTCOME_VERSION,
  LiveIngestError,
  type LiveIngestErrorCode,
  type LiveOutcome,
  type LiveQuestionFacts,
  outcomeFrom,
  readSession,
  type SessionRow,
  saveLiveExport,
} from "@/lib/interviews/live-ingest";
import { LiveExportError, parseExport } from "@/lib/interviews/live-provider/parse-export";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";

/**
 * Importing one provider export (#51, 25 Nov): never lose an interview to an
 * export that cannot be read.
 *
 * ── In order ─────────────────────────────────────────────────
 *
 *   1. The raw export is stored as evidence, BEFORE it is parsed, so even a
 *      crash mid-parse leaves it behind: in the session's own private folder
 *      of the interview-videos bucket ({sessionId}/export-{sha}.json), where
 *      the six-month purge, the applicant and company deletions and every
 *      other whole-folder removal (removeSessionObjects) already reach it.
 *      Kept WHOLE, up to EVIDENCE_MAX_BYTES, or not at all: a larger export,
 *      a failed upload or one that cannot be turned into text keeps nothing,
 *      and the failure says so (evidence_not_retained, a reason code).
 *   2. It is parsed and saved by saveLiveExport, unchanged.
 *   3. A fully successful save (or one already stored, or an export not final
 *      yet) deletes the evidence: it is kept only for a refused export.
 *   4. An export refused as BROKEN (BROKEN_CODES: unreadable JSON, any parse
 *      rule, two base questions, more than 10 follow-ups or two with one
 *      index, missing or bad audio) is recorded as a technical failure: a
 *      reason code, never the provider's text; final, so it is restart-eligible
 *      under F10; nothing is queued, so nothing is scored. Never "Completed".
 *   5. Nothing already saved is ever wiped. An interview whose outcome a good
 *      export already wrote keeps it; turns a good part already stored are
 *      kept and counted in the failure (answered, skipped, not reached).
 *
 * A later good export of the same session replaces the failure, once
 * (saveLiveExport writes onto exactly the failure it read), and is scored
 * like any other. If the evidence itself cannot be stored, the failure is
 * still recorded and one line is logged: ids and codes only.
 *
 * Any other refusal (session not found, past retention, another session's
 * export, a storage or database error) is thrown as before: nothing is
 * recorded, and the evidence is kept for whoever looks at the failed job.
 */

/**
 * The largest raw export kept as evidence, whole: 25 MB. An export is the
 * transcript and its metadata only (each turn's audio is a separate file):
 * about 800 bytes a turn, 19 to 52 KB for the provider's 13-minute samples,
 * and a long 60-minute interview is still in the low hundreds of KB. 25 MB is
 * over a hundred times that, so only a broken export reaches it, and it sits
 * well inside the bucket, which already takes 100 MB answer videos. Above it,
 * nothing is kept: never a partial copy.
 */
export const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

/** The importer's refusals that mean the export itself is broken. */
const BROKEN_INGEST: ReadonlySet<LiveIngestErrorCode> = new Set<LiveIngestErrorCode>([
  "unknown_question_position",
  "too_many_follow_ups",
  "missing_audio",
  "bad_audio",
]);

/** Where one export's evidence lives: flat in the session's folder, so every whole-folder removal reaches it. */
export function evidencePath(sessionId: string, sha256: string): string {
  return `${sessionId}/export-${sha256.slice(0, 32)}.json`;
}

export type ImportResult =
  | IngestResult
  | { outcome: LiveOutcome | null; saved: false; refused: string; notFinal?: undefined };

type Service = IngestDeps["service"];

/** The raw export as text, or null when it cannot be turned into text at all. */
function asText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw) ?? null;
  } catch {
    return null;
  }
}

type Evidence = { path: string | null; notRetained: EvidenceNotRetained | null };

/**
 * Stores the evidence WHOLE, or not at all: the path, or why nothing was kept.
 * One log line when nothing was kept (ids and codes only).
 */
async function storeEvidence(
  service: Service,
  sessionId: string,
  text: string | null,
): Promise<Evidence> {
  const notKept = (reason: EvidenceNotRetained): Evidence => {
    console.error(`[live-import] session ${sessionId}: export evidence not retained (${reason})`);
    return { path: null, notRetained: reason };
  };
  if (text === null) return notKept("unserialisable");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > EVIDENCE_MAX_BYTES) return notKept("too_large");
  const path = evidencePath(sessionId, createHash("sha256").update(bytes).digest("hex"));
  try {
    const { error } = await service.storage
      .from(INTERVIEW_BUCKET)
      .upload(path, bytes, { contentType: "application/json", upsert: true });
    if (error) throw new Error("upload refused");
    return { path, notRetained: null };
  } catch {
    return notKept("storage_failed");
  }
}

async function removeEvidence(service: Service, paths: (string | null)[]): Promise<void> {
  const real = paths.filter((p): p is string => Boolean(p));
  if (real.length === 0) return;
  try {
    const { error } = await service.storage.from(INTERVIEW_BUCKET).remove(real);
    if (error) throw new Error("remove refused");
  } catch {
    // Left for the orphan sweep: nothing references it once the import succeeded.
    console.error(`[live-import] ${real.length} evidence file(s) could not be removed now`);
  }
}

/**
 * The questions as far as stored turns show them: asked (a base question was
 * stored for it), answered (a candidate turn with speech responds to one of
 * its turns), or never reached. Nothing else is inferred.
 */
async function storedQuestionFacts(
  service: Service,
  row: SessionRow,
): Promise<{ questions: LiveQuestionFacts[]; turnCount: number }> {
  const frozen = readFrozenQuestionSet(row);
  const { data, error } = await service
    .from("interview_turns")
    .select("id, speaker, kind, question_position, responds_to_turn_id, duration_ms")
    .eq("session_id", row.id);
  if (error) throw new LiveIngestError("db_error", "turn read");
  const turns = (data ?? []) as {
    id: string;
    speaker: string;
    kind: string | null;
    question_position: number | null;
    responds_to_turn_id: string | null;
    duration_ms: number | null;
  }[];
  const byId = new Map(turns.map((t) => [t.id, t]));
  const positionOf = (t: (typeof turns)[number]) =>
    t.question_position ??
    (t.responds_to_turn_id ? (byId.get(t.responds_to_turn_id)?.question_position ?? null) : null);
  const questions = (frozen?.questions ?? []).map((q): LiveQuestionFacts => {
    const asked = turns.some(
      (t) => t.kind === "base_question" && t.question_position === q.position,
    );
    const answered = turns.some(
      (t) => t.speaker === "candidate" && positionOf(t) === q.position && (t.duration_ms ?? 0) > 0,
    );
    return {
      position: q.position,
      source: q.source,
      status: !asked ? "not_reached" : answered ? "answered" : "skipped",
      confirmed: null,
      follow_ups: turns.filter((t) => t.kind === "follow_up" && t.question_position === q.position)
        .length,
      repeats: 0,
      answer_ms: 0,
      needs_check: false,
      repeat_check: null,
      wording_check: null,
      interruption_check: null,
      follow_up_check: null,
      time_limit_check: null,
      order_check: null,
      moved_on_after: null,
    };
  });
  return { questions, turnCount: turns.length };
}

/**
 * The technical failure for a refused export. Never over an interview's own
 * outcome, never onto a restarted attempt; over an earlier failure only.
 */
async function recordImportFailure(
  deps: IngestDeps,
  sessionId: string,
  code: string,
  evidence: Evidence,
): Promise<LiveOutcome | null> {
  const row = await readSession(deps.service, sessionId);
  if (row?.kind !== "live") return null;
  const current = row.live_outcome as LiveOutcome | null;
  // A restarted attempt keeps what it had; an interview a good export saved keeps its outcome.
  if (row.status === "abandoned" || (current && !isImportFailure(current))) {
    console.error(
      `[live-import] session ${sessionId}: a later export was refused (${code}); the saved outcome is kept`,
    );
    return current;
  }
  const at = new Date(deps.now()).toISOString();
  const { questions, turnCount } = await storedQuestionFacts(deps.service, row);
  // provider_error with nothing usable: technical_failure, final, restart-eligible (D2, F10).
  const fields = outcomeFrom(
    questions,
    "provider_error",
    row.attempt ?? 1,
    true,
    false,
    CONFIRMED_EXIT_CODES,
    null,
  );
  const failure: ImportFailure = {
    code,
    evidence_path: evidence.path,
    evidence_not_retained: evidence.notRetained,
    at,
  };
  const outcome: LiveOutcome = {
    v: LIVE_OUTCOME_VERSION,
    saved_at: at,
    export_hash: "",
    provider_session_id: row.provider_session_id ?? "",
    provider_status: null,
    provider_status_code: "provider_error",
    provider_end_reason: null,
    completed_gracefully: null,
    answers_usable: false,
    turn_count: turnCount,
    questions,
    timing_suspect: false,
    timing_suspect_turns: [],
    wording_check_turns: [],
    follow_up_check_turns: [],
    time_limit_check_turns: [],
    order_check_turns: [],
    not_answered_turns: [],
    repeat_offer_turns: [],
    offer_reply_turns: [],
    repeat_check_turns: [],
    interruptions: [],
    interruption_check_turns: [],
    interruption_speech_turns: [],
    ...fields,
    needs_review: true,
    transcription_failed_turns: [],
    settle_rev: 0,
    import_failure: failure,
    import_failed_at: at,
  };
  const write = deps.service
    .from("interview_sessions")
    .update({ live_outcome: outcome })
    .eq("id", sessionId)
    .eq("kind", "live");
  const { error } = await (current && isImportFailure(current)
    ? write.eq("live_outcome->>import_failed_at", current.import_failed_at)
    : write.is("live_outcome", null)
  )
    .neq("status", "abandoned")
    .select("id");
  if (error) throw new LiveIngestError("db_error", "failure write");
  // The provider exported it, so the conversation is over: the end for video and restart,
  // at the save time, never later than the interview's length allows (#23).
  await stampLiveEnded(deps.service, sessionId, () => exportEndMs(row, deps.now()));
  console.error(
    `[live-import] session ${sessionId}: export refused (${code}); technical failure recorded`,
  );
  return outcome;
}

/** Import one raw export: evidence first, then parse and save; see the top of this file. */
export async function importLiveExport(
  sessionId: string,
  raw: unknown,
  deps: IngestDeps,
): Promise<ImportResult> {
  // Refusals that are not about the export are thrown before anything is stored.
  const row = await readSession(deps.service, sessionId);
  if (!row) throw new LiveIngestError("session_not_found", sessionId);
  if (row.kind !== "live") throw new LiveIngestError("not_live", sessionId);
  if (retentionPassed(row.delete_after, deps.now())) {
    throw new LiveIngestError("past_retention", sessionId);
  }
  const earlierEvidence = isImportFailure(row.live_outcome)
    ? row.live_outcome.import_failure.evidence_path
    : null;

  // 1. Evidence, before anything is parsed.
  const text = asText(raw);
  const evidence = await storeEvidence(deps.service, sessionId, text);

  const broken = async (code: string): Promise<ImportResult> => ({
    outcome: await recordImportFailure(deps, sessionId, code, evidence),
    saved: false,
    refused: code,
  });

  // 2. Parse.
  let parsed: ReturnType<typeof parseExport>;
  try {
    const json = typeof raw === "string" ? JSON.parse(raw) : raw;
    parsed = parseExport(json);
  } catch (err) {
    if (err instanceof LiveExportError) return broken(err.code);
    if (err instanceof SyntaxError || text === null) return broken("bad_json");
    throw err;
  }

  // 3. Save.
  let result: IngestResult;
  try {
    result = await saveLiveExport(sessionId, parsed, deps);
  } catch (err) {
    if (err instanceof LiveIngestError && BROKEN_INGEST.has(err.code)) return broken(err.code);
    throw err;
  }

  // 4. Saved, already stored, or not final yet: no evidence is kept, an earlier failure's included.
  //    A notFinal answer is handed back as it is: it means RETRY LATER (the
  //    REQUIREMENT on saveLiveExport), never processed and never failed.
  await removeEvidence(deps.service, [evidence.path, result.saved ? earlierEvidence : null]);
  return result;
}
