"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { notifyAllAdmins } from "@/lib/notifications";

// ── Types ────────────────────────────────────────────────────

export type BatchStatus = "active" | "closed" | "archived";

export type ClientBatch = {
  id: string;
  client_id: string;
  client_name: string;
  batch_name: string;
  position_title: string;
  status: BatchStatus;
  candidate_count: number;
  created_at: string;
};

export type SourceType = "application" | "talent";

export type ClientFeedback = {
  decision: "approve" | "reject" | "request_interview" | null;
  comments: string | null;
  submitted_at: string | null;
};

export type BatchCandidate = {
  id: string;
  batch_id: string;
  source_type: SourceType | null;
  source_id: string | null;

  // Snapshot
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  cv_url: string | null;
  location: string | null;
  university: string | null;
  position_applied: string | null;
  total_experience: number | null;
  current_role: string | null;
  current_company: string | null;
  current_salary: string | null;
  salary_expectations: string | null;
  notice_period: string | null;

  // Internal tracking
  interviewer_name: string | null;
  initial_interview_url: string | null;
  loom_video_url: string | null;
  first_interview_url: string | null;
  second_interview_url: string | null;
  note_by_remotiv: string | null;

  // Stage
  stage: string;

  // Client feedback (read-only on admin side)
  client_decision: "approve" | "reject" | "request_interview" | null;
  client_comments: string | null;
  client_decision_at: string | null;

  added_at: string;
  added_by: string | null;
};

export type BatchCandidateInput = {
  source_type: SourceType;
  source_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  linkedin_url?: string | null;
  cv_url?: string | null;
  location?: string | null;
  university?: string | null;
  position_applied?: string | null;
  total_experience?: number | null;
  current_role?: string | null;
  current_company?: string | null;
  current_salary?: string | null;
  salary_expectations?: string | null;
  notice_period?: string | null;
};

export type AvailableCandidate = {
  id: string;
  source_type: SourceType;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  cv_url: string | null;
  location: string | null;
  position_applied: string | null;
  current_role: string | null;
  current_company: string | null;
  education: string | null;
};

export type ActiveClient = {
  id: string;
  company_name: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

// Common SELECT for client_batch_candidates that aliases the reserved
// column name candidate_current_role → current_role so JS code stays clean.
const CANDIDATE_COLUMNS = `
  id, batch_id, source_type, source_id,
  first_name, last_name, email, phone, linkedin_url, cv_url,
  location, university, position_applied, total_experience,
  current_role:candidate_current_role,
  current_company, current_salary, salary_expectations, notice_period,
  interviewer_name, initial_interview_url, loom_video_url,
  first_interview_url, second_interview_url, note_by_remotiv,
  stage, client_decision, client_comments, client_decision_at,
  added_at, added_by
`.replace(/\s+/g, " ").trim();

// ── Reads ────────────────────────────────────────────────────

export async function fetchActiveClients(): Promise<ActiveClient[]> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("clients")
    .select("id, company_name")
    .eq("status", "active")
    .order("company_name", { ascending: true });
  return ((data ?? []) as ActiveClient[]).map((r) => ({
    id: r.id,
    company_name: r.company_name ?? "",
  }));
}

export async function fetchBatches(clientId?: string): Promise<ClientBatch[]> {
  await requireAdmin();
  const supabase = createServiceClient();

  let query = supabase
    .from("client_batches")
    .select(`
      id, client_id, batch_name, position_title, status, created_at,
      client:clients(id, company_name),
      candidates:client_batch_candidates(id)
    `)
    .order("created_at", { ascending: false });

  if (clientId) query = query.eq("client_id", clientId);

  const { data } = await query;

  type Row = {
    id: string;
    client_id: string;
    batch_name: string | null;
    position_title: string | null;
    status: string | null;
    created_at: string | null;
    client: { id: string; company_name: string | null } | null;
    candidates: Array<{ id: string }> | null;
  };

  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    client_id: r.client_id,
    client_name: r.client?.company_name ?? "",
    batch_name: r.batch_name ?? "",
    position_title: r.position_title ?? "",
    status: ((r.status as BatchStatus) ?? "active"),
    candidate_count: Array.isArray(r.candidates) ? r.candidates.length : 0,
    created_at: r.created_at ?? "",
  }));
}

