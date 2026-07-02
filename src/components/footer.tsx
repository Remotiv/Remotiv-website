import Link from "next/link";
import { FooterAccountColumn } from "./footer-account-column";
import { FooterCanvas } from "./footer-canvas";

// Footer row: either a navigation link (label + href) OR a non-clickable
// "Soon" row (label + soon: true, rendered with a badge instead of a Link).
type FooterRow =
  | { label: string; href: string }
  | { label: string; soon: true };

const footerLinks: ReadonlyArray<{
  title: string;
  links: ReadonlyArray<FooterRow>;
}> = [
  {
    title: "For Talent",
    links: [
      { label: "Join as Talent", href: "/join-as-talent" },
      { label: "Join as Freelancer", href: "/remote-ready" },
      { label: "Browse Jobs", href: "/jobs" },
    ],
  },
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
      { label: "Find Talent", href: "/browse-talent" },
      { label: "Find Freelancers", href: "/find-freelancers" },
      { label: "AI Talent Match", href: "/ai-matching" },
      { label: "AI Video Interviews", soon: true },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About Us", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  },
];

const socialLinks = [
  { label: "IG", href: "https://www.instagram.com/remotiv.inc/", ariaLabel: "Follow Remotiv on Instagram" },
  { label: "LI", href: "https://www.linkedin.com/company/remotiv-inc/", ariaLabel: "Follow Remotiv on LinkedIn" },
] as const;

export function Footer() {
  return (
    <footer className="relative z-[2] bg-[#111111] pt-[180px]">
      <div className="flex flex-col justify-between gap-10 px-6 pb-10 pt-14 lg:flex-row lg:px-16">
        <div className="flex max-w-[300px] shrink-0 flex-col gap-4">
          <Link href="/" className="font-heading text-2xl font-bold text-remotiv-green">
            Remotiv.
          </Link>
          <p className="text-sm leading-relaxed text-[#666]">
            The platform that helps companies build high-quality engineering teams, fast.
          </p>
          <div className="mt-2 flex gap-2.5">
            {socialLinks.map(({ label, href, ariaLabel }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={ariaLabel}
                className="flex size-11 items-center justify-center border border-[#2e2e2e] text-xs font-semibold tracking-wide text-[#666] transition-colors hover:border-remotiv-green hover:text-remotiv-green"
              >
                {label}
              </a>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-8 lg:gap-16">
          {footerLinks.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">
                {group.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    {"href" in link ? (
                      <Link
                        href={link.href}
                        className="text-sm text-[#555] transition-colors hover:text-remotiv-green"
                      >
                        {link.label}
                      </Link>
                    ) : (
                      <span className="flex items-center gap-2 text-sm text-[#555]">
                        {link.label}
                        <span className="inline-flex items-center rounded-full bg-remotiv-purple/15 px-2 py-[1px] text-[0.6rem] font-semibold text-remotiv-purple">
                          Soon
                        </span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <FooterAccountColumn />
        </div>
      </div>

      <FooterCanvas />

      <div className="border-t border-[#1e1e1e]">
        <p className="px-6 py-5 text-center text-xs text-[#444] lg:px-16">
          &copy; {new Date().getFullYear()} Remotiv. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
