import { fetchWeekReport } from "./actions";
import { WeeklyClient } from "./_weekly-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Weekly report — Remotiv AI Interviews" };

export default async function WeeklyReportPage() {
  // Offset 0 = the most recent COMPLETE Monday–Sunday. The guard inside the
  // action resolves the company, so every role lands here with their own data.
  const week = await fetchWeekReport(0);
  return <WeeklyClient initialWeek={week} />;
}
