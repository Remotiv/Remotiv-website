"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Briefcase,
  LayoutGrid,
  type LucideIcon,
  Mail,
  Settings,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";
import {
  COMPANY_ROLE_LABELS,
  type CompanyRole,
} from "@/app/ai-dashboard/lib/company-roles";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Count badge. Rendered whenever defined — 0 is a real, meaningful value. */
  count?: number;
  /** Route not built yet: render inert instead of linking to a 404. */
  soon?: boolean;
};

function primaryNav(
  jobCount: number,
  applicantCount: number,
  messageCount: number,
  interviewCount: number,
): ReadonlyArray<NavItem> {
  return [
    { label: "Overview",   href: "/ai-dashboard",            icon: LayoutGrid },
    { label: "Jobs",       href: "/ai-dashboard/jobs",       icon: Briefcase, count: jobCount },
    { label: "Applicants", href: "/ai-dashboard/applicants", icon: Users,     count: applicantCount },
    { label: "Messages",   href: "/ai-dashboard/messages",   icon: Mail,      count: messageCount },
    { label: "Interviews", href: "/ai-dashboard/interviews", icon: Video,     count: interviewCount },
  ];
}

const WORKSPACE_NAV: ReadonlyArray<NavItem> = [
  { label: "Team",     href: "/ai-dashboard/team",     icon: UserRound },
  { label: "Settings", href: "/ai-dashboard/settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/ai-dashboard") return pathname === "/ai-dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

const LINK_BASE =
  "flex items-center gap-[11px] rounded-[10px] px-2.5 py-2.5 text-[13.5px] font-medium transition-colors";

function NavRow({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const { label, href, icon: Icon, count, soon } = item;
  const active = isActive(pathname, href);

  const badge =
    count === undefined ? null : (
      <span
        className={`ml-auto rounded-full px-[7px] py-px text-[11px] font-semibold ${
          active ? "bg-white/20" : "bg-white/[0.14]"
        }`}
      >
        {count}
      </span>
    );

  const inner = (
    <>
      <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
      {label}
      {badge}
    </>
  );

  // Unbuilt routes render as inert rows — linking would 404.
  if (soon) {
    return (
      <span
        aria-disabled="true"
        title="Coming soon"
        className={`${LINK_BASE} cursor-default text-white/40`}
      >
        {inner}
      </span>
    );
  }

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`${LINK_BASE} ${
        active
          ? "bg-remotiv-purple font-semibold text-white"
          : "text-white/60 hover:bg-white/[0.06] hover:text-white"
      }`}
    >
      {inner}
    </Link>
  );
}

function getCompanyInitial(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? "?";
}

function SidebarBody({
  companyName,
  companyLogoUrl,
  role,
  jobCount,
  applicantCount,
  messageCount,
  interviewCount,
  pathname,
  onNavigate,
}: {
  companyName: string;
  companyLogoUrl: string | null;
  role: CompanyRole;
  jobCount: number;
  applicantCount: number;
  messageCount: number;
  interviewCount: number;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2.5 px-2 pb-[22px] pt-1">
        <span className="font-heading text-[21px] font-extrabold tracking-[-0.02em] text-white">
          Remotiv<span className="text-remotiv-green">.</span>
        </span>
      </div>

      <div className="mb-[18px] flex items-center gap-2.5 rounded-xl border border-white/[0.09] bg-white/[0.06] px-[11px] py-[9px]">
        {/* The uploaded logo where the letter tile is, falling back to the
            initial when there is none. object-cover so a non-square upload
            fills the tile instead of letterboxing inside it. */}
        <span className="flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-gradient-to-br from-remotiv-purple to-remotiv-purple-light text-[13px] font-bold text-white">
          {companyLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={companyLogoUrl} alt="" className="size-full object-cover" />
          ) : (
            getCompanyInitial(companyName)
          )}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight text-white">
            {companyName}
          </div>
          <div className="text-[11px] text-white/50">{COMPANY_ROLE_LABELS[role]}</div>
        </div>
      </div>

      <nav className="mb-1.5 flex flex-col gap-0.5">
        {primaryNav(jobCount, applicantCount, messageCount, interviewCount).map(
          (item) => (
          <NavRow key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
          ),
        )}
      </nav>

      <nav className="flex flex-col gap-0.5">
        <div className="px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
          Workspace
        </div>
        {WORKSPACE_NAV.map((item) => (
          <NavRow key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
        ))}
      </nav>
    </>
  );
}

export function AiSidebar({
  companyName,
  companyLogoUrl,
  role,
  jobCount,
  applicantCount,
  messageCount,
  interviewCount,
  mobileOpen,
  onClose,
}: {
  companyName: string;
  companyLogoUrl: string | null;
  role: CompanyRole;
  jobCount: number;
  applicantCount: number;
  messageCount: number;
  interviewCount: number;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop — sticky full-height rail */}
      <aside className="sticky top-0 hidden h-[var(--vh-full)] w-[236px] shrink-0 flex-col self-start bg-[var(--ai-sidebar)] px-4 pb-[18px] pt-[22px] min-[840px]:flex">
        <SidebarBody
          companyName={companyName}
          companyLogoUrl={companyLogoUrl}
          role={role}
          jobCount={jobCount}
          applicantCount={applicantCount}
          messageCount={messageCount}
          interviewCount={interviewCount}
          pathname={pathname}
        />
      </aside>

      {/* Mobile — overlay drawer */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 min-[840px]:hidden ${
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[264px] max-w-[85vw] flex-col overflow-y-auto bg-[var(--ai-sidebar)] px-4 pb-[18px] pt-[22px] shadow-2xl transition-transform duration-300 ease-out min-[840px]:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-hidden={!mobileOpen}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="size-5" strokeWidth={2} />
        </button>
        <SidebarBody
          companyName={companyName}
          companyLogoUrl={companyLogoUrl}
          role={role}
          jobCount={jobCount}
          applicantCount={applicantCount}
          messageCount={messageCount}
          interviewCount={interviewCount}
          pathname={pathname}
          onNavigate={onClose}
        />
      </aside>
    </>
  );
}
