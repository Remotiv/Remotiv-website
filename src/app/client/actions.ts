"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { BATCH_STAGES } from "@/app/admin/_components/batch-stages";
import { SUPER_ADMIN_EMAIL, type UserRole } from "@/app/admin/lib/roles";
import { notifyAllAdmins } from "@/lib/notifications";

// ── Types ────────────────────────────────────────────────────

export type ClientRow = {
  id: string;
  user_id: string | null;
  company_name: string;
  contact_name: string | null;
  email: string;
  status: "active" | "paused" | "archived";
  created_at: string;
};

export type ClientBatchSummary = {
  id: string;
  batch_name: string;
  position_title: string;
  status: "active" | "closed" | "archived";
  total_count: number;
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  interview_count: number;
  created_at: string;
  /** Populated only in admin preview (cross-client list). */
  client_name?: string;
};

export type ClientCandidate = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  cv_url: string | null;
  cv_path: string | null;
  location: string | null;
  university: string | null;
  position_applied: string | null;
  total_experience: number | null;
  current_role: string | null;
  current_company: string | null;
  current_salary: string | null;
  salary_expectations: string | null;
  notice_period: string | null;
  initial_interview_url: string | null;
  loom_video_url: string | null;
  first_interview_url: string | null;
  second_interview_url: string | null;
  note_by_remotiv: string | null;
  stage: string;
  client_decision: "approve" | "reject" | "request_interview" | null;
  client_comments: string | null;
  client_decision_at: string | null;
  added_at: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

// Same SELECT alias used by /admin actions — keeps the reserved-word workaround
// for candidate_current_role transparent on the client side.
const CLIENT_CANDIDATE_COLUMNS = `
  id, first_name, last_name, email, phone, linkedin_url, cv_url, cv_path,
  location, university, position_applied, total_experience,
  current_role:candidate_current_role,
  current_company, current_salary, salary_expectations, notice_period,
  initial_interview_url, loom_video_url,
  first_interview_url, second_interview_url, note_by_remotiv,
  stage, client_decision, client_comments, client_decision_at,
  added_at
`.replace(/\s+/g, " ").trim();

// ── Auth gate — every public function below routes through this ────

