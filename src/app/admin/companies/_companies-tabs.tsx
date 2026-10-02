import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The tab strip on /admin/companies. Two plain links, so a tab is a URL: it
 * survives a reload, can be shared, and needs no client script.
 *
 * Lives here rather than in the admin top navigation, which belongs to another
 * line of work and is not edited from this one.
 */

export type CompaniesTab = "companies" | "usage";

/** Anything but an exact "usage" is the default tab. */
export function parseCompaniesTab(raw: string | string[] | undefined): CompaniesTab {
  return raw === "usage" ? "usage" : "companies";
}

const TABS: { id: CompaniesTab; label: string; href: string }[] = [
  { id: "companies", label: "Companies", href: "/admin/companies" },
  { id: "usage", label: "Plans & Usage", href: "/admin/companies?tab=usage" },
];

const TAB_BASE =
  "inline-flex min-h-10 items-center rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-remotiv-purple";

export function CompaniesTabs({ active }: { active: CompaniesTab }) {
  return (
    <nav aria-label="Companies sections" className="mb-6">
      <ul className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const current = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  TAB_BASE,
                  current
                    ? "bg-gray-900 text-white"
                    : "bg-white text-gray-700 shadow-sm hover:bg-gray-50",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
