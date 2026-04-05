import Link from "next/link";

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

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

const socialLinks = [
  { label: "X", href: "https://x.com/remotiv", icon: XIcon },
  { label: "GitHub", href: "https://github.com/remotiv", icon: GitHubIcon },
  { label: "LinkedIn", href: "https://linkedin.com/company/remotiv", icon: LinkedInIcon },
];

export function Footer() {
  return (
    <footer className="bg-[#111111] pt-[180px]">
      <div className="mx-auto max-w-7xl px-6 pb-16 lg:px-8">
        <div className="flex flex-col gap-12 lg:flex-row lg:justify-between">
          <div className="max-w-xs shrink-0">
            <Link href="/" className="font-heading text-2xl font-bold text-remotiv-green">
              Remotiv.
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-[#666]">
              The platform that helps companies build high-quality engineering teams, fast.
            </p>
            <div className="mt-6 flex gap-3">
              {socialLinks.map(({ label, href, icon: Icon }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="flex size-10 items-center justify-center rounded-md border border-[#2e2e2e] text-[#888] transition-colors hover:border-remotiv-green hover:text-remotiv-green"
                >
                  <Icon />
                </a>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:gap-12">
            {footerLinks.map((group) => (
              <div key={group.title}>
                <h3 className="text-sm font-semibold text-white">{group.title}</h3>
                <ul className="mt-4 space-y-3">
                  {group.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-sm text-[#666] transition-colors hover:text-remotiv-green"
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

        <div className="relative mt-16 h-24 overflow-hidden rounded-lg" aria-hidden="true">
          <div className="absolute inset-0">
            {Array.from({ length: 40 }).map((_, i) => (
              <div
                key={`dot-${i.toString()}`}
                className="absolute size-1 rounded-full bg-remotiv-green/20"
                style={{
                  left: `${(i * 2.5) % 100}%`,
                  top: `${(i * 37) % 100}%`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-[#1e1e1e]">
        <p className="py-6 text-center text-sm text-[#555]">
          &copy; 2026 Remotiv. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