/** Resolve the current client row, or throw if the session isn't a client. */
export async function getCurrentClient(): Promise<ClientRow> {
  const auth = await createAuthClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const service = createServiceClient();
  const { data: row } = await service
    .from("clients")
    .select("id, user_id, company_name, contact_name, email, status, created_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!row) throw new Error("Not a client account");
  const client = row as ClientRow;
  if (client.status !== "active") throw new Error(`Client status: ${client.status}`);
  return client;
}

/**
 * Is the current session a super_admin or admin? Used by /client/* pages
 * to allow read-only preview of any client's batch.
 */
export async function isAdminUser(): Promise<boolean> {
  const auth = await createAuthClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return false;

  if (user.email === SUPER_ADMIN_EMAIL) return true;

  const service = createServiceClient();
  const { data: roleRow } = await service
    .from("admin_users")
    .select("role, status")
    .eq("user_id", user.id)
    .maybeSingle();

  type AdminRow = { role: UserRole | null; status: string | null };
  const r = roleRow as AdminRow | null;
  if (!r || !r.role) return false;
  // Mirror the admin-layout gate — paused/archived admins lose preview access.
  if (r.status && r.status !== "active") return false;
  return r.role === "super_admin" || r.role === "admin";
}

export type ClientOrAdminCtx =
  | { type: "admin"; user: { id: string; email: string } }
  | { type: "client"; client: ClientRow }
  | { type: "none" };

/**
 * Resolve who's accessing the /client portal. Admin users get read-only
 * preview access; active clients get their normal scope; everyone else
 * resolves to "none" so the caller can redirect to /client/login.
 */
export async function getCurrentClientOrAdmin(): Promise<ClientOrAdminCtx> {
  const auth = await createAuthClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return { type: "none" };

  if (await isAdminUser()) {
    return { type: "admin", user: { id: user.id, email: user.email ?? "" } };
  }

  const service = createServiceClient();
  const { data: row } = await service
    .from("clients")
    .select("id, user_id, company_name, contact_name, email, status, created_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!row) return { type: "none" };
  const client = row as ClientRow;
  if (client.status !== "active") return { type: "none" };
  return { type: "client", client };
}

// ── Reads ────────────────────────────────────────────────────

export async function fetchClientBatches(): Promise<ClientBatchSummary[]> {
  const client = await getCurrentClient();
  const service = createServiceClient();

  const { data: batches } = await service
    .from("client_batches")
    .select(`
      id, batch_name, position_title, status, created_at,
      candidates:client_batch_candidates(id, client_decision)
    `)
    .eq("client_id", client.id)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  type BatchRow = {
    id: string;
    batch_name: string | null;
    position_title: string | null;
    status: string | null;
    created_at: string | null;
    candidates: Array<{ id: string; client_decision: string | null }> | null;
  };

  return ((batches ?? []) as unknown as BatchRow[]).map((b) => {
    const cands = Array.isArray(b.candidates) ? b.candidates : [];
    return {
      id: b.id,
      batch_name: b.batch_name ?? "",
      position_title: b.position_title ?? "",
      status: ((b.status as ClientBatchSummary["status"]) ?? "active"),
      total_count: cands.length,
      pending_count: cands.filter((c) => !c.client_decision).length,
      approved_count: cands.filter((c) => c.client_decision === "approve").length,
      rejected_count: cands.filter((c) => c.client_decision === "reject").length,
      interview_count: cands.filter((c) => c.client_decision === "request_interview").length,
      created_at: b.created_at ?? "",
    };
  });
}

/** Admin-mode list of every batch across every client, for read-only preview. */
export async function fetchAllBatchesForAdmin(): Promise<ClientBatchSummary[]> {
  if (!(await isAdminUser())) return [];
  const service = createServiceClient();

  const { data: batches } = await service
    .from("client_batches")
    .select(`
      id, batch_name, position_title, status, created_at,
      client:clients(id, company_name),
      candidates:client_batch_candidates(id, client_decision)
    `)
    .order("created_at", { ascending: false });

  type BatchRow = {
    id: string;
    batch_name: string | null;
    position_title: string | null;
    status: string | null;
    created_at: string | null;
    client: { id: string; company_name: string | null } | null;
    candidates: Array<{ id: string; client_decision: string | null }> | null;
  };

  return ((batches ?? []) as unknown as BatchRow[]).map((b) => {
    const cands = Array.isArray(b.candidates) ? b.candidates : [];
    return {
      id: b.id,
      batch_name: b.batch_name ?? "",
      position_title: b.position_title ?? "",
      status: ((b.status as ClientBatchSummary["status"]) ?? "active"),
      total_count: cands.length,
      pending_count: cands.filter((c) => !c.client_decision).length,
      approved_count: cands.filter((c) => c.client_decision === "approve").length,
      rejected_count: cands.filter((c) => c.client_decision === "reject").length,
      interview_count: cands.filter((c) => c.client_decision === "request_interview").length,
      created_at: b.created_at ?? "",
      client_name: b.client?.company_name ?? "",
    };
  });
}

/** Admin-mode batch detail — fetches any batch by id, no ownership check. */
export async function fetchBatchForAdmin(batchId: string): Promise<{
  batch: { id: string; batch_name: string; position_title: string; status: string; created_at: string; client_name: string } | null;
  candidates: ClientCandidate[];
}> {
  if (!(await isAdminUser())) return { batch: null, candidates: [] };
  const service = createServiceClient();

  const { data: batchRow } = await service
    .from("client_batches")
    .select(`
      id, batch_name, position_title, status, created_at,
      client:clients(id, company_name)
    `)
    .eq("id", batchId)
    .maybeSingle();

  if (!batchRow) return { batch: null, candidates: [] };
  const b = batchRow as unknown as {
    id: string;
    batch_name: string | null;
    position_title: string | null;
    status: string | null;
    created_at: string | null;
    client: { id: string; company_name: string | null } | null;
  };

  const { data: candData } = await service
    .from("client_batch_candidates")
    .select(CLIENT_CANDIDATE_COLUMNS)
    .eq("batch_id", batchId)
    .order("added_at", { ascending: true });

  const candidates = ((candData ?? []) as unknown as ClientCandidate[]).map((c) => ({
    ...c,
    stage: c.stage ?? "-",
  }));

  return {
    batch: {
      id: b.id,
      batch_name: b.batch_name ?? "",
      position_title: b.position_title ?? "",
      status: b.status ?? "active",
      created_at: b.created_at ?? "",
      client_name: b.client?.company_name ?? "",
    },
    candidates,
  };
}

export async function fetchClientBatchById(batchId: string): Promise<{
  batch: { id: string; batch_name: string; position_title: string; status: string; created_at: string } | null;
  candidates: ClientCandidate[];
}> {
  const client = await getCurrentClient();
  const service = createServiceClient();

  // Verify the batch belongs to this client.
  const { data: batchRow } = await service
    .from("client_batches")
    .select("id, batch_name, position_title, status, client_id, created_at")
    .eq("id", batchId)
    .maybeSingle();

  if (!batchRow) return { batch: null, candidates: [] };

  const b = batchRow as {
    id: string;
    batch_name: string | null;
    position_title: string | null;
    status: string | null;
    client_id: string;
    created_at: string | null;
  };

  if (b.client_id !== client.id) {
    throw new Error("Batch does not belong to this client");
  }

  const { data: candData, error: candErr } = await service
    .from("client_batch_candidates")
    .select(CLIENT_CANDIDATE_COLUMNS)
    .eq("batch_id", batchId)
    .order("added_at", { ascending: true });

  if (candErr) {
    console.error("[fetchClientBatchById] candidate query error:", candErr);
  }

  const candidates = ((candData ?? []) as unknown as ClientCandidate[]).map((c) => ({
    ...c,
    stage: c.stage ?? "-",
  }));

  return {
    batch: {
      id: b.id,
      batch_name: b.batch_name ?? "",
      position_title: b.position_title ?? "",
      status: b.status ?? "active",
      created_at: b.created_at ?? "",
    },
    candidates,
  };
}

// ── Mutations ────────────────────────────────────────────────

export async function saveClientFeedback(
  candidateId: string,
  decision: "approve" | "reject" | "request_interview" | null,
  comments: string,
): Promise<MutationResult<undefined>> {
  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "admin") {
    return { success: false, error: "Admin preview mode — cannot submit feedback" };
  }
  if (ctx.type === "none") {
    return { success: false, error: "Not authenticated" };
  }
  const client = ctx.client;
  const service = createServiceClient();

  // Security check: the candidate must belong to a batch owned by this client.
  const { data: candRow } = await service
    .from("client_batch_candidates")
    .select("id, first_name, last_name, batch_id, batch:client_batches(client_id)")
    .eq("id", candidateId)
    .maybeSingle();

  type CandRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    batch_id: string;
    batch: { client_id: string } | null;
  };
  const cand = candRow as CandRow | null;
  if (!cand || cand.batch?.client_id !== client.id) {
    return { success: false, error: "Candidate not found in your batches." };
  }

  const trimmed = comments.trim();
  const { error } = await service
    .from("client_batch_candidates")
    .update({
      client_decision: decision,
      client_comments: trimmed || null,
      client_decision_at: decision ? new Date().toISOString() : null,
    })
    .eq("id", candidateId);

  if (error) return { success: false, error: error.message };

  // Bell notification to all admins. Fire-and-forget; never blocks success.
  if (decision) {
    const decisionLabels: Record<string, string> = {
      approve: "✅ approved",
      reject: "❌ rejected",
      request_interview: "📞 requested interview for",
    };
    const candidateName =
      `${cand.first_name ?? ""} ${cand.last_name ?? ""}`.trim() || "a candidate";
    const decisionLabel = decisionLabels[decision] ?? decision;

    // Fire-and-forget — don't block the client's response.
    notifyAllAdmins({
      event_type: "client_decision",
      title: `Client ${decisionLabel} ${candidateName}`,
      message: trimmed
        ? `${client.company_name}: "${trimmed.slice(0, 100)}${trimmed.length > 100 ? "…" : ""}"`
        : `${client.company_name} made a decision on this candidate.`,
      link: `/admin/client-batches/${cand.batch_id}`,
      metadata: {
        candidate_id: candidateId,
        decision,
        client_id: client.id,
        client_name: client.company_name,
      },
    }).catch((err) => {
      console.error("[submitClientDecision] notifyAllAdmins failed:", err);
    });
  }

  revalidatePath("/client/dashboard");
  // The dynamic batch route can't be revalidated by literal path here
  // (we don't know the batch id at this scope), so we let the caller
  // router.refresh() instead.
  return { success: true, data: undefined };
}

