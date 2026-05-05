"use client";

import Link from "next/link";
import {
  Briefcase,
  Building2,
  CalendarDays,
  CheckCircle2,
  FileText,
  Layers,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { UserRole } from "@/app/admin/lib/roles";
import { ROLE_LABELS } from "@/app/admin/lib/roles";
import type {
  ActivityItem,
  ActivityKind,
  DashboardStats,
  LoginActivityItem,
  MeetingDay,
  MeetingItem,
  MeetingKind,
  MetricResult,
  PipelineSlice,
  StatusSlice,
  SubmissionsDay,
} from "../page";
import { TopNav } from "./top-nav";

// ── Stat card config ─────────────────────────────────────────

type CardKey = keyof DashboardStats;

type StatCardDef = {
  key: CardKey;
  label: string;
  icon: LucideIcon;
  href: string;
  from: string;
  to: string;
};

const STAT_CARDS: StatCardDef[] = [
  {
    key: "talent",
    label: "Total Talent",
    icon: Users,
    href: "/admin/talent",
    from: "#c084fc",
    to: "#7E47FF",
  },
  {
    key: "remote",
    label: "Remote Talent",
    icon: UserPlus,
    href: "/admin/remote-talent",
    from: "#6ee7c7",
    to: "#49D7A7",
  },
  {
    key: "applications",
    label: "Applications",
    icon: FileText,
    href: "/admin/applications",
    from: "#93c5fd",
    to: "#3b82f6",
  },
  {
    key: "jobs",
    label: "Active Jobs",
    icon: Briefcase,
    href: "/admin/jobs",
    from: "#fdba74",
    to: "#f97316",
  },
  {
    key: "clients",
    label: "Active Clients",
    icon: Building2,
    href: "/admin/clients",
    from: "#f9a8d4",
    to: "#ec4899",
  },
  {
    key: "batches",
    label: "Active Batches",
    icon: Layers,
    href: "/admin/client-batches",
    from: "#a5b4fc",
    to: "#7E47FF",
  },
  {
    key: "bookings",
    label: "Bookings",
    icon: CalendarDays,
    href: "/admin/contacts?tab=bookings",
    from: "#86efac",
    to: "#22c55e",
  },
  {
    key: "contacts",
    label: "Contact Submissions",
    icon: MessageSquare,
    href: "/admin/contacts",
    from: "#d1d5db",
    to: "#6b7280",
  },
];

const STATUS_COLORS = [
  "#7E47FF",
  "#49D7A7",
  "#9886FE",
  "#f59e0b",
  "#3b82f6",
  "#FF6B6B",
  "#ec4899",
];

// ── Helpers ──────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function activityIcon(kind: ActivityKind): LucideIcon {
  switch (kind) {
    case "talent":
      return UserPlus;
    case "application":
      return FileText;
    case "decision":
      return CheckCircle2;
    case "booking":
      return CalendarDays;
    case "inquiry":
      return MessageCircle;
  }
}

const ACTIVITY_BADGE: Record<ActivityKind, { label: string; cls: string }> = {
  talent: { label: "Talent", cls: "bg-[#7E47FF]/10 text-[#7E47FF]" },
  application: { label: "Application", cls: "bg-blue-100 text-blue-700" },
  decision: { label: "Decision", cls: "bg-[#49D7A7]/15 text-emerald-700" },
  booking: { label: "Booking", cls: "bg-amber-100 text-amber-700" },
  inquiry: { label: "Inquiry", cls: "bg-gray-200 text-gray-700" },
};

// ── Tooltip ──────────────────────────────────────────────────

type ChartTooltipProps = {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
};

