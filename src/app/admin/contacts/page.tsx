import { createClient, createServiceClient } from "@/lib/supabase/server";
import { TopNav } from "../_components/top-nav";
import type { UserRole } from "../lib/roles";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  new: "bg-[#49D7A7]/10 text-[#1a9e73]",
  read: "bg-gray-100 text-gray-500",
  replied: "bg-blue-50 text-blue-600",
  archived: "bg-gray-100 text-gray-400",
};

type ContactRow = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  service: string | null;
  message: string;
  created_at: string;
  status: string;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function AdminContactsPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";

  const [{ data: contacts }, { data: roleRow }] = await Promise.all([
    service
      .from("contact_submissions")
      .select("*")
      .order("created_at", { ascending: false }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  const rows = (contacts ?? []) as ContactRow[];
  const userRole = (roleRow?.role ?? "viewer") as UserRole;

  return (
    <div className="min-h-full bg-[#f8f4f1] font-sans">
      <TopNav email={user?.email ?? ""} userRole={userRole} />

      <div className="p-5 lg:p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold text-[#111]">
              Contacts
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              {rows.length} submission{rows.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {[
                    "Name",
                    "Email",
                    "Company",
                    "Service",
                    "Message",
                    "Date",
                    "Status",
                  ].map((h) => (
                    <th
                      key={h}
                      className="px-6 py-3.5 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-12 text-center text-sm text-gray-400"
                    >
                      No contact submissions yet
                    </td>
                  </tr>
                ) : (
                  rows.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-6 py-3.5 font-medium text-gray-800">
                        {c.name}
                      </td>
                      <td className="px-6 py-3.5 text-gray-500">{c.email}</td>
                      <td className="px-6 py-3.5 text-gray-500">
                        {c.company ?? "—"}
                      </td>
                      <td className="px-6 py-3.5 text-gray-500">
                        {c.service ?? "—"}
                      </td>
                      <td className="max-w-[220px] px-6 py-3.5 text-gray-500">
                        <span className="block truncate" title={c.message}>
                          {c.message}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-gray-400">
                        {fmt(c.created_at)}
                      </td>
                      <td className="px-6 py-3.5">
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[c.status] ?? "bg-gray-100 text-gray-500"}`}
                        >
                          {c.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
