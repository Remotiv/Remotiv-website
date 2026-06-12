import { createServiceClient } from "@/lib/supabase/server";
import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { LIST_SELECT, getJobById } from "@/lib/jobs";

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
    const job = await getJobById(idParam);
    if (!job) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(job);
  }

  const category = trimmedParam(searchParams.get("category"));
  const experienceLevels = trimmedParam(searchParams.get("experience_level"));
  const contractTypes = trimmedParam(searchParams.get("contract_type"));
  const language = trimmedParam(searchParams.get("language"));

  const supabase = createServiceClient();

  let query = supabase
    .from("jobs")
    .select(LIST_SELECT)
    .eq("status", "open")
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

  return NextResponse.json(data ?? []);
}
