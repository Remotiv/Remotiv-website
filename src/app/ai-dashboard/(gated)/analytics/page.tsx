import type { Metadata } from "next";
import { AnalyticsClient } from "./_analytics-client";
import { fetchAnalytics } from "./actions";

export const metadata: Metadata = { title: "Analytics · Remotiv" };

/**
 * Every figure on this page is a server aggregate.
 *
 * Rendered server-side for the first range so the DAY-ONE state — which is the
 * state most companies are in — arrives with the HTML rather than after a
 * spinner. Changing the range re-runs the same action.
 */
export default async function AnalyticsPage() {
  const initial = await fetchAnalytics("90d");
  return <AnalyticsClient initial={initial} />;
}