/**
 * Allow the client to advance/move a candidate's stage in the pipeline.
 * Locked to the same 22-stage vocabulary as the admin side; rejects any
 * candidate that doesn't belong to a batch this client owns.
 */
export async function updateClientStage(
  candidateId: string,
  newStage: string,
): Promise<MutationResult<undefined>> {
  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "admin") {
    return { success: false, error: "Admin preview mode — cannot change stage" };
  }
  if (ctx.type === "none") {
    return { success: false, error: "Not authenticated" };
  }
  const client = ctx.client;
  const service = createServiceClient();

  // Validate stage is one of the canonical values.
  if (!(BATCH_STAGES as readonly string[]).includes(newStage)) {
    return { success: false, error: "Invalid stage" };
  }

  // Security check: candidate must belong to a batch owned by this client.
  const { data: candRow } = await service
    .from("client_batch_candidates")
    .select("id, first_name, last_name, batch_id, batch:client_batches(client_id)")
    .eq("id", candidateId)
    .maybeSingle();

  type CandRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    batch_id: string;
    batch: { client_id: string } | null;
  };
  const cand = candRow as CandRow | null;
  if (!cand || cand.batch?.client_id !== client.id) {
    return { success: false, error: "Not authorized to update this candidate" };
  }

  const { error } = await service
    .from("client_batch_candidates")
    .update({ stage: newStage })
    .eq("id", candidateId);

  if (error) return { success: false, error: error.message };

  const candidateName =
    `${cand.first_name ?? ""} ${cand.last_name ?? ""}`.trim() || "a candidate";
  // Fire-and-forget — don't block the client's response.
  notifyAllAdmins({
    event_type: "stage_change",
    title: `Stage changed for ${candidateName}`,
    message: `${client.company_name} moved candidate to "${newStage}"`,
    link: `/admin/client-batches/${cand.batch_id}`,
    metadata: {
      candidate_id: candidateId,
      new_stage: newStage,
      client_id: client.id,
    },
  }).catch((err) => {
    console.error("[updateClientStage] notifyAllAdmins failed:", err);
  });

  revalidatePath("/client/dashboard");
  return { success: true, data: undefined };
}

