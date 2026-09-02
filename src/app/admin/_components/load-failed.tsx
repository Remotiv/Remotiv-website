"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * The admin surfaces' one failure state.
 *
 * One component rather than a string per page, on purpose. Every admin list
 * has the same reader, the same fear (none — an operator suspects an empty
 * inbox, and can check the logs) and the same remedy. Five bespoke sentences
 * would be five chances to drift for no one's benefit; the only thing that
 * differs between them is the noun.
 *
 * Retry rather than "reload the page": router.refresh() re-runs the server
 * read in place, which is the cheaper action, and every admin page is a
 * server-rendered list so it is always available here.
 *
 * Says nothing about how the surface works. "Submissions from the public
 * contact form will appear here" is right for a genuinely empty inbox and a
 * guarantee the page is breaking when the read failed — see the note above
 * `Read<T>` in src/lib/supabase/read.ts.
 */
export function LoadFailed({ what }: { what: string }) {
  const router = useRouter();
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-14 text-center"
    >
      <p className="text-sm font-medium text-gray-700">We couldn&apos;t load the {what}.</p>
      <p className="mt-1 text-xs text-gray-400">Nothing&apos;s been lost — this is on our side.</p>
      <button
        type="button"
        onClick={() => router.refresh()}
        className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-80"
      >
        <RotateCw className="size-3.5" /> Retry
      </button>
    </div>
  );
}
