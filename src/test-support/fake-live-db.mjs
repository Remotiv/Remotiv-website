/**
 * An in-memory database and storage bucket for the AI Video Interview save and
 * purge tests, built on fake-postgrest.mjs. Unlike that fake, this one APPLIES
 * what it is asked: eq / in / is / lte / or filters, insert and upsert, update,
 * and storage upload / list / remove / createSignedUrl.
 *
 * interview_turns rows are checked against the constraints of migrations 021,
 * 022 and 041 on every insert and update, and a multi-row insert lands whole
 * or not at all, as one Postgres statement does. The three tables of migration
 * 042 (and 043) are checked too: job_question_scoring_guides (one per job and
 * wording, owned by the job's company), live_interview_scores (one per live
 * session, the partial, scored, incomplete and skipped rules) and live_interview_actions (append-only, the
 * time stamped here, never by the caller). A test that passes here wrote rows
 * the real table would accept.
 *
 * Faults: `failNext(table, op)` makes the next such call return an error and
 * change nothing; `failUploadAfter(n)` lets n uploads through and fails the
 * next one; `failRemove(path)` makes storage keep that object once. A unique
 * key reports 23505, every other constraint 23514, as Postgres does.
 *
 * Test-only. Nothing in the application imports this.
 */
import { fakeService } from "./fake-postgrest.mjs";

const isUuid = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);

/** Throws with the constraint's name when a turn row breaks one. */
export function checkTurnRow(row, allRows, sessions) {
  // A unique key reports 23505, as Postgres does; every CHECK reports 23514.
  const fail = (name, code = "23514") => {
    throw Object.assign(new Error(`violates ${name}`), { code, constraint: name });
  };
  const session = sessions.find((s) => s.id === row.session_id);
  if (session?.kind !== "live" || row.session_kind !== "live") fail("interview_turns_session_fk");
  if (!isUuid(row.id)) fail("id");
  if (!row.provider_turn_id?.trim()) fail("interview_turns_provider_turn_nonempty");
  if (!(Number.isInteger(row.sequence) && row.sequence >= 1))
    fail("interview_turns_sequence_positive");
  if (!["interviewer", "candidate"].includes(row.speaker)) fail("interview_turns_speaker");
  if (
    row.kind !== null &&
    !["base_question", "follow_up", "clarification", "procedural"].includes(row.kind)
  )
    fail("interview_turns_kind_values");
  if ((row.speaker === "interviewer") !== (row.kind !== null))
    fail("interview_turns_kind_interviewer_only");
  if (row.question_position !== null && row.question_position < 1)
    fail("interview_turns_position_positive");
  if (
    ["base_question", "follow_up", "clarification"].includes(row.kind) &&
    row.question_position === null
  )
    fail("interview_turns_position_required");
  if (
    (row.kind === "follow_up") !== (row.follow_up_index !== null) ||
    (row.follow_up_index !== null && ![1, 2].includes(row.follow_up_index))
  )
    fail("interview_turns_follow_up_index");
  if (row.kind === "follow_up" && row.follow_up_reason === null && row.content_purged_at == null)
    fail("interview_turns_follow_up_reason_required");
  if (row.kind !== "follow_up" && row.follow_up_reason !== null)
    fail("interview_turns_follow_up_reason_only");
  if (
    (row.speaker === "candidate" || ["follow_up", "clarification"].includes(row.kind)) &&
    !row.responds_to_turn_id
  )
    fail("interview_turns_responds_to_required");
  if (row.responds_to_turn_id) {
    if (row.responds_to_turn_id === row.id) fail("interview_turns_responds_to_not_self");
    if (!allRows.some((r) => r.id === row.responds_to_turn_id && r.session_id === row.session_id))
      fail("interview_turns_responds_to_fk");
  }
  if (row.speaker === "interviewer") {
    if (
      !(typeof row.text === "string" && row.text.trim()) &&
      !(row.text === null && row.content_purged_at != null)
    )
      fail("interview_turns_text_by_speaker");
  } else if (row.text !== null) fail("interview_turns_text_by_speaker");
  if (
    row.speaker !== "candidate" &&
    (row.transcript != null ||
      row.transcript_segments != null ||
      row.transcript_status != null ||
      row.transcript_error != null)
  )
    fail("interview_turns_transcript_candidate_only");
  if ((row.speaker === "candidate") !== (row.transcript_status != null))
    fail("interview_turns_transcript_status");
  if (row.media_path == null && row.content_purged_at == null)
    fail("interview_turns_media_present");
  if (row.media_path != null && !row.media_path.startsWith(`${row.session_id}/t${row.sequence}.`))
    fail("interview_turns_media_path");
  if (!(row.media_bytes > 0)) fail("interview_turns_media_bytes");
  if (!/^[0-9a-f]{64}$/.test(row.media_sha256 ?? "")) fail("interview_turns_media_sha256");
  if (!(row.media_mime_type ?? "").trim()) fail("interview_turns_media_mime_nonempty");
  if (!(row.offset_ms >= 0 && row.duration_ms > 0 && row.ended_at >= row.started_at))
    fail("interview_turns_timing");
  if (row.speaker !== "interviewer" && row.interrupted)
    fail("interview_turns_interrupted_interviewer_only");
  if (row.audio_stopped_ms != null && !(row.interrupted && row.audio_stopped_ms >= 0))
    fail("interview_turns_audio_stopped_interrupted_only");
  for (const other of allRows) {
    if (other === row || other.session_id !== row.session_id) continue;
    if (other.sequence === row.sequence) fail("interview_turns_sequence_key", "23505");
    if (other.provider_turn_id === row.provider_turn_id) {
      fail("interview_turns_provider_turn_key", "23505");
    }
    if (
      row.kind === "follow_up" &&
      other.kind === "follow_up" &&
      other.question_position === row.question_position &&
      other.follow_up_index === row.follow_up_index
    )
      fail("interview_turns_one_follow_up_per_slot", "23505");
  }
}