// ── Candidate notes (chat-style thread shared with admins) ───

export type CandidateNote = {
  id: string;
  candidate_id: string;
  author_type: "client" | "admin";
  author_name: string | null;
  note_text: string;
  created_at: string;
};

/**
 * Fetch the full notes thread for a candidate. Clients are gated by ownership
 * (their candidate must belong to a batch they own); admins bypass the
 * ownership gate so they can read any thread in preview mode.
 */
export async function fetchCandidateNotes(
  candidateId: string,
): Promise<MutationResult<CandidateNote[]>> {
  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "none") {
    return { success: false, error: "Not authenticated" };
  }
  const service = createServiceClient();

  if (ctx.type === "client") {
    // Ownership gate — the candidate must belong to a batch this client owns.
    const { data: candRow } = await service
      .from("client_batch_candidates")
      .select("id, batch:client_batches(client_id)")
      .eq("id", candidateId)
      .maybeSingle();

    type CandRow = { id: string; batch: { client_id: string } | null };
    const cand = candRow as CandRow | null;
    if (!cand || cand.batch?.client_id !== ctx.client.id) {
      return { success: false, error: "Not authorized" };
    }
  }

  const { data, error } = await service
    .from("candidate_notes")
    .select("id, candidate_id, author_type, author_name, note_text, created_at")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as CandidateNote[] };
}

