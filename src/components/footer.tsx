import Link from "next/link";
import { FooterCanvas } from "./footer-canvas";

const footerLinks = [
  {
    title: "Services",
    links: [
      { label: "Recruitment", href: "/services/recruitment" },
      { label: "Staff Augmentation", href: "/services/staff-augmentation" },
      { label: "Dedicated Team", href: "/services/dedicated-team" },
      { label: "Payroll Services", href: "/services/payroll" },
    ],
  },
  {
    title: "For Companies",
    links: [
      { label: "Browse Talent", href: "/talent" },
      { label: "Hire Remote", href: "/hire-remote" },
      { label: "AI Matching", href: "/ai-matching" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "For Talent",
    links: [
      { label: "Become a Talent", href: "/become-talent" },
      { label: "Become Remote-Ready", href: "/remote-ready" },
      { label: "Jobs", href: "/jobs" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About Us", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "How It Works", href: "/how-it-works" },
    ],
  },
];

const socialLinks = [
  { label: "X", href: "https://x.com/remotiv" },
  { label: "GH", href: "https://github.com/remotiv" },
  { label: "LI", href: "https://linkedin.com/company/remotiv" },
];

export function Footer() {
  return (
    <footer className="relative z-[2] bg-[#111111] pt-[180px]">
      <div className="flex flex-col justify-between gap-10 px-16 pb-10 pt-14 lg:flex-row">
        <div className="flex max-w-[300px] shrink-0 flex-col gap-4">
          <Link href="/" className="font-heading text-2xl font-bold text-remotiv-green">
            Remotiv.
          </Link>
          <p className="text-sm leading-relaxed text-[#666]">
            The platform that helps companies build high-quality engineering teams, fast.
          </p>
          <div className="mt-2 flex gap-2.5">
            {socialLinks.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="flex size-11 items-center justify-center border border-[#2e2e2e] text-xs font-semibold tracking-wide text-[#666] transition-colors hover:border-remotiv-green hover:text-remotiv-green"
              >
                {label}
              </a>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-16">
          {footerLinks.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                {group.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-[#555] transition-colors hover:text-remotiv-green"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <FooterCanvas />

      <div className="border-t border-[#1e1e1e]">
        <p className="px-16 py-5 text-center text-xs text-[#444]">
          &copy; 2026 Remotiv. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
