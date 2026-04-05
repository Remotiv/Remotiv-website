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
  { name: "Full-stack Developer", icon: Code },
  { name: "Front-end Developer", icon: Layout },
  { name: "Back-end Developer", icon: Server },
  { name: "Mobile Developer", icon: Smartphone },
  { name: "Game Developer", icon: Gamepad2 },
  { name: "DevOps Engineer", icon: CloudCog },
  { name: "Cloud Engineer", icon: Cloud },
  { name: "AI Engineer", icon: Brain },
  { name: "ML Engineer", icon: Cpu },
  { name: "Data Analyst", icon: BarChart3 },
  { name: "Data Engineer", icon: Database },
  { name: "Data Scientist", icon: FlaskConical },
  { name: "Blockchain Developer", icon: Link2 },
  { name: "Automation QA", icon: ShieldCheck },
] as const;

export function BrowseRoles() {
  return (
    <section className="bg-[#9886fe] px-6 py-16 sm:px-14 sm:py-16">
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
                className="group flex flex-col items-start gap-3 rounded-2xl border border-black/10 bg-white p-5 transition-colors hover:border-remotiv-purple"
              >
                <Icon className="size-6 text-remotiv-text-dark" />
                <span className="text-sm font-medium text-remotiv-text-dark">{role.name}</span>
              </div>
            );
          })}

          {/* Special card */}
          <div className="group flex flex-col items-start justify-between gap-4 rounded-2xl border border-dashed border-white/40 bg-white/10 p-5 backdrop-blur-sm">
            <span className="text-sm font-medium text-white">Looking for another role?</span>
            <a
              href="/contact"
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-remotiv-text-dark transition-transform hover:-translate-y-0.5"
            >
              Place request <ArrowRight className="size-3.5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