/** Append a new note to a candidate's thread. Author is always 'client'. */
export async function addCandidateNote(
  candidateId: string,
  noteText: string,
): Promise<MutationResult<CandidateNote>> {
  const trimmed = noteText.trim();
  if (!trimmed) return { success: false, error: "Note cannot be empty" };

  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "admin") {
    return { success: false, error: "Admin preview mode — use the admin drawer's reply field to post" };
  }
  if (ctx.type === "none") {
    return { success: false, error: "Not authenticated" };
  }
  const client = ctx.client;
  const service = createServiceClient();

  const { data: candRow } = await service
    .from("client_batch_candidates")
    .select("id, first_name, last_name, batch_id, batch:client_batches(client_id)")
    .eq("id", candidateId)
    .maybeSingle();

  type CandRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    batch_id: string;
    batch: { client_id: string } | null;
  };
  const cand = candRow as CandRow | null;
  if (!cand || cand.batch?.client_id !== client.id) {
    return { success: false, error: "Not authorized" };
  }

  const { data, error } = await service
    .from("candidate_notes")
    .insert({
      candidate_id: candidateId,
      author_type: "client",
      author_id: client.user_id,
      author_name: client.contact_name || client.company_name,
      note_text: trimmed,
    })
    .select("id, candidate_id, author_type, author_name, note_text, created_at")
    .single();

  if (error) return { success: false, error: error.message };

  const candidateName =
    `${cand.first_name ?? ""} ${cand.last_name ?? ""}`.trim() || "a candidate";
  // Fire-and-forget — don't block the client's response.
  notifyAllAdmins({
    event_type: "client_note",
    title: `New note from ${client.company_name}`,
    message: `On ${candidateName}: "${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}"`,
    link: `/admin/client-batches/${cand.batch_id}`,
    metadata: { candidate_id: candidateId, client_id: client.id },
  }).catch((err) => {
    console.error("[submitClientNote] notifyAllAdmins failed:", err);
  });

  return { success: true, data: data as CandidateNote };
}

// ────────────────────────────────────────────────────────────────────────────
// K1 Phase 2: getClientCvSignedUrl
// Returns a fresh 1-hour signed URL for a client_batch_candidates row's CV.
// Auth: must be authenticated AND own the parent batch (client) OR be an admin
// (admin preview). Mirrors the client-or-admin ACL pattern used by
// fetchCandidateNotes / saveClientFeedback in this file.
// ────────────────────────────────────────────────────────────────────────────

type ClientCvSignedUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: "not_authenticated" | "not_authorized" | "cv_missing" | "internal_error" };

const CLIENT_CV_TTL_SECONDS = 60 * 60; // 1 hour

export async function getClientCvSignedUrl(
  batchCandidateId: string,
): Promise<ClientCvSignedUrlResult> {
  if (
    typeof batchCandidateId !== "string" ||
    batchCandidateId.length < 1 ||
    batchCandidateId.length > 100
  ) {
    return { ok: false, error: "internal_error" };
  }

  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "none") {
    return { ok: false, error: "not_authenticated" };
  }

  const service = createServiceClient();

  // Fetch the candidate row + batch ownership in one query for both ACL + cv_path.
  const { data: candidateRow, error: candidateErr } = await service
    .from("client_batch_candidates")
    .select("id, cv_path, cv_url, batch_id, batch:client_batches(client_id)")
    .eq("id", batchCandidateId)
    .maybeSingle();

  type CandRow = {
    id: string;
    cv_path: string | null;
    cv_url: string | null;
    batch_id: string;
    batch: { client_id: string } | null;
  };
  const cand = candidateRow as CandRow | null;
  if (candidateErr || !cand) {
    return { ok: false, error: "cv_missing" };
  }

  // ACL: clients see only candidates in batches they own. Admins bypass (preview mode).
  const isAdmin = ctx.type === "admin";
  if (!isAdmin) {
    if (cand.batch?.client_id !== ctx.client.id) {
      return { ok: false, error: "not_authorized" };
    }
  }

  // Resolve cv_path (prefer cv_path; derive from cv_url for transition safety)
  let cvPath = cand.cv_path;
  if (!cvPath && cand.cv_url) {
    const match = String(cand.cv_url).match(
      /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
    );
    cvPath = match ? match[1] : null;
  }
  if (!cvPath) {
    return { ok: false, error: "cv_missing" };
  }

  const { data: signed, error: signErr } = await service.storage
    .from("cvs")
    .createSignedUrl(cvPath, CLIENT_CV_TTL_SECONDS);

  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: "internal_error" };
  }

  // Audit log (best-effort)
  try {
    const userId = isAdmin ? ctx.user.id : (ctx.client.user_id ?? "");
    if (userId) {
      await service.from("signed_url_logs").insert({
        user_id: userId,
        candidate_id: batchCandidateId,
        source_table: "client_batch_candidates",
        was_admin: isAdmin,
      });
    }
  } catch {
    // Swallow logging failures silently.
  }

  return { ok: true, url: signed.signedUrl };
}

