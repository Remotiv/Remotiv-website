import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 py-20 text-center">
      <p className="font-heading text-sm font-semibold uppercase tracking-wider text-remotiv-purple mb-4">
        404 — Page Not Found
      </p>
      <h1 className="font-heading text-4xl md:text-5xl font-bold text-[#111] mb-4 max-w-2xl">
        We couldn&apos;t find that page.
      </h1>
      <p className="font-sans text-base text-[#666] mb-8 max-w-md">
        The page you&apos;re looking for may have moved, been removed, or never existed.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-full bg-remotiv-purple px-7 py-3.5 font-heading text-sm font-bold text-white transition-colors hover:bg-[#6a3ad9]"
        >
          Go to homepage
        </Link>
        <Link
          href="/contact"
          className="inline-flex items-center justify-center rounded-full border-[1.5px] border-[#111] bg-transparent px-7 py-3.5 font-heading text-sm font-bold text-[#111] transition-colors hover:bg-[#111] hover:text-white"
        >
          Contact us
        </Link>
      </div>
    </div>
  );
}
