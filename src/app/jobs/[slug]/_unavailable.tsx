/**
 * Shown when the role could not be READ, never when it is missing.
 *
 * Deliberately unbranded. This renders before the Remotiv/white-label branch,
 * so it cannot know whose page it is standing in for — anything naming a
 * company here would be wrong half the time.
 *
 * Its own file because two things render it: the [slug] layout, which sees a
 * failed lookup before anything streams, and the page, which keeps its own
 * guard as defence in depth. A page module may not export a component, so
 * sharing it means moving it.
 */
export function RoleUnavailable() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6 py-24 text-center">
      <h1 className="font-heading text-2xl font-bold text-gray-900">This role didn&apos;t load</h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">
        Something went wrong fetching it — the role itself is fine. Refresh the page, or try again
        in a moment.
      </p>
    </main>
  );
}
