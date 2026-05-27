// Route-level loading state shown during navigation to /account while the
// server component runs auth.getUser() + admin_users check + subscriptions
// query (3 sequential Supabase awaits). Block-shaped placeholders mirror the
// real page layout: avatar header → current-plan card → account-details card.

export default function AccountLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading account"
      className="min-h-screen bg-remotiv-bg motion-safe:animate-pulse"
    >
      <div className="mx-auto max-w-[720px] px-5 pb-20 pt-10">
        {/* Avatar header — 64px circle + display name + email */}
        <div className="mb-8 flex items-center gap-4">
          <div className="size-16 shrink-0 rounded-full bg-remotiv-purple/30" />
          <div>
            <div className="mb-2 h-6 w-40 rounded-md bg-black/[0.08]" />
            <div className="h-3.5 w-52 rounded bg-black/[0.06]" />
          </div>
        </div>

        {/* Current plan card */}
        <div className="mb-4 rounded-xl border border-black/[0.08] bg-white p-5">
          <div className="mb-4 flex items-start justify-between">
            <div>
              {/* "CURRENT PLAN" small-caps label */}
              <div className="mb-2 h-3 w-24 rounded bg-black/[0.06]" />
              {/* Plan name + Active badge */}
              <div className="mb-2 flex items-center gap-2.5">
                <div className="h-5 w-16 rounded bg-black/[0.08]" />
                <div className="h-5 w-14 rounded-full bg-remotiv-green/20" />
              </div>
              {/* Price · started date */}
              <div className="h-3 w-36 rounded bg-black/[0.06]" />
            </div>
            {/* Subscribe / Upgrade button placeholder */}
            <div className="h-9 w-24 rounded-lg bg-black/[0.06]" />
          </div>

          {/* Credits usage bar — shown for subscriber tier */}
          <div className="border-t border-black/[0.06] pt-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="h-3 w-36 rounded bg-black/[0.06]" />
              <div className="h-3 w-28 rounded bg-black/[0.06]" />
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
              <div className="h-full w-[40%] rounded-full bg-remotiv-purple/20" />
            </div>
            <div className="mt-2 h-3 w-28 rounded bg-black/[0.06]" />
          </div>
        </div>

        {/* Account details card */}
        <div className="rounded-xl border border-black/[0.08] bg-white p-5">
          {/* "ACCOUNT" section label */}
          <div className="mb-3.5 h-3 w-16 rounded bg-black/[0.06]" />

          {/* Email row */}
          <div className="flex items-center justify-between border-b border-black/[0.06] py-2.5">
            <div>
              <div className="mb-1.5 h-3.5 w-10 rounded bg-black/[0.08]" />
              <div className="h-3 w-48 rounded bg-black/[0.06]" />
            </div>
          </div>

          {/* Password row */}
          <div className="flex items-center justify-between border-b border-black/[0.06] py-2.5">
            <div>
              <div className="mb-1.5 h-3.5 w-16 rounded bg-black/[0.08]" />
              <div className="h-3 w-24 rounded bg-black/[0.06]" />
            </div>
            <div className="h-3 w-14 rounded bg-black/[0.06]" />
          </div>

          {/* Sign out row */}
          <div className="flex items-center justify-between py-2.5">
            <div>
              <div className="mb-1.5 h-3.5 w-16 rounded bg-black/[0.08]" />
              <div className="h-3 w-28 rounded bg-black/[0.06]" />
            </div>
            <div className="h-8 w-20 rounded-lg border border-black/[0.08]" />
          </div>
        </div>
      </div>
    </div>
  );
}
