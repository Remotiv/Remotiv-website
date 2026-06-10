import Link from "next/link";
import { Navbar } from "@/components/navbar";

export default function ProfileNotFound() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-remotiv-bg font-sans">
        <div className="mx-auto max-w-2xl px-4 py-24 text-center">
          <p className="font-heading text-sm font-semibold uppercase tracking-widest text-remotiv-purple">
            404 — Profile not found
          </p>
          <h1 className="mt-4 font-heading text-3xl font-bold text-gray-900 md:text-4xl">
            We couldn&apos;t find that talent profile
          </h1>
          <p className="mt-3 text-base text-gray-600">
            The profile may have been removed, or the link is no longer valid.
            Browse our full marketplace to find vetted talent.
          </p>
          <Link
            href="/browse-talent"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-remotiv-purple px-6 py-3 text-sm font-bold text-white hover:opacity-90"
          >
            Browse all talent →
          </Link>
        </div>
      </main>
    </>
  );
}
