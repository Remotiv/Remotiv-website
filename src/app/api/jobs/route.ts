import { createServiceClient } from "@/lib/supabase/server";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const category = searchParams.get("category");
  const experienceLevels = searchParams.get("experience_level");
  const contractTypes = searchParams.get("contract_type");
  const language = searchParams.get("language");

  const supabase = createServiceClient();

  let query = supabase
    .from("jobs")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  if (experienceLevels) {
    const levels = experienceLevels.split(",").map((s) => s.trim());
    query = query.in("experience_level", levels);
  }

  if (contractTypes) {
    const types = contractTypes.split(",").map((s) => s.trim());
    query = query.in("contract_type", types);
  }

  if (language) {
    query = query.eq("language", language);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
