"use server";

import { createClient } from "@/lib/supabase/server";

type ContactInput = {
  name: string;
  email: string;
  company: string;
  service: string;
  message: string;
};

type Result = { success: true } | { success: false; error: string };

export async function submitContact(data: ContactInput): Promise<Result> {
  console.log("[submitContact] env check:", {
    hasUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });

  const supabase = await createClient();

  const { error } = await supabase.from("contact_submissions").insert({
    name: data.name,
    email: data.email,
    company: data.company || null,
    service: data.service || null,
    message: data.message,
  });

  if (error) {
    console.error("[submitContact] Supabase error:", error);
    return { success: false, error: error.message };
  }
  return { success: true };
}
