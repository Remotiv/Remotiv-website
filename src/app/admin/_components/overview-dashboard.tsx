"use client";

import Image from "next/image";
import {
  Users,
  Briefcase,
  MessageSquare,
  CalendarDays,
  TrendingUp,
  TrendingDown,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import type { UserRole } from "@/app/admin/lib/roles";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

// ── Types ────────────────────────────────────────────────────

export type DashboardStats = {
  totalApplications: number;
  totalContacts: number;
  totalBookings: number;
  pendingReview: number;
};

// ── Mock data ────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const APPLICATION_DATA = MONTHS.map((month, i) => ({
  month,
  applications: [12, 19, 15, 28, 22, 31, 25, 18, 24, 29, 35, 40][i],
  approved: [8, 12, 10, 18, 15, 20, 16, 12, 16, 19, 23, 28][i],
}));

const JOBS_DATA = MONTHS.map((month, i) => ({
  month,
  open: [8, 12, 10, 14, 11, 16, 13, 9, 12, 15, 18, 20][i],
  closed: [4, 5, 6, 8, 7, 9, 8, 5, 7, 8, 10, 12][i],
  onHold: [2, 1, 3, 2, 1, 2, 3, 2, 1, 2, 3, 2][i],
}));

const LEADS_DATA = [
  { name: "Recruitment", value: 45 },
  { name: "Staff Augmentation", value: 30 },
  { name: "Dedicated Team", value: 25 },
];
const LEAD_COLORS = ["#7E47FF", "#49D7A7", "#f59e0b"];

const ACTIVITY_LOG = [
  { name: "Sarah Ahmed",  role: "Talent Acquisition", time: "10:00 AM", avatar: "/avatars/female 2.png" },
  { name: "Waleed Khan",  role: "Operations Manager", time: "10:50 AM", avatar: "/avatars/Waleed.png"   },
  { name: "Bilal Rana",   role: "HR Manager",         time: "12:30 PM", avatar: "/avatars/male 3.png"   },
  { name: "Fatima Malik", role: "Recruiter",           time: "2:15 PM",  avatar: "/avatars/female 3.png" },
  { name: "Omar Sheikh",  role: "Engineering Lead",    time: "3:45 PM",  avatar: "/avatars/male 4.png"   },
];

const MEETINGS = [
  { title: "Team Standup", time: "9:00 AM", attendees: 8, accent: "#7E47FF" },
  { title: "Candidate Interview", time: "9:30 AM", attendees: 3, accent: "#111" },
  { title: "Client Onboarding", time: "11:00 AM", attendees: 5, accent: "#49D7A7" },
  { title: "Weekly HR Review", time: "2:00 PM", attendees: 12, accent: "#7E47FF" },
  { title: "Recruitment Drive", time: "3:30 PM", attendees: 20, accent: "#111" },
];

function getWeekDays() {
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return {
      label: d.toLocaleDateString("en-GB", { weekday: "short" }),
      day: String(d.getDate()).padStart(2, "0"),
      isToday: d.toDateString() === today.toDateString(),
    };
  });
}

// ── Stat cards ───────────────────────────────────────────────

type StatCardDef = {
  label: string;
  key: keyof DashboardStats | null;
  mockValue?: number;
  trend: string;
  up: boolean;
  from: string;
  to: string;
  icon: LucideIcon;
};

const STAT_CARDS: StatCardDef[] = [
  {
    label: "Total Talent Applications",
    key: "totalApplications",
    trend: "+8%",
    up: true,
    from: "#c084fc",
    to: "#7E47FF",
    icon: Users,
  },
  {
    label: "Active Jobs",
    key: null,
    mockValue: 24,
    trend: "-10.5%",
    up: false,
    from: "#6ee7c7",
    to: "#49D7A7",
    icon: Briefcase,
  },
  {
    label: "Total Contacts",
    key: "totalContacts",
    trend: "-10.5%",
    up: false,
    from: "#fdba74",
    to: "#f97316",
    icon: MessageSquare,
  },
  {
    label: "Meetings Booked",
    key: "totalBookings",
    trend: "+2.5%",
    up: true,
    from: "#93c5fd",
    to: "#3b82f6",
    icon: CalendarDays,
  },
];

// ── Custom tooltip ───────────────────────────────────────────

type ChartTooltipProps = {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
};

