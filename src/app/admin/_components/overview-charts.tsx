"use client";

/**
 * Recharts-only side of the admin overview dashboard.
 *
 * Recharts (+ d3) is roughly 120 KB gzipped — bigger than the rest of the
 * page combined. Putting the three chart bodies behind their own module
 * means dynamic-import in overview-dashboard.tsx pulls the lib out of the
 * initial /admin chunk and loads it on demand instead.
 *
 * Each export takes plain data + small style props; no parent state
 * leaks across the boundary, so the dynamic-import surface is trivial.
 */

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
import type {
  PipelineSlice,
  StatusSlice,
  SubmissionsDay,
} from "../page";

// ── Tooltip — used by all three charts ──────────────────────

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

// ── Submissions over 30 days (stacked area) ──────────────────

export function SubmissionsChart({
  data,
  tickInterval,
}: {
  data: SubmissionsDay[];
  tickInterval: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
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
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "#bbb" }}
          axisLine={false}
          tickLine={false}
          interval={tickInterval}
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
  );
}

// ── Applications-by-status donut ─────────────────────────────

export function ApplicationsStatusChart({
  data,
  colors,
}: {
  data: StatusSlice[];
  colors: ReadonlyArray<string>;
}) {
  return (
    <PieChart width={190} height={190}>
      <Pie
        data={data}
        cx={95}
        cy={95}
        innerRadius={58}
        outerRadius={88}
        paddingAngle={4}
        dataKey="value"
        startAngle={90}
        endAngle={-270}
      >
        {data.map((slice, i) => (
          <Cell
            key={slice.name}
            fill={colors[i % colors.length]}
            strokeWidth={0}
          />
        ))}
      </Pie>
      <Tooltip content={<ChartTooltip />} />
    </PieChart>
  );
}

// ── Pipeline bar chart ───────────────────────────────────────

export function PipelineChart({ data }: { data: PipelineSlice[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
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
          {data.map((slice) => (
            <Cell key={slice.name} fill={slice.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