export async function fetchBatchById(batchId: string): Promise<{
  batch: ClientBatch | null;
  candidates: BatchCandidate[];
}> {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data: batchRow } = await supabase
    .from("client_batches")
    .select(`
      id, client_id, batch_name, position_title, status, created_at,
      client:clients(id, company_name)
    `)
    .eq("id", batchId)
    .maybeSingle();

  if (!batchRow) return { batch: null, candidates: [] };

  type B = {
    id: string;
    client_id: string;
    batch_name: string | null;
    position_title: string | null;
    status: string | null;
    created_at: string | null;
    client: { id: string; company_name: string | null } | null;
  };
  const b = batchRow as unknown as B;

  const { data: candData, error: candErr } = await supabase
    .from("client_batch_candidates")
    .select(CANDIDATE_COLUMNS)
    .eq("batch_id", batchId)
    .order("added_at", { ascending: true });

  if (candErr) {
    // Surface PostgREST errors instead of silently returning an empty list
    // — this is what hid the previous client_submitted_at / created_at
    // column-name mismatches.
    console.error("[fetchBatchById] candidate query error:", candErr);
  }

  const candidates = ((candData ?? []) as unknown as BatchCandidate[]).map((c) => ({
    ...c,
    stage: c.stage ?? "-",
    total_experience: typeof c.total_experience === "number" ? c.total_experience : null,
  }));

  // Compute candidate count from the actual fetched rows.
  const batch: ClientBatch = {
    id: b.id,
    client_id: b.client_id,
    client_name: b.client?.company_name ?? "",
    batch_name: b.batch_name ?? "",
    position_title: b.position_title ?? "",
    status: ((b.status as BatchStatus) ?? "active"),
    candidate_count: candidates.length,
    created_at: b.created_at ?? "",
  };

  return { batch, candidates };
}

