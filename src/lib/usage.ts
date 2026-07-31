import { createServiceClient } from "@/lib/supabase/server";

/**
 * Usage event recording.
 *
 * Writes to `usage_events`, which has RLS enabled with NO policies — reachable
 * only through the service-role client, exactly like background_jobs.
 *
 * Schema (verified against the live table):
 *   id uuid pk · company_id uuid NOT NULL · type text NOT NULL
 *   quantity int default 1 · ref_id uuid null · created_at timestamptz
 *
 * NOTHING calls this yet. Step 4 (AI CV scoring) is the first intended caller;
 * wiring it into existing flows is deliberately out of scope for Step 3.
 */

export type RecordUsageInput = {
  /** Required by the table — usage is always attributed to a company. */
  companyId: string;
  /** Event vocabulary lives in a CHECK constraint on the table. */
  type: string;
  /** Units consumed. Defaults to the column default of 1. */
  quantity?: number;
  /** The row this usage refers to — an application id, a job id, and so on. */
  refId?: string | null;
};

/**
 * Record one usage event. Never throws.
 *
 * The swallow is deliberate, and I do agree with it: this is instrumentation
 * hanging off the side of a user action. If the metering insert fails, the
 * work the user asked for has already happened — refusing to acknowledge it,
 * or surfacing a metering error into their request, trades a real failure for
 * a bookkeeping one. Losing a row here costs a line in a usage report; letting
 * it throw costs the user their action.
 *
 * The caveat worth stating: that reasoning holds because usage is currently
 * reporting-only. The moment it becomes the input to an invoice, silent loss
 * turns into silent under-billing, and swallow-and-log stops being adequate on
 * its own. The fix then is not to make this throw — it is to make the write
 * durable: enqueue the usage event as a background job so it inherits the
 * retry and dead-letter machinery, and reconcile against the source rows
 * periodically. The console.error below is the tripwire until then.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    const service = createServiceClient();
    const { error } = await service.from("usage_events").insert({
      company_id: input.companyId,
      type: input.type,
      quantity: input.quantity ?? 1,
      ref_id: input.refId ?? null,
    });

    if (error) {
      console.error("[usage] recordUsage failed:", {
        type: input.type,
        companyId: input.companyId,
        refId: input.refId ?? null,
        error: error.message,
      });
    }
  } catch (err) {
    // createServiceClient throws when the service-role env var is missing.
    // Still must not reach the caller.
    console.error("[usage] recordUsage threw:", err);
  }
}