const SCORE_OUTCOMES = [
  "completed",
  "partial",
  "abandoned",
  "technical_failure",
  "ending_unconfirmed",
];
/** Outcomes that may carry an overall (migration 045). */
const OVERALL_OUTCOMES = ["completed", "partial", "ending_unconfirmed"];

/** Migration 042's checks and triggers, for its three tables. Throws as Postgres would. */
export function checkScoringRow(table, row, allRows, tables) {
  const fail = (name, code = "23514") => {
    throw Object.assign(new Error(`violates ${name}`), { code, constraint: name });
  };
  if (table === "job_question_scoring_guides") {
    const job = (tables.jobs ?? []).find((j) => j.id === row.job_id);
    if (!job) fail("job_question_scoring_guides_job_fk", "23503");
    if (job.company_id !== row.company_id) fail("job_question_scoring_guides_company", "P0001");
    if (!/^[0-9a-f]{64}$/.test(row.question_sha256 ?? ""))
      fail("job_question_scoring_guides_sha256");
    if (!["ai", "recruiter"].includes(row.source)) fail("job_question_scoring_guides_source");
    const g = (row.guide ?? "").trim();
    if (g.length < 1 || g.length > 4000) fail("job_question_scoring_guides_guide");
    if ((row.source === "ai") !== (row.ai_model != null && row.prompt_version != null))
      fail("job_question_scoring_guides_ai_fields");
    if (
      allRows.some(
        (o) => o !== row && o.job_id === row.job_id && o.question_sha256 === row.question_sha256,
      )
    )
      fail("job_question_scoring_guides_one_per_wording", "23505");
    return;
  }
  const session = tables.interview_sessions.find((s) => s.id === row.session_id);
  if (!session) fail(`${table}_session_fk`, "23503");
  if (session.kind !== "live") fail(`${table}_live_only`, "P0001");
  if (session.company_id !== row.company_id) fail(`${table}_company`, "P0001");
  if (table === "live_interview_scores") {
    if (allRows.some((o) => o !== row && o.session_id === row.session_id))
      fail("live_interview_scores_pkey", "23505");
    if (!["pending", "scored", "incomplete", "failed"].includes(row.status))
      fail("live_interview_scores_status");
    // Migration 043.
    if (
      !(row.skipped_count >= 0 && row.skipped_count <= row.total) ||
      row.answered_count + row.skipped_count > row.total
    )
      fail("live_interview_scores_skipped");
    if (row.status === "incomplete" && row.overall_score != null)
      fail("live_interview_scores_incomplete");
    if (row.overall_score != null && !OVERALL_OUTCOMES.includes(row.outcome))
      fail("live_interview_scores_overall_outcome");
    if (!Array.isArray(row.questions)) fail("live_interview_scores_questions_array");
    if (row.overall_score != null && !(row.overall_score >= 0 && row.overall_score <= 100))
      fail("live_interview_scores_overall_range");
    if (
      !(row.total >= 0) ||
      !(row.answered_count >= 0 && row.answered_count <= row.total) ||
      !(row.scored_count >= 0 && row.scored_count <= row.total)
    )
      fail("live_interview_scores_counts");
    if (!(row.completion_percent >= 0 && row.completion_percent <= 100))
      fail("live_interview_scores_completion");
    if (row.outcome != null && !SCORE_OUTCOMES.includes(row.outcome))
      fail("live_interview_scores_outcome");
    // 045: short of completed is always partial; a completed row may be held (partial).
    if (row.outcome != null && row.outcome !== "completed" && !row.partial)
      fail("live_interview_scores_partial");
    if (
      row.status === "scored" &&
      !(row.outcome != null && row.overall_score != null && row.scored_count > 0)
    )
      fail("live_interview_scores_scored");
    if (row.overall_score != null && !(row.scored_count > 0))
      fail("live_interview_scores_overall_needs_scored");
    if (!row.ai_model || !row.prompt_version) fail("live_interview_scores_not_null");
    if (!(row.rev >= 0)) fail("live_interview_scores_rev");
    return;
  }
  // live_interview_actions
  const ok =
    (row.action === "retry_transcription" && row.decision === "retry") ||
    ([
      "resolve_needs_check",
      "resolve_repeat_check",
      "resolve_wording_check",
      "resolve_style_check",
    ].includes(row.action) &&
      ["score", "exclude"].includes(row.decision)) ||
    (row.action === "resolve_failed_transcription" && row.decision === "exclude");
  if (!ok) fail("live_interview_actions_decision");
  if (
    [
      "resolve_needs_check",
      "resolve_repeat_check",
      "resolve_wording_check",
      "resolve_style_check",
    ].includes(row.action)
      ? row.question_position == null
      : row.turn_id == null || row.turn_sequence == null
  )
    fail("live_interview_actions_target");
  const note = (row.note ?? "").trim();
  if (note.length < 1 || note.length > 2000) fail("live_interview_actions_note");
  if (!["owner", "admin", "super_admin"].includes(row.actor_role))
    fail("live_interview_actions_role");
  if (!row.actor_user_id) fail("live_interview_actions_not_null");
}

