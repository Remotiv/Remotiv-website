import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ForgotPasswordClient from "./forgot-password-client";

export const dynamic = "force-dynamic";

type SearchParamsPromise = Promise<{ error?: string }>;

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParamsPromise }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    redirect("/browse-talent");
  }
  const params = await searchParams;
  return <ForgotPasswordClient errorParam={params.error} />;
}
