import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { assertServiceClientAllowed } from "./guard";
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component — session refresh handled by middleware
          }
        },
      },
    },
  );
}
export function createServiceClient() {
  // Fails closed in development unless SUPABASE_PROJECT_ENV=development or the
  // explicit override is set. See ./guard.ts for the table of outcomes. Runs
  // before the key is read so a refused process never even touches it.
  assertServiceClientAllowed();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: { getAll: () => [], setAll: () => {} },
    },
  );
}

/**
 * The anon key with NO cookies: an auth call on it (a password check, an email
 * code) never sets or reads the browser's session. Its session, if any, lives
 * in this object only and is gone when the request ends.
 */
export function createStatelessClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: { getAll: () => [], setAll: () => {} },
    },
  );
}