const TERMINAL = ["submitted", "expired", "cancelled", "abandoned"];

/**
 * Migration 044 on interview_sessions: a live session's end is the database's
 * time, stamped at the first terminal status or first write, then set once.
 */
export function stampLiveEnded(row, old, nowMs = Date.now()) {
  if (row.kind !== "live") return row;
  if (old?.live_ended_at) {
    if (row.live_ended_at !== old.live_ended_at) {
      throw Object.assign(new Error("live_ended_at is set once"), { code: "P0001" });
    }
    return row;
  }
  if (row.live_ended_at || TERMINAL.includes(row.status)) {
    row.live_ended_at = new Date(nowMs).toISOString();
  }
  return row;
}

const LIVE_EVENT_KINDS = [
  "conversation_started",
  "end_pressed",
  "provider_complete",
  "provider_error",
  "connection_lost",
  "tab_closed",
  "timer_reached",
  "video_saved",
];
const PROVIDER_END_DETAILS = [
  "completed",
  "completed_not_graceful",
  "candidate_left",
  "timed_out",
  "other",
];

/** Migration 050's checks on live_session_events; the database stamps the time. Throws as Postgres would. */
export function checkLiveSessionEvent(row, sessions, nowMs = Date.now()) {
  const fail = (constraint, code = "23514") => {
    throw Object.assign(new Error(`violates ${constraint}`), { code });
  };
  for (const column of ["session_id", "company_id", "kind"]) {
    if (row[column] == null) fail(`live_session_events.${column} not null`, "23502");
  }
  const session = sessions.find((x) => x.id === row.session_id);
  if (!session) fail("live_session_events: session not found", "P0001");
  if (session.kind !== "live") fail("live_session_events: not a live interview", "P0001");
  if (session.company_id !== row.company_id) fail("live_session_events: company", "P0001");
  if (!LIVE_EVENT_KINDS.includes(row.kind)) fail("live_session_events_kind");
  const detail = row.detail ?? null;
  const detailOk =
    row.kind === "provider_complete"
      ? PROVIDER_END_DETAILS.includes(detail)
      : row.kind === "provider_error"
        ? detail === "error"
        : detail === null;
  if (!detailOk) fail("live_session_events_detail");
  row.id = row.id ?? crypto.randomUUID();
  row.detail = detail;
  row.created_at = new Date(nowMs).toISOString();
}

