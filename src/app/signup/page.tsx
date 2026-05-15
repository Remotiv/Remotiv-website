import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignupClient from "./signup-client";

export const dynamic = "force-dynamic";

type SearchParamsPromise = Promise<{ error?: string; next?: string }>;

export default async function SignupPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    redirect("/browse-talent");
  }
  const params = await searchParams;
  return <SignupClient errorParam={params.error} nextParam={params.next} />;
}
