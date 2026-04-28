import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STAT_CARDS = [
  { label: "Total Contacts", key: "contacts", color: "#7E47FF" },
  { label: "Total Applications", key: "applications", color: "#49D7A7" },
  { label: "Total Bookings", key: "bookings", color: "#3b82f6" },
  { label: "Pending Review", key: "pending", color: "#f59e0b" },
] as const;

const STATUS_STYLES: Record<string, string> = {
  new: "bg-[#49D7A7]/10 text-[#1a9e73]",
  read: "bg-gray-100 text-gray-500",
  replied: "bg-blue-50 text-blue-600",
  archived: "bg-gray-100 text-gray-400",
};

type RecentContact = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  service: string | null;
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

export default async function AdminOverviewPage() {
  const supabase = createServiceClient();

  const [
    { count: contactsCount },
    { count: applicationsCount },
    { count: bookingsCount },
    { count: pendingCount },
    { data: recentContacts },
  ] = await Promise.all([
    supabase
      .from("contact_submissions")
      .select("*", { count: "exact", head: true }),
    supabase.from("profiles").select("*", { count: "exact", head: true }),
    supabase.from("bookings").select("*", { count: "exact", head: true }),
    supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("contact_submissions")
      .select("id, name, email, company, service, created_at, status")
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const counts: Record<string, number> = {
    contacts: contactsCount ?? 0,
    applications: applicationsCount ?? 0,
    bookings: bookingsCount ?? 0,
    pending: pendingCount ?? 0,
  };

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="font-heading text-2xl font-bold text-gray-900">
          Overview
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          {new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {STAT_CARDS.map(({ label, key, color }) => (
          <div
            key={key}
            className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm"
          >
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
              {label}
            </p>
            <p
              className="font-heading text-4xl font-bold"
              style={{ color }}
            >
              {counts[key]}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 className="font-heading text-base font-semibold text-gray-800">
            Recent Contacts
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                {["Name", "Email", "Company", "Service", "Date", "Status"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {!recentContacts || recentContacts.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-10 text-center text-sm text-gray-400"
                  >
                    No contacts yet
                  </td>
                </tr>
              ) : (
                (recentContacts as RecentContact[]).map((c) => (
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
  );
}
