"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error.tsx] Caught error:", error);
  }, [error]);

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 py-20 text-center">
      <p className="font-heading text-sm font-semibold uppercase tracking-wider text-red-600 mb-4">
        Something went wrong
      </p>
      <h1 className="font-heading text-4xl md:text-5xl font-bold text-[#111] mb-4 max-w-2xl">
        We hit an unexpected error.
      </h1>
      <p className="font-sans text-base text-[#666] mb-8 max-w-md">
        Try again, or email us at{" "}
        <a
          href="mailto:hello@remotiv.com"
          className="text-remotiv-purple underline-offset-4 hover:underline"
        >
          hello@remotiv.com
        </a>{" "}
        if the problem continues.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex items-center justify-center rounded-full bg-remotiv-purple px-7 py-3.5 font-heading text-sm font-bold text-white transition-colors hover:bg-[#6a3ad9]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-full border-[1.5px] border-[#111] bg-transparent px-7 py-3.5 font-heading text-sm font-bold text-[#111] transition-colors hover:bg-[#111] hover:text-white"
        >
          Go to homepage
        </Link>
      </div>
    </div>
  );
}
