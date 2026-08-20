"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  type CalendarConnectionView,
  disconnect,
  listConnectionsForMember,
} from "@/lib/calendar/connections";
import "@/lib/calendar/google";
import type { CalendarProviderId } from "@/lib/calendar/provider";

/**
 * Settings actions for calendar connections.
 *
 * A thin server-action wrapper over src/lib/calendar. Every function here
 * re-derives the caller from their session and scopes to THAT member — a
 * server action is a plain POST endpoint, so an argument naming someone else's
 * member id must never be able to reach the database. None of these takes a
 * member id at all, which is the strongest form of that guarantee.
 *
 * NOTHING here returns a token. `CalendarConnectionView` is a whitelist that
 * carries no credential fields; see connections.ts.
 */

export type DisconnectResult = {
  ok: boolean;
  /**
   * False means the grant may still be listed in the recruiter's Google
   * account even though we have deleted our copy. The card tells them to
   * remove it there — see the note on disconnect() for why the row goes
   * regardless.
   */
  revokedAtProvider: boolean;
  connections: CalendarConnectionView[];
};

/** The current member's connections. Safe to call on every settings render. */
export async function fetchCalendarConnections(): Promise<CalendarConnectionView[]> {
  const ctx = await getCompanyContext();
  return listConnectionsForMember(ctx.memberId);
}

/**
 * Disconnect one provider for the CURRENT member.
 *
 * The provider is validated against the known set rather than passed through:
 * it reaches a `.eq("provider", …)` filter, and accepting an arbitrary string
 * from the client into a query predicate is a habit worth not having.
 */
export async function disconnectCalendar(provider: string): Promise<DisconnectResult> {
  const ctx = await getCompanyContext();

  const known: CalendarProviderId[] = ["google", "microsoft"];
  if (!known.includes(provider as CalendarProviderId)) {
    return {
      ok: false,
      revokedAtProvider: false,
      connections: await listConnectionsForMember(ctx.memberId),
    };
  }

  if (!ctx.memberId) {
    return { ok: false, revokedAtProvider: false, connections: [] };
  }

  const result = await disconnect(ctx.memberId, provider as CalendarProviderId);
  revalidatePath("/ai-dashboard/settings");

  return {
    ok: result.deleted,
    revokedAtProvider: result.revokedAtProvider,
    connections: await listConnectionsForMember(ctx.memberId),
  };
}
