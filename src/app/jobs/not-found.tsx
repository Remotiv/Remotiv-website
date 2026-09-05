import Link from "next/link";
import { Navbar } from "@/components/navbar";

/**
 * The job-page 404.
 *
 * Lives at the /jobs SEGMENT, not under [slug], and the position is the point.
 * A not-found.tsx catches notFound() thrown by its segment's PAGE and nested
 * layouts — never by its own layout, which renders above it (the hierarchy is
 * layout → error → loading → not-found → page). The real 404 for a dead role is
 * now thrown from [slug]/layout.tsx, before the loading boundary can commit a
 * 200, so the file that renders it has to sit one level up. Under [slug] it
 * was unreachable for exactly the case it was written for.
 */

export default function JobNotFound() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-remotiv-bg font-sans">
        <div className="mx-auto max-w-2xl px-4 py-24 text-center">
          <p className="font-heading text-sm font-semibold uppercase tracking-widest text-remotiv-purple">
            404 — Role not found
          </p>
          <h1 className="mt-4 font-heading text-3xl font-bold text-gray-900 md:text-4xl">
            We couldn&apos;t find that job
          </h1>
          <p className="mt-3 text-base text-gray-600">
            It may have been filled or closed, or the link is no longer valid. Browse our open roles
            to find your next opportunity.
          </p>
          <Link
            href="/jobs"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-remotiv-purple px-6 py-3 text-sm font-bold text-white hover:opacity-90"
          >
            Browse all jobs →
          </Link>
        </div>
      </main>
    </>
  );
}
