import { notFound, redirect } from "next/navigation";
import { ClientBatchView } from "@/app/client/_components/client-batch-view";
import {
  fetchBatchForAdmin,
  fetchClientBatchById,
  getCurrentClientOrAdmin,
} from "@/app/client/actions";

export const dynamic = "force-dynamic";

export default async function ClientBatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const ctx = await getCurrentClientOrAdmin();
  if (ctx.type === "none") redirect("/client/login");

  if (ctx.type === "admin") {
    const adminData = await fetchBatchForAdmin(id);
    if (!adminData.batch) notFound();
    return (
      <ClientBatchView
        companyName={adminData.batch.client_name || "Admin Preview"}
        batch={adminData.batch}
        initialCandidates={adminData.candidates}
        isAdminPreview
      />
    );
  }

  const { batch, candidates } = await fetchClientBatchById(id);
  if (!batch) notFound();

  return (
    <ClientBatchView
      companyName={ctx.client.company_name}
      batch={batch}
      initialCandidates={candidates}
    />
  );
}
