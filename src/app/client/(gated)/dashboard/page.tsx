import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Building2, CheckCircle, MessageSquare, Users, XCircle } from "lucide-react";
import { ClientTopNav } from "@/app/client/_components/client-top-nav";
import {
  fetchAllBatchesForAdmin,
  fetchClientBatches,
  getCurrentClientOrAdmin,
  type ClientBatchSummary,
} from "@/app/client/actions";

export const dynamic = "force-dynamic";

export default async function ClientDashboardPage() {
  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "none") redirect("/client/login");

  // TODO: When team grows, add audit log for admin-as-client impersonation.
  // See QA Phase 3 audit finding #8 — every action an admin takes via the
  // client portal should be recorded with the impersonator's user_id so we
  // can answer "who approved this candidate as the client?" in support cases.
  const isAdminPreview = ctx.type === "admin";
  const headerName = isAdminPreview ? "Admin Preview" : ctx.client.company_name;

  const batches: ClientBatchSummary[] = isAdminPreview
    ? await fetchAllBatchesForAdmin()
    : await fetchClientBatches();

  // Single-batch client → skip the dashboard entirely. Admins always see
  // the full grouped list so they can navigate to any client's batch.
  if (!isAdminPreview && batches.length === 1) {
    redirect(`/client/batch/${batches[0].id}`);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f8f4f1] via-white to-[#f8f4f1]">
      <ClientTopNav companyName={headerName} isAdminPreview={isAdminPreview} />

      <main className="mx-auto max-w-screen-xl px-6 py-12 md:px-10">
        <div className="mb-10">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[#7E47FF]">
            {isAdminPreview ? "Admin Preview" : "Client Portal"}
          </p>
          <h1 className="mt-2 font-heading text-3xl font-extrabold tracking-tight text-gray-900 md:text-4xl">
            {isAdminPreview ? "All Client Batches" : "Your Candidate Batches"}
          </h1>
          <p className="mt-2 max-w-xl text-sm text-gray-500">
            {isAdminPreview
              ? "Every batch across every client. Click any card to preview as that client."
              : "Review and provide feedback on candidates we've shortlisted for you."}
          </p>
        </div>

        {batches.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-gray-200 bg-white py-20 text-center shadow-sm">
            <Users className="mb-3 size-10 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-base font-semibold text-gray-700">
              {isAdminPreview ? "No batches exist yet" : "No active batches yet"}
            </p>
            <p className="mt-1 max-w-sm text-sm text-gray-400">
              {isAdminPreview
                ? "Create one in the admin panel to see it here."
                : "Your account manager will set up your candidate pipeline shortly. Check back soon."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {batches.map((b) => (
              <BatchCard key={b.id} batch={b} isAdminPreview={isAdminPreview} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function fmtDaysAgo(iso: string): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function BatchCard({
  batch,
  isAdminPreview,
}: {
  batch: ClientBatchSummary;
  isAdminPreview: boolean;
}) {
  return (
    <Link
      href={`/client/batch/${batch.id}`}
      className="group flex flex-col gap-5 rounded-3xl border border-gray-100 bg-white p-7 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg"
    >
      <div>
        {isAdminPreview && batch.client_name && (
          <p className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
            <Building2 className="size-3" strokeWidth={2} />
            {batch.client_name}
          </p>
        )}
        <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
          {batch.batch_name}
        </p>
        <h3 className="mt-1 font-heading text-xl font-bold text-gray-900">
          {batch.position_title || "Candidate batch"}
        </h3>
        <p className="mt-1 text-xs text-gray-400">Updated {fmtDaysAgo(batch.created_at)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={Users} label="Total" value={batch.total_count} tint="text-gray-700 bg-gray-100" />
        <Stat icon={MessageSquare} label="Pending" value={batch.pending_count} tint="text-blue-700 bg-blue-100" />
        <Stat icon={CheckCircle} label="Approved" value={batch.approved_count} tint="text-green-700 bg-green-100" />
        <Stat icon={XCircle} label="Rejected" value={batch.rejected_count} tint="text-red-700 bg-red-100" />
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-gray-100 pt-4">
        <span className="text-xs text-gray-500">
          {isAdminPreview
            ? "Open to preview as this client"
            : batch.pending_count > 0
            ? `${batch.pending_count} ${batch.pending_count === 1 ? "candidate" : "candidates"} need your review`
            : "All caught up"}
        </span>
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-[#7E47FF] transition-transform group-hover:translate-x-0.5">
          {isAdminPreview ? "View as Client" : "View Candidates"}
          <ArrowRight className="size-4" strokeWidth={2.5} />
        </span>
      </div>
    </Link>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tint,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: number;
  tint: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-gray-50/60 px-3 py-2.5">
      <span className={`inline-flex size-6 items-center justify-center rounded-full ${tint}`}>
        <Icon className="size-3" strokeWidth={2.5} />
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </span>
      <span className="font-heading text-lg font-bold text-gray-900">{value}</span>
    </div>
  );
}
