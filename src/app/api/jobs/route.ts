import { createServiceClient } from "@/lib/supabase/server";
import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { LIST_SELECT, listedOnRemotiv, publicJobSummaries } from "@/lib/jobs";

// JOB-001 / F7: public-API projection. This route is unauthenticated, and it
// answers exactly the summary keep-list (PUBLIC_JOB_SUMMARY_FIELDS in
// lib/jobs.ts) plus the two company facts, whoever asks: it reads no session.
//
// There is no single-job branch. `?id=` served the board's old detail panel,
// which job pages replaced, and it answered with the whole row minus four
// names. Any request carrying `id` is a 404, never the list.

// Cap each filter's raw query-string segment so a 50 KB ?category= can't
// pad the payload or stall the comma-split into a giant array.
const MAX_PARAM_LENGTH = 200;

function trimmedParam(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.slice(0, MAX_PARAM_LENGTH);
}

export async function GET(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "jobs" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const { searchParams } = request.nextUrl;

  if (searchParams.has("id")) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const category = trimmedParam(searchParams.get("category"));
  const experienceLevels = trimmedParam(searchParams.get("experience_level"));
  const contractTypes = trimmedParam(searchParams.get("contract_type"));
  const language = trimmedParam(searchParams.get("language"));

  const supabase = createServiceClient();

  // Mirrors getInitialJobs. The client refetches through here on every
  // filter change, so an archived job omitted from the SSR list would walk
  // straight back in on the first keystroke without the shared predicate.
  let query = listedOnRemotiv(supabase.from("jobs").select(LIST_SELECT))
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (category) {
    query = query.eq("category", category);
  }

  if (experienceLevels) {
    const levels = experienceLevels.split(",").map((s) => s.trim()).filter(Boolean);
    if (levels.length > 0) query = query.in("experience_level", levels);
  }

  if (contractTypes) {
    const types = contractTypes.split(",").map((s) => s.trim()).filter(Boolean);
    if (types.length > 0) query = query.in("contract_type", types);
  }

  if (language) {
    query = query.eq("language", language);
  }

  const { data, error } = await query;

  if (error) {
    // Log the real Supabase error server-side; return a generic message so
    // schema/constraint details aren't reconnaissance-leaked over the public API.
    console.error("[jobs]", error);
    return NextResponse.json(
      { error: "Couldn't load jobs. Please try again." },
      { status: 500 },
    );
  }

  // Same projection and enrichment as the SSR list, so a card keeps its logo
  // across a refetch instead of flipping back to the letter on the first filter
  // change. company_id stays (_jobs-client.tsx re-applies ?company= with it),
  // and company_is_internal rides along: the list's star gates on
  // isRemotivOwned, which reads BOTH.
  return NextResponse.json(
    await publicJobSummaries((data ?? []) as unknown as Record<string, unknown>[]),
  );
}
