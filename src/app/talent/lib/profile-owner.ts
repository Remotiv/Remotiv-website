import "server-only";

import { createClient, createServiceClient } from "@/lib/supabase/server";

export type SourceTable = "talent_profiles" | "hire_remote_profiles";

export async function requireProfileOwner(
  profileId: string,
  sourceTable: SourceTable,
): Promise<{ userId: string; email: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    throw new Error("not_authenticated");
  }

  const service = createServiceClient();
  const { data: row, error } = await service
    .from(sourceTable)
    .select("user_id")
    .eq("id", profileId)
    .maybeSingle();

  if (error || !row) {
    throw new Error("not_owner");
  }

  const ownerId = (row as { user_id: string | null }).user_id;
  if (!ownerId || ownerId !== user.id) {
    throw new Error("not_owner");
  }

  return { userId: user.id, email: user.email };
}

export async function getProfileOwnerOrNull(
  profileId: string,
  sourceTable: SourceTable,
): Promise<{ userId: string; email: string } | null> {
  try {
    return await requireProfileOwner(profileId, sourceTable);
  } catch {
    return null;
  }
}
