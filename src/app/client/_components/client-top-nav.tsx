import Link from "next/link";
import { ArrowLeft, Eye, LogOut } from "lucide-react";

export function ClientTopNav({
  companyName,
  isAdminPreview = false,
}: {
  companyName: string;
  isAdminPreview?: boolean;
}) {
  return (
    <div className="sticky top-0 z-40">
      {isAdminPreview && (
        <div className="border-b-2 border-amber-300 bg-amber-50 px-6 py-3">
          <div className="mx-auto flex max-w-screen-xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                <Eye className="size-4" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-amber-900">Admin Preview</p>
                <p className="truncate text-xs text-amber-700">
                  Read-only view of what the client sees. Stage, decisions, and notes are disabled here.
                </p>
              </div>
            </div>
            <Link
              href="/admin/client-batches"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100"
            >
              <ArrowLeft className="size-3.5" strokeWidth={2} />
              Back to Admin
            </Link>
          </div>
        </div>
      )}

      <header className="flex h-16 items-center justify-between border-b border-gray-100 bg-white/90 px-6 backdrop-blur-md md:px-10">
        <Link
          href={isAdminPreview ? "/admin/client-batches" : "/client/dashboard"}
          className="font-heading text-xl font-bold tracking-tight text-[#7E47FF]"
        >
          Remotiv<span className="font-extrabold">.</span>
        </Link>

        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-gray-500 sm:inline">
            {isAdminPreview ? "Viewing as" : "Welcome,"}{" "}
            <span className="font-semibold text-gray-800">{companyName}</span>
          </span>
          <span className="flex size-9 items-center justify-center rounded-full bg-[#7E47FF]/10 text-xs font-bold text-[#7E47FF]">
            {companyName
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase() ?? "")
              .join("") || "?"}
          </span>
          {isAdminPreview ? (
            <Link
              href="/admin/client-batches"
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-600 transition-colors hover:border-[#7E47FF]/40 hover:bg-gray-50 hover:text-[#7E47FF]"
            >
              <ArrowLeft className="size-3.5" strokeWidth={2} />
              Exit Preview
            </Link>
          ) : (
            <form action="/client/logout" method="post">
              <button
                type="submit"
                className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-600 transition-colors hover:border-[#7E47FF]/40 hover:bg-gray-50 hover:text-[#7E47FF]"
              >
                <LogOut className="size-3.5" strokeWidth={2} />
                Logout
              </button>
            </form>
          )}
        </div>
      </header>
    </div>
  );
}
