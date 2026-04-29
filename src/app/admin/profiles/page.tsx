import { createClient, createServiceClient } from "@/lib/supabase/server";
import { TopNav } from "../_components/top-nav";
import { type UserRole, SUPER_ADMIN_EMAIL } from "../lib/roles";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-amber-600",
  reviewing: "bg-blue-50 text-blue-600",
  approved: "bg-[#49D7A7]/10 text-[#1a9e73]",
  rejected: "bg-red-50 text-red-500",
};

type ProfileRow = {
  id: string;
  full_name: string;
  email: string;
  status: string;
  created_at: string;
  vetting_score: number | null;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function AdminProfilesPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [{ data: profiles }, { data: roleRow }] = await Promise.all([
    service
      .from("profiles")
      .select("id, full_name, email, status, created_at, vetting_score")
      .order("created_at", { ascending: false }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  const rows = (profiles ?? []) as ProfileRow[];
  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return (
    <div className="min-h-full bg-[#f8f4f1] font-sans">
      <TopNav email={userEmail} userRole={userRole} />

      <div className="p-5 lg:p-8">
        <div className="mb-8">
          <h1 className="font-heading text-2xl font-bold text-[#111]">
            Talent Profiles
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            {rows.length} application{rows.length !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  {["Name", "Email", "Status", "Applied", "Vetting Score"].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-6 py-3.5 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-6 py-12 text-center text-sm text-gray-400"
                    >
                      No talent applications yet
                    </td>
                  </tr>
                ) : (
                  rows.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-6 py-3.5 font-medium text-gray-800">
                        {p.full_name}
                      </td>
                      <td className="px-6 py-3.5 text-gray-500">{p.email}</td>
                      <td className="px-6 py-3.5">
                        <span
                          className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[p.status] ?? "bg-gray-100 text-gray-500"}`}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-gray-400">
                        {fmt(p.created_at)}
                      </td>
                      <td className="px-6 py-3.5">
                        {p.vetting_score != null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-100">
                              <div
                                className="h-full rounded-full bg-[#49D7A7]"
                                style={{ width: `${p.vetting_score}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-500">
                              {p.vetting_score}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
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