function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-[#111] px-4 py-3 shadow-xl">
      {label && (
        <p className="mb-2 text-[11px] font-semibold text-white/60">{label}</p>
      )}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span
            className="size-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-xs text-white/80">{p.name}</span>
          <span className="ml-auto pl-3 text-xs font-bold text-white">
            {p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Stat card ────────────────────────────────────────────────

function StatCard({
  def,
  metric,
}: {
  def: StatCardDef;
  metric: MetricResult;
}) {
  const Icon = def.icon;
  return (
    <Link
      href={def.href}
      className="group relative block overflow-hidden rounded-2xl p-6 text-white transition-transform hover:-translate-y-0.5 hover:shadow-xl"
      style={{ background: `linear-gradient(135deg, ${def.from}, ${def.to})` }}
    >
      <div className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-white/10" />
      <div className="pointer-events-none absolute -bottom-4 right-8 size-16 rounded-full bg-white/10" />

      <div
        className={`absolute right-4 top-4 flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold ${
          metric.up ? "bg-white/20 text-white" : "bg-black/20 text-white"
        }`}
      >
        {metric.up ? (
          <TrendingUp className="size-3" strokeWidth={2.5} />
        ) : (
          <TrendingDown className="size-3" strokeWidth={2.5} />
        )}
        {metric.up ? "+" : "-"}
        {metric.trend}%
      </div>

      <Icon className="mb-4 size-7 opacity-90" strokeWidth={1.8} />
      <p className="font-heading text-[2.6rem] font-bold leading-none">
        {metric.current.toLocaleString()}
      </p>
      <p className="mt-2 text-sm font-medium opacity-85">{def.label}</p>
      <p className="mt-3 text-[11px] opacity-50">
        {metric.up ? "↑" : "↓"} vs prior 30 days
      </p>
    </Link>
  );
}

// ── Activity row ─────────────────────────────────────────────

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = activityIcon(item.type);
  const badge = ACTIVITY_BADGE[item.type];
  return (
    <Link
      href={item.link}
      className="-mx-2 flex items-start gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-gray-50"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f5f3ff]">
        <Icon className="size-4 text-[#7E47FF]" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}
          >
            {badge.label}
          </span>
          <p className="truncate text-sm font-semibold text-[#111]">
            {item.title}
          </p>
        </div>
        <p className="mt-0.5 truncate text-xs text-gray-400">{item.subtitle}</p>
      </div>
      <p className="shrink-0 text-[11px] text-gray-400">
        {formatRelativeTime(item.time)}
      </p>
    </Link>
  );
}

// ── Main component ───────────────────────────────────────────

