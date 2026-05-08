import {
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
import Link from "next/link";

const ROLES = [
  { name: "Hire Full-stack Developer", icon: Code },
  { name: "Hire Front-end Developer", icon: Layout },
  { name: "Hire Back-end Developer", icon: Server },
  { name: "Hire Mobile Developer", icon: Smartphone },
  { name: "Hire Game Developer", icon: Gamepad2 },
  { name: "Hire DevOps", icon: CloudCog },
  { name: "Hire Cloud Engineer", icon: Cloud },
  { name: "Hire AI Developer", icon: Brain },
  { name: "Hire Machine Learning Engineer", icon: Cpu },
  { name: "Hire Data Analyst", icon: BarChart3 },
  { name: "Hire Data Engineer", icon: Database },
  { name: "Hire Data Scientist", icon: FlaskConical },
  { name: "Hire Blockchain Developer", icon: Link2 },
  { name: "Hire Automation QA", icon: ShieldCheck },
] as const;

export function BrowseRoles() {
  return (
    <section className="bg-remotiv-purple-light px-6 py-12 sm:px-14">
      <div className="mx-auto max-w-7xl">
        <h2 className="mb-10 font-heading text-[clamp(1.6rem,2.8vw,2.2rem)] font-bold leading-[1.2] tracking-[-0.02em] text-white">
          Hire developers by role
        </h2>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {ROLES.map((role) => {
            const Icon = role.icon;
            return (
              <Link
                key={role.name}
                href="/browse-talent"
                className="group flex min-h-[180px] flex-col items-center justify-center gap-5 rounded-2xl border border-[#252525] bg-white px-5 py-8 text-center no-underline transition-[border-color,background,transform] duration-200 hover:-translate-y-0.5 hover:border-remotiv-purple-light hover:bg-[#f5f5f5]"
              >
                <Icon className="size-7 fill-[#111] text-[#111]" strokeWidth={2} />
                <span className="font-sans text-[0.92rem] font-semibold leading-[1.4] text-[#111]">
                  {role.name}
                </span>
              </Link>
            );
          })}

          <div className="flex min-h-[180px] flex-col items-center justify-center gap-4 rounded-2xl border border-[#252525] bg-white px-5 py-8 text-center">
            <p className="font-sans text-base font-semibold leading-[1.4] text-[#111]">
              Looking for another role?
            </p>
            <Link
              href="/contact"
              className="inline-flex items-center gap-1.5 rounded-full bg-[#111] px-[22px] py-2.5 font-sans text-[0.82rem] font-bold tracking-[0.04em] text-white no-underline transition-colors duration-200 hover:bg-[#333]"
            >
              Place request →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