export async function fetchAvailableCandidates(
  searchQuery?: string,
  sourceType?: SourceType,
): Promise<AvailableCandidate[]> {
  await requireAdmin();
  const supabase = createServiceClient();

  const q = (searchQuery ?? "").trim();
  const results: AvailableCandidate[] = [];

  if (sourceType !== "talent") {
    let appQ = supabase
      .from("job_applications")
      .select("id, first_name, last_name, email, phone, linkedin_url, cv_url, jobs(title)")
      .order("created_at", { ascending: false })
      .limit(50);
    if (q) {
      appQ = appQ.or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`,
      );
    }
    const { data: apps } = await appQ;

    type AppRow = {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      linkedin_url: string | null;
      cv_url: string | null;
      jobs: { title: string | null } | null;
    };

    for (const r of (apps ?? []) as unknown as AppRow[]) {
      results.push({
        id: r.id,
        source_type: "application",
        first_name: r.first_name ?? "",
        last_name: r.last_name ?? "",
        email: r.email ?? "",
        phone: r.phone,
        linkedin_url: r.linkedin_url,
        cv_url: r.cv_url,
        location: null,
        position_applied: r.jobs?.title ?? null,
        current_role: null,
        current_company: null,
        education: null,
      });
    }
  }

  if (sourceType !== "application") {
    let tQ = supabase
      .from("talent_profiles")
      .select(
        "id, first_name, last_name, email, phone, linkedin_url, cv_url, city, country, job_title, industry, summary, degree, institution, experience",
      )
      .not("approved_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (q) {
      tQ = tQ.or(
        `first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`,
      );
    }
    const { data: talents } = await tQ;

    type TRow = {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      linkedin_url: string | null;
      cv_url: string | null;
      city: string | null;
      country: string | null;
      job_title: string | null;
      industry: string | null;
      summary: string | null;
      degree: string | null;
      institution: string | null;
      experience: Array<{ title?: string; company?: string }> | null;
    };

    for (const r of (talents ?? []) as unknown as TRow[]) {
      const latest = Array.isArray(r.experience) ? r.experience[0] : null;
      results.push({
        id: r.id,
        source_type: "talent",
        first_name: r.first_name ?? "",
        last_name: r.last_name ?? "",
        email: r.email ?? "",
        phone: r.phone,
        linkedin_url: r.linkedin_url,
        cv_url: r.cv_url,
        location: [r.city, r.country].filter(Boolean).join(", ") || null,
        position_applied: r.job_title,
        current_role: latest?.title ?? r.job_title,
        current_company: latest?.company ?? null,
        education: [r.degree, r.institution].filter(Boolean).join(" — ") || null,
      });
    }
  }

  return results;
}

// ── Mutations ────────────────────────────────────────────────

export async function createBatch(input: {
  client_id: string;
  batch_name: string;
  position_title: string;
}): Promise<MutationResult<{ id: string }>> {
  await requireAdmin();

  const client_id = input.client_id?.trim() ?? "";
  const batch_name = input.batch_name?.trim() ?? "";
  const position_title = input.position_title?.trim() ?? "";

  if (!client_id) return { success: false, error: "Client is required." };
  if (!batch_name) return { success: false, error: "Batch name is required." };
  if (!position_title) return { success: false, error: "Position title is required." };

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("client_batches")
    .insert({ client_id, batch_name, position_title, status: "active" })
    .select("id")
    .single();

  if (error || !data) {
    return { success: false, error: error?.message ?? "Failed to create batch." };
  }

  revalidatePath("/admin/client-batches");
  return { success: true, data: { id: (data as { id: string }).id } };
}

export async function updateBatch(
  id: string,
  updates: { batch_name?: string; position_title?: string; status?: BatchStatus },
): Promise<MutationResult<undefined>> {
  await requireAdmin();

  const patch: Record<string, unknown> = {};
  if (typeof updates.batch_name === "string") patch.batch_name = updates.batch_name.trim();
  if (typeof updates.position_title === "string") patch.position_title = updates.position_title.trim();
  if (updates.status) patch.status = updates.status;
  if (Object.keys(patch).length === 0) return { success: true, data: undefined };

  const supabase = createServiceClient();
  const { error } = await supabase.from("client_batches").update(patch).eq("id", id);
  if (error) return { success: false, error: error.message };

  revalidatePath("/admin/client-batches");
  revalidatePath(`/admin/client-batches/${id}`);
  return { success: true, data: undefined };
}

export async function deleteBatch(id: string): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase.from("client_batches").delete().eq("id", id);
  if (error) return { success: false, error: error.message };

  revalidatePath("/admin/client-batches");
  return { success: true, data: undefined };
}

export async function addCandidateToBatch(
  batchId: string,
  candidate: BatchCandidateInput,
): Promise<MutationResult<{ id: string }>> {
  await requireAdmin();

  if (!candidate.first_name?.trim() || !candidate.email?.trim()) {
    return { success: false, error: "First name and email are required." };
  }

  const supabase = createServiceClient();

  // Duplicate-prevention removed per spec — same candidate may now appear in
  // multiple batches AND multiple times within the same batch.
  const { data, error } = await supabase
    .from("client_batch_candidates")
    .insert({
      batch_id: batchId,
      source_type: candidate.source_type,
      source_id: candidate.source_id,
      first_name: candidate.first_name.trim(),
      last_name: (candidate.last_name ?? "").trim(),
      email: candidate.email.trim().toLowerCase(),
      phone: candidate.phone ?? null,
      linkedin_url: candidate.linkedin_url ?? null,
      cv_url: candidate.cv_url ?? null,
      location: candidate.location ?? null,
      university: candidate.university ?? null,
      position_applied: candidate.position_applied ?? null,
      total_experience: candidate.total_experience ?? null,
      candidate_current_role: candidate.current_role ?? null,
      current_company: candidate.current_company ?? null,
      current_salary: candidate.current_salary ?? null,
      salary_expectations: candidate.salary_expectations ?? null,
      notice_period: candidate.notice_period ?? null,
      stage: "-",
    })
    .select("id")
    .single();

  if (error || !data) {
    return { success: false, error: error?.message ?? "Failed to add candidate." };
  }

  // Bell notification for the rest of the admin team — fire-and-forget.
  const candidateName =
    `${candidate.first_name?.trim() ?? ""} ${candidate.last_name?.trim() ?? ""}`.trim() ||
    "A candidate";

  const { data: batchInfo } = await supabase
    .from("client_batches")
    .select("batch_name, position_title, client:clients(company_name)")
    .eq("id", batchId)
    .maybeSingle();

  type BatchInfoRow = {
    batch_name: string | null;
    position_title: string | null;
    client: { company_name: string | null } | null;
  };
  const info = batchInfo as unknown as BatchInfoRow | null;
  const batchName = info?.batch_name ?? "batch";
  const clientName = info?.client?.company_name ?? "a client";

  // Fire-and-forget — don't block the admin's response on the broadcast.
  notifyAllAdmins({
    event_type: "candidate_added",
    title: `${candidateName} added to batch`,
    message: `Added to "${batchName}" for ${clientName}`,
    link: `/admin/client-batches/${batchId}`,
    metadata: {
      candidate_id: (data as { id: string }).id,
      batch_id: batchId,
    },
  }).catch((err) => {
    console.error("[addBatchCandidate] notifyAllAdmins failed:", err);
  });

  revalidatePath(`/admin/client-batches/${batchId}`);
  revalidatePath("/admin/client-batches");
  return { success: true, data: { id: (data as { id: string }).id } };
}

export async function updateBatchCandidate(
  candidateId: string,
  updates: Partial<{
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    linkedin_url: string;
    cv_url: string;
    location: string;
    university: string;
    position_applied: string;
    total_experience: number | null;
    current_role: string;
    current_company: string;
    current_salary: string;
    salary_expectations: string;
    notice_period: string;
    interviewer_name: string;
    initial_interview_url: string;
    loom_video_url: string;
    first_interview_url: string;
    second_interview_url: string;
    note_by_remotiv: string;
    stage: string;
  }>,
): Promise<MutationResult<undefined>> {
  await requireAdmin();

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    // Map JS-side current_role onto the actual DB column name.
    if (key === "current_role") {
      patch.candidate_current_role = typeof value === "string" ? value.trim() : value;
    } else if (typeof value === "string") {
      patch[key] = value.trim();
    } else {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length === 0) return { success: true, data: undefined };

  const supabase = createServiceClient();

  // We need the batch_id to revalidate the right path.
  const { data: row } = await supabase
    .from("client_batch_candidates")
    .select("batch_id")
    .eq("id", candidateId)
    .maybeSingle();

  const { error } = await supabase
    .from("client_batch_candidates")
    .update(patch)
    .eq("id", candidateId);

  if (error) return { success: false, error: error.message };

  const batchId = (row as { batch_id: string } | null)?.batch_id;
  if (batchId) revalidatePath(`/admin/client-batches/${batchId}`);
  return { success: true, data: undefined };
}

export async function removeCandidateFromBatch(
  candidateId: string,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data: row } = await supabase
    .from("client_batch_candidates")
    .select("batch_id")
    .eq("id", candidateId)
    .maybeSingle();

  const { error } = await supabase
    .from("client_batch_candidates")
    .delete()
    .eq("id", candidateId);

  if (error) return { success: false, error: error.message };

  const batchId = (row as { batch_id: string } | null)?.batch_id;
  if (batchId) revalidatePath(`/admin/client-batches/${batchId}`);
  revalidatePath("/admin/client-batches");
  return { success: true, data: undefined };
}

// ── Candidate notes (admin-side reads + replies) ─────────────

export type AdminCandidateNote = {
  id: string;
  candidate_id: string;
  author_type: "client" | "admin";
  author_name: string | null;
  note_text: string;
  created_at: string;
};

export async function fetchAdminCandidateNotes(
  candidateId: string,
): Promise<AdminCandidateNote[]> {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("candidate_notes")
    .select("id, candidate_id, author_type, author_name, note_text, created_at")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: true });

  return (data ?? []) as AdminCandidateNote[];
}

export async function addAdminCandidateNote(
  candidateId: string,
  noteText: string,
): Promise<MutationResult<AdminCandidateNote>> {
  await requireAdmin();
  const trimmed = noteText.trim();
  if (!trimmed) return { success: false, error: "Note cannot be empty" };

  // Resolve the admin's auth user for attribution. requireAdmin() doesn't
  // return one and we want the note linked to auth.users.id for audit.
  const auth = await createAuthClient();
  const { data: { user } } = await auth.auth.getUser();

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("candidate_notes")
    .insert({
      candidate_id: candidateId,
      author_type: "admin",
      author_id: user?.id ?? null,
      author_name: "Remotiv Team",
      note_text: trimmed,
    })
    .select("id, candidate_id, author_type, author_name, note_text, created_at")
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as AdminCandidateNote };
}