const ADMIN_ACCESS_ACTIONS = ["view_live_review", "open_turn_audio", "open_video_piece"];

/** Migration 046's checks on admin_access_logs; the database stamps the time. Throws as Postgres would. */
export function checkAdminAccessLog(row) {
  const fail = (constraint, code = "23514") => {
    throw Object.assign(new Error(`violates ${constraint}`), { code });
  };
  for (const column of ["user_id", "action", "session_id", "company_id"]) {
    if (row[column] == null) fail(`admin_access_logs.${column} not null`, "23502");
  }
  if (!ADMIN_ACCESS_ACTIONS.includes(row.action)) fail("admin_access_logs_action");
  row.id = row.id ?? crypto.randomUUID();
  row.application_id = row.application_id ?? null;
  row.created_at = new Date().toISOString();
}

/** Migration 044's constraints and triggers on live_video_pieces. Throws as Postgres would. */
export function checkVideoPiece(row, old, allRows, tables, nowMs = Date.now()) {
  const fail = (name, code = "23514") => {
    throw Object.assign(new Error(`violates ${name}`), { code, constraint: name });
  };
  const session = tables.interview_sessions.find((s) => s.id === row.session_id);
  if (!session) fail("live_video_pieces_session_fk", "23503");
  if (session.kind !== "live") fail("live_video_pieces_live_only", "P0001");
  if (session.company_id !== row.company_id) fail("live_video_pieces_company", "P0001");
  if (!(Number.isInteger(row.piece_index) && row.piece_index >= 0 && row.piece_index <= 199))
    fail("live_video_pieces_index_range");
  if (!["pending", "confirmed"].includes(row.status)) fail("live_video_pieces_status");
  if (!["video/webm", "video/mp4"].includes(row.mime_type)) fail("live_video_pieces_mime");
  const ext = row.mime_type === "video/mp4" ? "mp4" : "webm";
  if (row.media_path != null && row.media_path !== `${row.session_id}/v${row.piece_index}.${ext}`)
    fail("live_video_pieces_media_path");
  if (row.media_path == null && row.content_purged_at == null)
    fail("live_video_pieces_media_present");
  if (
    (row.bytes != null && !(row.bytes >= 1 && row.bytes <= 52428800)) ||
    (row.duration_ms != null && !(row.duration_ms >= 1 && row.duration_ms <= 180000)) ||
    (row.started_ms != null && !(row.started_ms >= 0))
  )
    fail("live_video_pieces_limits");
  if (
    row.status === "confirmed"
      ? !(
          row.confirmed_at &&
          row.bytes != null &&
          row.started_ms != null &&
          row.duration_ms != null
        )
      : row.confirmed_at != null || row.is_last
  )
    fail("live_video_pieces_confirmed_fields");
  if (
    allRows.some(
      (o) =>
        o !== row &&
        o !== old &&
        o.session_id === row.session_id &&
        o.piece_index === row.piece_index,
    )
  )
    fail("live_video_pieces_one_per_index", "23505");
  // The guard trigger.
  const ended = session.live_ended_at ? Date.parse(session.live_ended_at) : null;
  const guard = (msg) => fail(msg, "P0001");
  if (!old) {
    if (row.status !== "pending") guard("reserved before it is confirmed");
    if (ended !== null || !["invited", "started"].includes(session.status))
      guard("the interview has ended");
    return;
  }
  const strip = (r) => {
    const { media_path: _m, content_purged_at: _c, ...rest } = r;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  if (
    row.session_id !== old.session_id ||
    row.company_id !== old.company_id ||
    row.piece_index !== old.piece_index ||
    row.mime_type !== old.mime_type ||
    row.reserved_at !== old.reserved_at ||
    (row.media_path != null && row.media_path !== old.media_path) ||
    (old.content_purged_at != null && row.content_purged_at !== old.content_purged_at)
  )
    guard("a piece keeps its reservation");
  if (old.status === "confirmed") {
    if (strip(row) !== strip(old)) guard("a confirmed piece is never replaced");
    return;
  }
  if (row.status === "pending") {
    if (strip(row) !== strip(old))
      guard("a reserved piece changes only by being confirmed, or by retention");
    return;
  }
  if (
    old.media_path == null ||
    old.content_purged_at != null ||
    row.media_path == null ||
    row.content_purged_at != null
  )
    guard("a purged piece is never confirmed");
  if (ended === null && TERMINAL.includes(session.status)) guard("ended without a recorded end");
  if (ended !== null && nowMs > ended + 30 * 60_000) guard("the upload window closed");
}

const SCORING_TABLES = [
  "job_question_scoring_guides",
  "live_interview_scores",
  "live_interview_actions",
];

const SCORING_DEFAULTS = {
  live_interview_scores: {
    status: "pending",
    questions: [],
    overall_score: null,
    scored_count: 0,
    answered_count: 0,
    total: 0,
    completion_percent: 0,
    skipped_count: 0,
    outcome: null,
    partial: false,
    input_tokens: 0,
    output_tokens: 0,
    rev: 0,
    scored_at: null,
  },
  live_interview_actions: {
    question_position: null,
    turn_id: null,
    turn_sequence: null,
    actor_name: null,
  },
  job_question_scoring_guides: { competency: null, ai_model: null, prompt_version: null },
  live_video_pieces: {
    status: "pending",
    bytes: null,
    started_ms: null,
    duration_ms: null,
    is_last: false,
    confirmed_at: null,
    content_purged_at: null,
  },
};

/** The key `ignoreDuplicates` skips on, per table. */
const DUPLICATE_KEY = {
  interview_turns: (a, b) =>
    a.session_id === b.session_id && a.provider_turn_id === b.provider_turn_id,
  job_question_scoring_guides: (a, b) =>
    a.job_id === b.job_id && a.question_sha256 === b.question_sha256,
  live_interview_scores: (a, b) => a.session_id === b.session_id,
};

/** Apply one `.or("a.is.null,b.not.is.null")` clause. Only the forms the code uses. */
function orMatches(row, clause) {
  return clause.split(",").some((part) => {
    const m = part.match(/^([a-z_]+)\.(not\.)?is\.null$/);
    if (!m) throw new Error(`fake-live-db: unsupported or() part ${part}`);
    const isNull = row[m[1]] == null;
    return m[2] ? !isNull : isNull;
  });
}

/** A column, or a JSON path: `col->key` gives the value, `col->>key` its text, as PostgREST does. */
function get(row, col) {
  if (col.includes("->>")) {
    const [c, k] = col.split("->>");
    const v = row[c]?.[k];
    return v === undefined || v === null
      ? null
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  }
  if (!col.includes("->")) return row[col] ?? null;
  const [c, k] = col.split("->");
  return row[c]?.[k] ?? null;
}

const TURN_DEFAULTS = {
  transcript: null,
  transcript_segments: null,
  transcript_status: null,
  transcript_error: null,
  content_purged_at: null,
  interrupted: false,
  audio_stopped_ms: null,
  question_position: null,
  follow_up_index: null,
  follow_up_reason: null,
  responds_to_turn_id: null,
  kind: null,
};

/** `options.now`: the database's clock (now()), for live_ended_at and stamped times. Default the real clock. */
export function fakeLiveDb(initial = {}, options = {}) {
  const clock = options.now ?? Date.now;
  const tables = {
    interview_sessions: [],
    interview_turns: [],
    interview_answers: [],
    background_jobs: [],
    jobs: [],
    job_applications: [],
    job_question_scoring_guides: [],
    live_interview_scores: [],
    live_interview_actions: [],
    live_video_pieces: [],
    signed_url_logs: [],
    interview_answer_scores: [],
    interview_session_scores: [],
    admin_access_logs: [],
    live_session_events: [],
    ...structuredClone(initial),
  };
  /** path -> { bytes, contentType, createdAt } */
  const objects = new Map();
  const faults = [];
  /** Uploads left before the next one fails; null when no upload fault is set. */
  let uploadsBeforeFault = null;
  const keepOnce = new Set();
  /** Every signed upload URL handed out: { path, upsert }. */
  const signedUploads = [];
  const counts = {
    uploads: 0,
    turnInserts: 0,
    turnUpdates: 0,
    outcomeWrites: 0,
    scoreWrites: 0,
    guideInserts: 0,
  };
  let actionClock = Date.parse("2026-10-20T09:00:00.000Z");

  const takeFault = (table, op) => {
    const i = faults.findIndex((f) => f.table === table && f.op === op);
    if (i < 0) return false;
    faults.splice(i, 1);
    return true;
  };

  const service = fakeService((table, calls) => {
    const rows = tables[table];
    if (!rows) return { data: [], error: null };
    const match = (row) =>
      calls.every((c) => {
        if (c[0] === "eq") return get(row, c[1]) === c[2];
        if (c[0] === "in") return c[2].includes(get(row, c[1]));
        if (c[0] === "is") return get(row, c[1]) === c[2];
        if (c[0] === "lte") return get(row, c[1]) !== null && get(row, c[1]) <= c[2];
        if (c[0] === "not" && c[2] === "is") return get(row, c[1]) !== c[3];
        if (c[0] === "or") return orMatches(row, c[1]);
        return true;
      });
    const pick = (row) => structuredClone(row);
    const upsert = calls.find((c) => c[0] === "upsert" || c[0] === "insert");
    const update = calls.find((c) => c[0] === "update");
    try {
      if (upsert) {
        if (takeFault(table, "insert"))
          return { data: null, error: { code: "XX000", message: "fault" } };
        const incoming = (Array.isArray(upsert[1]) ? upsert[1] : [upsert[1]]).map((r) => {
          const row =
            table === "interview_turns"
              ? { ...TURN_DEFAULTS, ...structuredClone(r) }
              : { ...(SCORING_DEFAULTS[table] ?? {}), ...structuredClone(r) };
          // Set by the database, as migration 042's trigger does: never the caller's.
          if (table === "live_interview_actions") {
            actionClock += 1000;
            row.id = row.id ?? crypto.randomUUID();
            row.created_at = new Date(actionClock).toISOString();
          }
          if (table === "live_video_pieces") {
            row.id = row.id ?? crypto.randomUUID();
            row.reserved_at = row.reserved_at ?? new Date().toISOString();
          }
          if (table === "interview_sessions") stampLiveEnded(row, null, clock());
          return row;
        });
        const ignore = upsert[0] === "upsert" && upsert[2]?.ignoreDuplicates;
        const same = DUPLICATE_KEY[table];
        const fresh = incoming.filter((r) => !(ignore && same && rows.some((x) => same(x, r))));
        // One statement: check everything against the final state, then apply all or nothing.
        const after = [...rows, ...fresh];
        if (table === "interview_turns")
          for (const r of fresh) checkTurnRow(r, after, tables.interview_sessions);
        if (SCORING_TABLES.includes(table))
          for (const r of fresh) checkScoringRow(table, r, after, tables);
        if (table === "live_video_pieces")
          for (const r of fresh) checkVideoPiece(r, null, after, tables);
        if (table === "admin_access_logs") for (const r of fresh) checkAdminAccessLog(r);
        if (table === "live_session_events")
          for (const r of fresh) checkLiveSessionEvent(r, tables.interview_sessions, clock());
        rows.push(...fresh);
        if (table === "interview_turns") counts.turnInserts += 1;
        if (table === "live_interview_scores") counts.scoreWrites += fresh.length;
        if (table === "job_question_scoring_guides") counts.guideInserts += fresh.length;
        return { data: fresh.map(pick), error: null };
      }
      if (update) {
        if (takeFault(table, "update"))
          return { data: null, error: { code: "XX000", message: "fault" } };
        const hit = rows.filter(match);
        if (table === "admin_access_logs" && hit.length > 0) {
          throw Object.assign(new Error("admin_access_logs is append-only"), { code: "P0001" });
        }
        if (table === "live_session_events" && hit.length > 0) {
          throw Object.assign(new Error("live_session_events is append-only"), { code: "P0001" });
        }
        if (table === "live_interview_actions" && hit.length > 0) {
          throw Object.assign(new Error("live_interview_actions is append-only"), {
            code: "P0001",
          });
        }
        const next = hit.map((r) => ({ ...r, ...structuredClone(update[1]) }));
        for (const [i, r] of next.entries()) {
          if (table === "interview_sessions") stampLiveEnded(r, hit[i], clock());
          if (table === "live_video_pieces") checkVideoPiece(r, hit[i], rows, tables);
        }
        const after = rows.map((r) => next[hit.indexOf(r)] ?? r);
        if (table === "interview_turns") {
          for (const r of next) checkTurnRow(r, after, tables.interview_sessions);
          counts.turnUpdates += 1;
        }
        if (SCORING_TABLES.includes(table))
          for (const r of next) checkScoringRow(table, r, after, tables);
        if (table === "live_interview_scores") counts.scoreWrites += hit.length;
        for (const [i, r] of hit.entries()) Object.assign(r, next[i]);
        if (table === "interview_sessions" && "live_outcome" in update[1])
          counts.outcomeWrites += hit.length;
        return { data: hit.map(pick), error: null };
      }
      if (takeFault(table, "select"))
        return { data: null, error: { code: "XX000", message: "fault" } };
      const hit = rows.filter(match);
      if (calls.some((c) => c[0] === "maybeSingle"))
        return { data: hit[0] ? pick(hit[0]) : null, error: null };
      return { data: hit.map(pick), error: null };
    } catch (err) {
      return { data: null, error: { code: err.code ?? "23514", message: err.message } };
    }
  });

  service.storage = {
    from() {
      return {
        async upload(path, bytes, opts = {}) {
          if (takeFault("storage", "upload")) return { data: null, error: { message: "fault" } };
          if (uploadsBeforeFault !== null) {
            if (uploadsBeforeFault === 0) {
              uploadsBeforeFault = null;
              return { data: null, error: { message: "fault" } };
            }
            uploadsBeforeFault -= 1;
          }
          if (objects.has(path) && !opts.upsert)
            return { data: null, error: { message: "exists" } };
          objects.set(path, {
            bytes: Uint8Array.from(bytes),
            contentType: opts.contentType,
            createdAt: Date.now(),
          });
          counts.uploads += 1;
          return { data: { path }, error: null };
        },
        async list(prefix, { limit = 100, offset = 0, search = "" } = {}) {
          const entries = [];
          if (prefix === "") {
            const folders = [...new Set([...objects.keys()].map((k) => k.split("/")[0]))].sort();
            for (const f of folders) entries.push({ name: f, id: null, created_at: null });
          } else {
            for (const [k, o] of objects) {
              if (k.startsWith(`${prefix}/${search}`)) {
                entries.push({
                  name: k.slice(prefix.length + 1),
                  id: k,
                  metadata: { size: o.bytes.length, mimetype: o.contentType ?? null },
                  created_at: new Date(o.createdAt).toISOString(),
                });
              }
            }
            entries.sort((a, b) => (a.name < b.name ? -1 : 1));
          }
          return { data: entries.slice(offset, offset + limit), error: null };
        },
        /** A signed upload URL that carries its path and whether it may overwrite (upsert). */
        async createSignedUploadUrl(path, opts = {}) {
          signedUploads.push({ path, upsert: opts.upsert === true });
          return {
            data: {
              signedUrl: `https://storage.test/upload/${path}?upsert=${opts.upsert === true}`,
              path,
            },
            error: null,
          };
        },
        async createSignedUrl(path, ttl) {
          if (!objects.has(path)) return { data: null, error: { message: "not found" } };
          return {
            data: { signedUrl: `https://storage.test/signed/${path}?ttl=${ttl}` },
            error: null,
          };
        },
        async download(path) {
          if (takeFault("storage", "download")) return { data: null, error: { message: "fault" } };
          const o = objects.get(path);
          if (!o) return { data: null, error: { message: "not found" } };
          return { data: new Blob([o.bytes]), error: null };
        },
        async remove(paths) {
          const gone = [];
          for (const p of paths) {
            if (keepOnce.has(p)) {
              keepOnce.delete(p);
              continue;
            }
            if (objects.delete(p)) gone.push({ name: p });
          }
          return { data: gone, error: null };
        },
      };
    },
  };

  return {
    service,
    tables,
    objects,
    counts,
    signedUploads,
    /** Upload through a URL from createSignedUploadUrl, as the browser does: create-only unless it said upsert. */
    async putSigned(url, bytes, contentType) {
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname.replace(/^\/upload\//, ""));
      return service.storage.from("interview-videos").upload(path, bytes, {
        upsert: u.searchParams.get("upsert") === "true",
        contentType,
      });
    },
    failNext(table, op) {
      faults.push({ table, op });
    },
    /** Let `n` uploads through, then fail the next one, once. */
    failUploadAfter(n) {
      uploadsBeforeFault = n;
    },
    failRemove(path) {
      keepOnce.add(path);
    },
    /** Age an object, for the orphan sweep's 24-hour grace. */
    age(path, ms) {
      const o = objects.get(path);
      if (o) o.createdAt -= ms;
    },
  };
}
