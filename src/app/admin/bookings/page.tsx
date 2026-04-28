import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  new: "bg-[#49D7A7]/10 text-[#1a9e73]",
  confirmed: "bg-blue-50 text-blue-600",
  cancelled: "bg-red-50 text-red-500",
  completed: "bg-gray-100 text-gray-500",
};

type BookingRow = {
  id: string;
  full_name: string;
  email: string;
  company: string | null;
  service: string | null;
  preferred_date: string | null;
  preferred_time: string | null;
  status: string;
  created_at: string;
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function AdminBookingsPage() {
  const supabase = createServiceClient();
  const { data: bookings } = await supabase
    .from("bookings")
    .select("*")
    .order("created_at", { ascending: false });

  const rows = (bookings ?? []) as BookingRow[];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="font-heading text-2xl font-bold text-gray-900">
          Bookings
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          {rows.length} booking{rows.length !== 1 ? "s" : ""}
        </p>
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
                  "Preferred Date",
                  "Time",
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
                    No bookings yet
                  </td>
                </tr>
              ) : (
                rows.map((b) => (
                  <tr
                    key={b.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-6 py-3.5 font-medium text-gray-800">
                      {b.full_name}
                    </td>
                    <td className="px-6 py-3.5 text-gray-500">{b.email}</td>
                    <td className="px-6 py-3.5 text-gray-500">
                      {b.company ?? "—"}
                    </td>
                    <td className="px-6 py-3.5 text-gray-500">
                      {b.service ?? "—"}
                    </td>
                    <td className="px-6 py-3.5 text-gray-400">
                      {b.preferred_date ? fmt(b.preferred_date) : "—"}
                    </td>
                    <td className="px-6 py-3.5 text-gray-400">
                      {b.preferred_time ?? "—"}
                    </td>
                    <td className="px-6 py-3.5">
                      <span
                        className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[b.status] ?? "bg-gray-100 text-gray-500"}`}
                      >
                        {b.status}
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
