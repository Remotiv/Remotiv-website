import {
  ArrowRight,
  BarChart3,
  Brain,
  Cloud,
  CloudCog,
  Code,
  Cpu,
  Database,
  FlaskConical,
  Gamepad2,
  Layout,
  Link2,
  Server,
  ShieldCheck,
  Smartphone,
} from "lucide-react";

const ROLES = [
  { name: "Hire Full-stack Developer", icon: Code },
  { name: "Hire Front-end Developer", icon: Layout },
  { name: "Hire Back-end Developer", icon: Server },
  { name: "Hire Mobile Developer", icon: Smartphone },
  { name: "Hire Game Developer", icon: Gamepad2 },
  { name: "Hire DevOps Engineer", icon: CloudCog },
  { name: "Hire Cloud Engineer", icon: Cloud },
  { name: "Hire AI Engineer", icon: Brain },
  { name: "Hire ML Engineer", icon: Cpu },
  { name: "Hire Data Analyst", icon: BarChart3 },
  { name: "Hire Data Engineer", icon: Database },
  { name: "Hire Data Scientist", icon: FlaskConical },
  { name: "Hire Blockchain Developer", icon: Link2 },
  { name: "Hire Automation QA", icon: ShieldCheck },
] as const;

export function BrowseRoles() {
  return (
    <section className="bg-[#9886fe] px-6 pt-16 pb-20 sm:px-14">
      <div className="mx-auto max-w-7xl">
        <h2 className="font-heading mb-10 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Hire developers by role
        </h2>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {ROLES.map((role) => {
            const Icon = role.icon;
            return (
              <div
                key={role.name}
                className="group flex min-h-[180px] flex-col items-center gap-3 rounded-2xl border border-[#252525] bg-white py-8 px-5 text-center transition-colors hover:bg-[#f5f5f5]"
              >
                <Icon className="size-6 text-remotiv-text-dark" />
                <span className="text-sm font-medium text-remotiv-text-dark">{role.name}</span>
              </div>
            );
          })}

          {/* Special card */}
          <div className="group flex min-h-[180px] flex-col items-center justify-between gap-4 rounded-2xl border border-dashed border-white/40 bg-white/10 py-8 px-5 text-center backdrop-blur-sm">
            <span className="text-sm font-medium text-white">Looking for another role?</span>
            <a
              href="/contact"
              className="inline-flex items-center gap-1.5 rounded-full bg-black px-4 py-2 text-xs font-semibold text-white transition-transform hover:-translate-y-0.5"
            >
              Place request <ArrowRight className="size-3.5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
