import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SigninClient from "./signin-client";

export const dynamic = "force-dynamic";

type SearchParamsPromise = Promise<{ error?: string; next?: string }>;

export default async function SigninPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    redirect("/browse-talent");
  }
  const params = await searchParams;
  return <SigninClient errorParam={params.error} nextParam={params.next} />;
}
