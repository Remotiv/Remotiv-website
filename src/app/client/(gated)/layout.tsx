import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getClientContext } from "../lib/client-guards";

export default async function GatedClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/client/login");
  }

  // Resolve company + role (client_members → clients fallback) purely to read
  // the password gate. A non-client (e.g. admin preview) throws — swallow it
  // and let the page-level getCurrentClientOrAdmin guard authorize.
  let mustChangePassword = false;
  try {
    mustChangePassword = (await getClientContext()).mustChangePassword;
  } catch {
    // No client membership — admin preview / non-client; page-level guard authorizes.
  }

  if (mustChangePassword) {
    redirect("/client/change-password?forced=true");
  }

  return <>{children}</>;
}
