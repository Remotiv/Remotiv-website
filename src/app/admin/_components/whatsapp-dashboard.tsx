"use client";

import { Search as SearchIcon, UserRoundCog } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { UserRole } from "@/app/admin/lib/roles";
import type { InboundRow } from "@/app/admin/whatsapp/actions";
import { placeholderFor } from "@/lib/whatsapp/inbound-display";
import { LoadFailed } from "./load-failed";
import { PaginationControls, paginate } from "./pagination-controls";
import { TopNav } from "./top-nav";

type Filter = "All" | "Unattached" | "Attached" | "Identifier changes";

const FILTERS: ReadonlyArray<Filter> = ["All", "Unattached", "Attached", "Identifier changes"];

function senderOf(row: InboundRow): { primary: string; secondary: string | null } {
  if (row.profileName) {
    if (row.phone) return { primary: row.profileName, secondary: `+${row.phone}` };
    if (row.bsuid) return { primary: row.profileName, secondary: `ID ${row.bsuid}` };
    return { primary: row.profileName, secondary: null };
  }
  if (row.phone) return { primary: `+${row.phone}`, secondary: null };
  // Username-only: Meta sends no phone at all, so the business-scoped id is
  // the only thing that identifies this person.
  if (row.bsuid) return { primary: "Username-only sender", secondary: `ID ${row.bsuid}` };
  return { primary: "Unknown sender", secondary: null };
}