function ChartTooltip({ active, payload, label }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-[#111] px-4 py-3 shadow-xl">
      <p className="mb-2 text-[11px] font-semibold text-white/60">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-xs text-white/80">{p.name}</span>
          <span className="ml-auto text-xs font-bold text-white">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────

export function OverviewDashboard({
  email,
  userRole = "viewer",
  stats,
}: {
  email: string;
  userRole?: UserRole;
  stats: DashboardStats;
}) {
  const weekDays = getWeekDays();

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const updateDate = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="min-h-full bg-[#f8f4f1] font-sans">

      <TopNav email={email} userRole={userRole} />

      {/* ── Page content ── */}
      <div className="p-5 lg:p-8">

        {/* Page header */}
        <div className="mb-6">
          <p className="mb-0.5 text-xs font-medium text-gray-400">Dashboard</p>
          <div className="flex items-baseline justify-between">
            <h1 className="font-heading text-2xl font-bold text-[#111]">
              Summary Overview
            </h1>
            <p className="hidden text-sm text-gray-400 lg:block">{today}</p>
          </div>
        </div>

        {/* ── Stat cards ── */}
        <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {STAT_CARDS.map(({ label, key, mockValue, trend, up, from, to, icon: Icon }) => {
            const value = key != null ? stats[key] : (mockValue ?? 0);
            return (
              <div
                key={label}
                className="relative overflow-hidden rounded-2xl p-6 text-white"
                style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
              >
                {/* Circle decorations */}
                <div className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-white/10" />
                <div className="pointer-events-none absolute -bottom-4 right-8 size-16 rounded-full bg-white/10" />

                {/* Trend badge */}
                <div
                  className={`absolute right-4 top-4 flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold ${
                    up ? "bg-white/20 text-white" : "bg-black/15 text-white"
                  }`}
                >
                  {up ? (
                    <TrendingUp className="size-3" strokeWidth={2.5} />
                  ) : (
                    <TrendingDown className="size-3" strokeWidth={2.5} />
                  )}
                  {trend}
                </div>

                <Icon className="mb-4 size-7 opacity-90" strokeWidth={1.8} />
                <p className="font-heading text-[2.6rem] font-bold leading-none">{value}</p>
                <p className="mt-2 text-sm font-medium opacity-80">{label}</p>
                <p className="mt-3 text-[11px] opacity-50">Update: {updateDate}</p>
              </div>
            );
          })}
        </div>

        {/* ── Chart row 1: Applications + Donut ── */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">

          {/* Applications area chart */}
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-3">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Talent Applications
              </h2>
              <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
                Monthly
              </span>
            </div>
            <ResponsiveContainer width="100%" height={230}>
              <AreaChart data={APPLICATION_DATA} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="appFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7E47FF" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#7E47FF" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="apprvFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#49D7A7" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#49D7A7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#bbb" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#bbb" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="applications" name="Applications" stroke="#7E47FF" strokeWidth={2.5} fill="url(#appFill)" dot={false} activeDot={{ r: 5, fill: "#7E47FF" }} />
                <Area type="monotone" dataKey="approved" name="Approved" stroke="#49D7A7" strokeWidth={2.5} fill="url(#apprvFill)" dot={false} activeDot={{ r: 5, fill: "#49D7A7" }} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="mt-3 flex items-center gap-5">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#7E47FF]" />
                <span className="text-xs text-gray-400">Applications</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-full bg-[#49D7A7]" />
                <span className="text-xs text-gray-400">Approved</span>
              </div>
            </div>
          </div>

          {/* Donut chart */}
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Leads by Service
              </h2>
              <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
                2025
              </span>
            </div>

            <div className="relative flex items-center justify-center">
              <PieChart width={190} height={190}>
                <Pie
                  data={LEADS_DATA}
                  cx={95}
                  cy={95}
                  innerRadius={58}
                  outerRadius={88}
                  paddingAngle={4}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  {LEADS_DATA.map((_, i) => (
                    <Cell key={i} fill={LEAD_COLORS[i]} strokeWidth={0} />
                  ))}
                </Pie>
              </PieChart>
              {/* Center label */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[11px] text-gray-400">Total</span>
                <span className="font-heading text-2xl font-bold text-[#111]">
                  {LEADS_DATA.reduce((s, d) => s + d.value, 0)}
                </span>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2.5">
              {LEADS_DATA.map((item, i) => (
                <div key={item.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: LEAD_COLORS[i] }}
                    />
                    <span className="text-xs text-gray-500">{item.name}</span>
                  </div>
                  <span className="text-xs font-semibold text-gray-700">{item.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Chart row 2: Jobs + Activity Log ── */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">

          {/* Jobs area chart */}
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-3">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Jobs by Status
              </h2>
              <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
                Monthly
              </span>
            </div>
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={JOBS_DATA} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="openFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#49D7A7" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#49D7A7" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="closedFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6b7280" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#6b7280" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="holdFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#bbb" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#bbb" }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="open" name="Open" stroke="#49D7A7" strokeWidth={2.5} fill="url(#openFill)" dot={false} activeDot={{ r: 5, fill: "#49D7A7" }} />
                <Area type="monotone" dataKey="closed" name="Closed" stroke="#6b7280" strokeWidth={2.5} fill="url(#closedFill)" dot={false} activeDot={{ r: 5, fill: "#6b7280" }} />
                <Area type="monotone" dataKey="onHold" name="On Hold" stroke="#f59e0b" strokeWidth={2.5} fill="url(#holdFill)" dot={false} activeDot={{ r: 5, fill: "#f59e0b" }} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="mt-3 flex items-center gap-5">
              <div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-[#49D7A7]" /><span className="text-xs text-gray-400">Open</span></div>
              <div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-gray-400" /><span className="text-xs text-gray-400">Closed</span></div>
              <div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-amber-400" /><span className="text-xs text-gray-400">On Hold</span></div>
            </div>
          </div>

          {/* Activity log */}
          <div className="rounded-2xl bg-white p-6 shadow-sm lg:col-span-2">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-[#111]">
                Activity Log
              </h2>
              <button type="button" className="text-xs font-semibold text-[#49D7A7] hover:opacity-75">
                See All
              </button>
            </div>
            <div className="flex flex-col gap-4">
              {ACTIVITY_LOG.map(({ name, role, time, avatar }) => (
                <div key={name} className="flex items-center gap-3">
                  <div className="relative size-10 shrink-0 overflow-hidden rounded-full">
                    <Image
                      src={avatar}
                      alt={name}
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[#111]">{name}</p>
                    <p className="truncate text-xs text-gray-400">{role}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 text-xs text-gray-400">
                    <Clock className="size-3" strokeWidth={2} />
                    {time}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Meeting schedule ── */}
        <div className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-heading text-base font-semibold text-[#111]">
              Meeting &amp; Interview Schedule
            </h2>
            <span className="rounded-lg bg-gray-50 px-3 py-1 text-xs text-gray-400">
              {new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
            </span>
          </div>

          <div className="grid grid-cols-5 gap-3">
            {weekDays.map(({ label, day, isToday }, i) => {
              const meeting = MEETINGS[i];
              return (
                <div key={label} className="flex flex-col gap-2.5">
                  {/* Day header */}
                  <div className="text-center">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
                      {label}
                    </p>
                    <p
                      className={`mx-auto mt-1 flex size-7 items-center justify-center rounded-full text-sm font-bold ${
                        isToday
                          ? "bg-[#7E47FF] text-white"
                          : "text-gray-600"
                      }`}
                    >
                      {day}
                    </p>
                  </div>
                  {/* Meeting card */}
                  <div
                    className="flex-1 rounded-xl p-3 text-white"
                    style={{ background: meeting.accent }}
                  >
                    <p className="truncate text-xs font-semibold leading-tight">
                      {meeting.title}
                    </p>
                    <p className="mt-1.5 text-[11px] opacity-70">{meeting.time}</p>
                    <div className="mt-2 flex items-center gap-1.5">
                      {/* Mini avatar stack */}
                      {Array.from({ length: Math.min(3, meeting.attendees) }).map((_, ai) => (
                        <div
                          key={ai}
                          className="-ml-1 first:ml-0 flex size-5 items-center justify-center rounded-full border border-white/30 bg-white/25 text-[8px] font-bold text-white"
                        >
                          {String.fromCharCode(65 + ai)}
                        </div>
                      ))}
                      {meeting.attendees > 3 && (
                        <span className="text-[10px] opacity-60">+{meeting.attendees - 3}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
