import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { touchLastActiveForUser } from "@/lib/talent-activity";

// Route-segment layout. Wraps only the (authed) group — /talent/login is a
// sibling under /talent/ and is NOT gated by this layout.
export default async function TalentDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/talent/login?reason=unauthorized");
  }

  /*
   * "Signed in" for retention purposes.
   *
   * Here rather than on verifyOtp because a returning visitor with a live
   * session is active by any reading — requiring a fresh sign-in would let
   * someone who uses the dashboard weekly still expire. Matched by user_id, so
   * it can only ever touch the caller's own row.
   *
   * Fire-and-forget; see touchLastActive.
   */
  void touchLastActiveForUser(user.id);

  return <>{children}</>;
}