function fmtReceived(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const UNATTACHED_BADGE =
  "inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-semibold text-amber-700";

function MessageBody({ row, clamped }: { row: InboundRow; clamped: boolean }) {
  if (row.body) {
    return (
      <p className={clamped ? "line-clamp-2 text-gray-700" : "whitespace-pre-wrap text-gray-700"}>
        {row.body}
      </p>
    );
  }
  const { label, note } = placeholderFor(row.messageType);
  return (
    <p className="italic text-gray-400">
      {label} <span className="not-italic text-gray-300">· {note}</span>
    </p>
  );
}

function AttachedCell({ row }: { row: InboundRow }) {
  if (!row.applicationId) {
    return <span className={UNATTACHED_BADGE}>No matching candidate</span>;
  }
  // It matched, but the name lookup failed. Saying "no matching candidate"
  // here would report our failure as a fact about the message.
  if (!row.applicant) {
    return <span className="text-xs text-gray-400">Matched — name unavailable</span>;
  }
  return (
    <>
      <span className="font-medium text-gray-800">{row.applicant.name || "Unnamed applicant"}</span>
      {row.applicant.jobTitle && (
        <span className="block text-xs text-gray-400">{row.applicant.jobTitle}</span>
      )}
    </>
  );
}

/**
 * An identifier change is not something a person typed, so it must not be
 * dressed as a message. It is the only durable record that a candidate's
 * WhatsApp id changed — hiding it would make that invisible to the only people
 * who can see this table.
 */
function IdentifierChangeNotice({ row }: { row: InboundRow }) {
  const { primary, secondary } = senderOf(row);
  return (
    <div className="flex items-start gap-2 text-sm">
      <UserRoundCog className="mt-0.5 size-4 shrink-0 text-gray-500" strokeWidth={2} />
      <div className="min-w-0">
        <p className="font-medium text-gray-700">{primary} changed their WhatsApp identifier</p>
        {secondary && <p className="text-xs text-gray-400">{secondary}</p>}
        {row.body && <p className="mt-1 text-xs text-gray-500">{row.body}</p>}
      </div>
    </div>
  );
}

export function WhatsAppDashboard({
  email,
  userRole,
  initialRows,
  loadFailed,
}: {
  email: string;
  userRole: UserRole;
  initialRows: InboundRow[];
  /** The read failed. Distinct from "nothing has arrived". */
  loadFailed: boolean;
}) {
  const [rows, setRows] = useState<InboundRow[]>(initialRows);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [page, setPage] = useState(1);

  useEffect(() => setRows(initialRows), [initialRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "Unattached" && r.applicationId) return false;
      if (filter === "Attached" && !r.applicationId) return false;
      if (filter === "Identifier changes" && r.kind !== "identifier-change") return false;
      if (q) {
        const blob =
          `${r.profileName ?? ""} ${r.phone ?? ""} ${r.bsuid ?? ""} ${r.body ?? ""} ${r.applicant?.name ?? ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, filter]);

  const pageItems = paginate(filtered, page);
  const unattachedCount = rows.filter((r) => !r.applicationId).length;

  const emptyCopy =
    rows.length === 0
      ? {
          title: "No inbound messages yet",
          body: "Replies from candidates will appear here as they arrive.",
        }
      : { title: "No messages match your filters", body: "Try clearing the search or filter." };

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6">
          <p className="text-xs text-gray-400">Platform</p>
          <h1 className="font-heading text-2xl font-bold text-gray-900">WhatsApp inbox</h1>
          <p className="mt-1 text-sm text-gray-500">
            {rows.length} received · {unattachedCount} with no matching candidate
          </p>
          <p className="mt-2 max-w-2xl text-xs text-gray-400">
            Read-only. Replies are not sent from here, and media is not downloaded.
          </p>
        </div>

        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative max-w-md flex-1">
            <SearchIcon
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              strokeWidth={2}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search name, number, message…"
              className="h-11 w-full rounded-xl border border-gray-200 bg-white pl-10 pr-3 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-remotiv-purple"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFilter(f);
                  // Narrowing the list while on page 3 would otherwise strand
                  // the reader on a page the filtered list no longer has.
                  setPage(1);
                }}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                  filter === f
                    ? "bg-remotiv-purple text-white"
                    : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {loadFailed ? (
          <LoadFailed what="inbound messages" />
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-14 text-center">
            <p className="text-sm font-medium text-gray-600">{emptyCopy.title}</p>
            <p className="mt-1 text-xs text-gray-400">{emptyCopy.body}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 lg:hidden">
              {pageItems.map((row) =>
                row.kind === "identifier-change" ? (
                  <article
                    key={row.id}
                    className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3"
                  >
                    <IdentifierChangeNotice row={row} />
                    <p className="mt-2 text-[11px] text-gray-400">{fmtReceived(row.receivedAt)}</p>
                  </article>
                ) : (
                  <article
                    key={row.id}
                    className="rounded-2xl border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.02)]"
                  >
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-heading text-sm font-bold text-gray-900">
                          {senderOf(row).primary}
                        </p>
                        {senderOf(row).secondary && (
                          <p className="text-xs text-gray-400">{senderOf(row).secondary}</p>
                        )}
                      </div>
                      <span className="text-[11px] text-gray-400">
                        {fmtReceived(row.receivedAt)}
                      </span>
                    </div>
                    <div className="text-sm">
                      <MessageBody row={row} clamped={false} />
                    </div>
                    <div className="mt-3 border-t border-gray-100 pt-2 text-xs">
                      <AttachedCell row={row} />
                    </div>
                  </article>
                ),
              )}
              <PaginationControls page={page} setPage={setPage} total={filtered.length} />
            </div>

            <div className="hidden overflow-x-auto rounded-2xl border border-black/[0.05] bg-white shadow-sm lg:block">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50/60">
                  <tr>
                    {["From", "Message", "Attached to", "Received"].map((h) => (
                      <th
                        key={h}
                        className="whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((row) =>
                    row.kind === "identifier-change" ? (
                      <tr key={row.id} className="border-b border-gray-50 bg-gray-50/70">
                        <td colSpan={3} className="px-4 py-3">
                          <IdentifierChangeNotice row={row} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-gray-400">
                          {fmtReceived(row.receivedAt)}
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.id} className="border-b border-gray-50 align-top">
                        <td className="px-4 py-3">
                          <span className="block font-medium text-gray-800">
                            {senderOf(row).primary}
                          </span>
                          {senderOf(row).secondary && (
                            <span className="block text-xs text-gray-400">
                              {senderOf(row).secondary}
                            </span>
                          )}
                        </td>
                        <td className="max-w-md px-4 py-3">
                          <MessageBody row={row} clamped />
                        </td>
                        <td className="px-4 py-3">
                          <AttachedCell row={row} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-400">
                          {fmtReceived(row.receivedAt)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
              <div className="border-t border-gray-100 px-6 py-4">
                <PaginationControls page={page} setPage={setPage} total={filtered.length} />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