export function OverviewDashboard({
  email,
  userRole = "viewer",
  stats,
  submissionsByDay,
  applicationsByStatus,
  pipelineStats,
  activity,
  loginActivity,
  meetingSchedule,
}: {
  email: string;
  userRole?: UserRole;
  stats: DashboardStats;
  submissionsByDay: SubmissionsDay[];
  applicationsByStatus: StatusSlice[];
  pipelineStats: PipelineSlice[];
  activity: ActivityItem[];
  loginActivity: LoginActivityItem[];
  meetingSchedule: MeetingDay[];
}) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const totalApplications = applicationsByStatus.reduce(
    (s, d) => s + d.value,
    0,
  );
  const totalPipeline = pipelineStats.reduce((s, d) => s + d.value, 0);

  return (
    <div className="min-h-full bg-[#f8f4f1] font-sans">
      <TopNav email={email} userRole={userRole} />

      <div className="p-5 lg:p-8">
        <div className="mb-6">
          <p className="mb-0.5 text-xs font-medium text-gray-400">Dashboard</p>
          <div className="flex items-baseline justify-between">
            <h1 className="font-heading text-2xl font-bold text-[#111]">
              Summary Overview
            </h1>
            <p className="hidden text-sm text-gray-400 lg:block">{today}</p>
          </div>
        </div>

        {/* Stat cards — 8 in a 4-col grid */}
        <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {STAT_CARDS.map((def) => (
            <StatCard key={def.key} def={def} metric={stats[def.key]} />
          ))}
        </div>

        {/* Row 1: Submissions over 30 days + Applications by status */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-3">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-base font-semibold text-[#111]">
                  Submissions — last 30 days
                </h2>
                <p className="mt-0.5 text-xs text-gray-400">
                  Talent, Remote Ready, and Job Applications by day
                </p>
              </div>
              <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
                Daily
              </span>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart
                data={submissionsByDay}
                margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="talentFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7E47FF" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#7E47FF" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="remoteFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#49D7A7" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#49D7A7" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="appsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#9886FE" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#9886FE" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#f0f0f0"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "#bbb" }}
                  axisLine={false}
                  tickLine={false}
                  interval={4}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "#bbb" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="talent"
                  name="Talent"
                  stroke="#7E47FF"
                  strokeWidth={2.5}
                  fill="url(#talentFill)"
                  dot={false}
                  activeDot={{ r: 5, fill: "#7E47FF" }}
                />
                <Area
                  type="monotone"
                  dataKey="remote"
                  name="Remote Ready"
                  stroke="#49D7A7"
                  strokeWidth={2.5}
                  fill="url(#remoteFill)"
                  dot={false}
                  activeDot={{ r: 5, fill: "#49D7A7" }}
                />
                <Area
                  type="monotone"
                  dataKey="applications"
                  name="Applications"
                  stroke="#9886FE"
                  strokeWidth={2.5}
                  fill="url(#appsFill)"
                  dot={false}
                  activeDot={{ r: 5, fill: "#9886FE" }}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div className="mt-3 flex items-center gap-5">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#7E47FF]" />
                <span className="text-xs text-gray-400">Talent</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#49D7A7]" />
                <span className="text-xs text-gray-400">Remote Ready</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#9886FE]" />
                <span className="text-xs text-gray-400">Applications</span>
              </div>
            </div>
          </div>

          {/* Applications by status — donut */}
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Applications by Status
              </h2>
              <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
                All time
              </span>
            </div>

            {totalApplications === 0 ? (
              <EmptyChart label="No applications yet" />
            ) : (
              <>
                <div className="relative flex items-center justify-center">
                  <PieChart width={190} height={190}>
                    <Pie
                      data={applicationsByStatus}
                      cx={95}
                      cy={95}
                      innerRadius={58}
                      outerRadius={88}
                      paddingAngle={4}
                      dataKey="value"
                      startAngle={90}
                      endAngle={-270}
                    >
                      {applicationsByStatus.map((slice, i) => (
                        <Cell
                          key={slice.name}
                          fill={STATUS_COLORS[i % STATUS_COLORS.length]}
                          strokeWidth={0}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-[11px] text-gray-400">Total</span>
                    <span className="font-heading text-2xl font-bold text-[#111]">
                      {totalApplications}
                    </span>
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-2.5">
                  {applicationsByStatus.map((item, i) => (
                    <div
                      key={item.name}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{
                            background:
                              STATUS_COLORS[i % STATUS_COLORS.length],
                          }}
                        />
                        <span className="text-xs text-gray-500">
                          {item.name}
                        </span>
                      </div>
                      <span className="text-xs font-semibold text-gray-700">
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Row 2: Pipeline + Activity feed */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-3">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-base font-semibold text-[#111]">
                  Client Pipeline
                </h2>
                <p className="mt-0.5 text-xs text-gray-400">
                  Decisions across all batch candidates
                </p>
              </div>
              <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
                {totalPipeline} total
              </span>
            </div>
            {totalPipeline === 0 ? (
              <EmptyChart label="No pipeline activity yet" />
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={pipelineStats}
                  layout="vertical"
                  margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#f0f0f0"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "#bbb" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 12, fill: "#666" }}
                    axisLine={false}
                    tickLine={false}
                    width={140}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="value" radius={[0, 8, 8, 0]} barSize={22}>
                    {pipelineStats.map((slice) => (
                      <Cell key={slice.name} fill={slice.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Activity feed */}
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-2">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Recent Activity
              </h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                Live
              </span>
            </div>
            {activity.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">
                Nothing happening yet — submissions will show up here.
              </p>
            ) : (
              <div className="flex max-h-[460px] flex-col gap-1 overflow-y-auto pr-1">
                {activity.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Login Activity */}
        <div className="mb-4 rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Login Activity
              </h2>
              <p className="mt-0.5 text-xs text-gray-400">
                Admin team last sign-ins
              </p>
            </div>
            <Link
              href="/admin/team"
              className="text-xs font-semibold text-[#7E47FF] hover:underline"
            >
              Manage Team →
            </Link>
          </div>
          {loginActivity.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              No active admins
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {loginActivity.map((u) => (
                <LoginActivityRow key={u.user_id} item={u} />
              ))}
            </div>
          )}
        </div>

        {/* Meeting & Interview Schedule */}
        <MeetingSchedule schedule={meetingSchedule} />
      </div>
    </div>
  );
}

// ── Login activity row ───────────────────────────────────────

const ROLE_GRADIENT: Record<LoginActivityItem["role"], string> = {
  super_admin: "linear-gradient(135deg, #7E47FF, #9886FE)",
  admin: "linear-gradient(135deg, #49D7A7, #3bc494)",
  viewer: "linear-gradient(135deg, #93c5fd, #3b82f6)",
};

function fullNameInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatLastSignIn(iso: string | null): string {
  if (!iso) return "Never logged in";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(diffMs / 60_000));
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function LoginActivityRow({ item }: { item: LoginActivityItem }) {
  const initials = fullNameInitials(item.full_name);
  const isActive = item.status === "active";
  return (
    <div className="-mx-2 flex items-center justify-between rounded-xl px-2 py-2 transition-colors hover:bg-gray-50">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-full font-heading text-sm font-bold text-white"
          style={{ background: ROLE_GRADIENT[item.role] }}
        >
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#111]">
            {item.full_name}
          </p>
          <p className="truncate text-xs text-gray-400">
            {item.role_label} · {ROLE_LABELS[item.role]}
          </p>
        </div>
      </div>
      <div className="ml-4 shrink-0 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <span
            className={`size-1.5 rounded-full ${isActive ? "bg-emerald-500" : "bg-gray-300"}`}
          />
          <span className="text-[11px] font-semibold capitalize text-gray-600">
            {item.status}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-gray-400">
          {formatLastSignIn(item.last_sign_in_at)}
        </p>
      </div>
    </div>
  );
}

// ── Meeting schedule ─────────────────────────────────────────

const MEETING_COLOR: Record<MeetingKind, { bg: string; label: string }> = {
  booking: { bg: "#7E47FF", label: "Discovery Call" },
  interview: { bg: "#49D7A7", label: "Client Interview" },
};

function fmtMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function MeetingSchedule({ schedule }: { schedule: MeetingDay[] }) {
  const monthLabel = new Date().toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
  const totalCount = schedule.reduce((s, d) => s + d.meetings.length, 0);

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="font-heading text-base font-semibold text-[#111]">
            Meeting &amp; Interview Schedule
          </h2>
          <p className="mt-0.5 text-xs text-gray-400">
            Next 7 days · Discovery calls + client interviews
          </p>
        </div>
        <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
          {monthLabel}
        </span>
      </div>

      {totalCount === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">
          Nothing scheduled this week.
        </p>
      ) : (
        <div className="grid grid-cols-7 gap-2 sm:gap-3">
          {schedule.map((day) => (
            <MeetingDayCell key={day.date} day={day} />
          ))}
        </div>
      )}

      <div className="mt-5 flex items-center gap-5 border-t border-gray-100 pt-4">
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-[#7E47FF]" />
          <span className="text-xs text-gray-500">Discovery Call</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-[#49D7A7]" />
          <span className="text-xs text-gray-500">Client Interview</span>
        </div>
      </div>
    </div>
  );
}

function MeetingDayCell({ day }: { day: MeetingDay }) {
  return (
    <div className="flex min-h-[180px] flex-col gap-2.5">
      <div className="text-center">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {day.dayName}
        </p>
        {day.isToday ? (
          <p className="mx-auto mt-1 flex size-8 items-center justify-center rounded-full bg-[#7E47FF] font-heading text-sm font-bold text-white">
            {day.dayNum}
          </p>
        ) : (
          <p className="mt-1 font-heading text-lg font-bold text-[#111]">
            {day.dayNum}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {day.meetings.length === 0 ? (
          <p className="text-center text-xs text-gray-300">—</p>
        ) : (
          day.meetings.map((m) => <MeetingCard key={m.id} meeting={m} />)
        )}
      </div>
    </div>
  );
}

function MeetingCard({ meeting }: { meeting: MeetingItem }) {
  const color = MEETING_COLOR[meeting.type];
  return (
    <Link
      href={meeting.link}
      className="block rounded-xl p-2.5 text-white transition-opacity hover:opacity-90"
      style={{ background: color.bg }}
    >
      <p className="truncate text-[11px] font-bold leading-tight">
        {meeting.title}
      </p>
      <p className="mt-0.5 truncate text-[10px] opacity-85">
        {meeting.subtitle}
      </p>
      <p className="mt-1 text-[10px] font-medium opacity-90">
        {fmtMeetingTime(meeting.date)}
      </p>
    </Link>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-sm text-gray-400">
      {label}
    </div>
  );
}
