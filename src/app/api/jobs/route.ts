import { createServiceClient } from "@/lib/supabase/server";
import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import {
  attachCompanyData,
  LIST_SELECT,
  getJobById,
  listedOnRemotiv,
  type Job,
  type ScreeningQuestion,
} from "@/lib/jobs";

// JOB-001 — public-API projection. This route is unauthenticated, so nothing
// it returns may include screening_questions[].ideal (the employer's pass
// answers) or the internal created_by / client_id identifiers.
//
// The question keep-list duplicates toPublicJob in
// src/app/jobs/[slug]/page.tsx — deliberately, since lib/jobs.ts is frozen for
// this fix. Follow-up: hoist one shared projection when lib/jobs.ts is next
// open. `essential` stays (the apply modal renders its badge); numeric_mode is
// dropped (no client reads it, and it hints at scoring direction).
function toPublicQuestion(q: ScreeningQuestion) {
  return {
    id: q.id,
    question: q.question,
    type: q.type,
    options: q.options,
    essential: q.essential,
  };
}

// Full-row variant for the single-job branch. Keeps description and the other
// detail columns (that lazy-description load is this branch's documented
// purpose) and drops company_id too — unlike the list branch, where
// company_id is load-bearing for _jobs-client.tsx's company-scope filter.
function toPublicDetailJob(job: Job) {
  const { client_id, created_by, company_id, screening_questions, ...rest } =
    job;
  return {
    ...rest,
    screening_questions: (screening_questions ?? []).map(toPublicQuestion),
  };
}

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

  // Single-job fetch branch — used by the /jobs detail panel for the lazy
  // description load. Bypasses the list query and delegates to lib/jobs.
  const idParam = searchParams.get("id");
  if (idParam !== null) {
    const read = await getJobById(idParam);
    // 503, not 404: the caller is the /jobs detail panel, and telling it the
    // role is gone when the lookup merely failed makes it render "not found"
    // over a role that is still live. A 503 is retryable and says so.
    if (!read.ok) {
      return NextResponse.json({ error: "Unavailable." }, { status: 503 });
    }
    if (!read.value) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(toPublicDetailJob(read.value));
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

  // Same enrichment the SSR list uses, so a card keeps its logo across a
  // refetch instead of flipping back to the letter on the first filter change.
  const rows = await attachCompanyData(
    (data ?? []) as {
      company_id: string | null;
      client_id: string | null;
      created_by: string | null;
    }[],
  );

  // LIST_SELECT (shared with the SSR list, out of scope here) still selects
  // client_id and created_by; strip them before the response. company_id stays
  // — _jobs-client.tsx re-applies the /jobs?company= scope with it.
  //
  // company_is_internal, derived by attachCompanyData above, rides along too.
  // The list's star gates on isRemotivOwned, which reads BOTH: a job with no
  // company, or one whose company is Remotiv's own account. Dropping either
  // from this payload puts the star back to disagreeing with the detail page.
  return NextResponse.json(
    rows.map(({ client_id, created_by, ...row }) => row),
  );
}
