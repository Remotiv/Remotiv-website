import { ActionChat, ActionOverlap, ChatCheck } from "@/components/icons";

export function Step2Candidates() {
  return (
    <div className="flex flex-col rounded-[24px] bg-[#F8F4F1] p-6 sm:p-8">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#9886FE]">
        Step 02
      </div>
      <h3 className="mb-2 font-heading text-[20px] font-black leading-[1.15] tracking-[-0.02em] text-[#111]">
        Review your top 5 matches
      </h3>
      <p className="mb-4 text-[13px] leading-[1.65] text-[#666]">
        Within 24 hours, our AI and senior recruiters hand-pick the best-fit candidates.
      </p>
      <ul className="mb-4 flex flex-col gap-2">
        <li className="flex items-center gap-2 text-[13px] text-[#444]">
          <ChatCheck />
          AI scans thousands of profiles instantly
        </li>
        <li className="flex items-center gap-2 text-[13px] text-[#444]">
          <ChatCheck />
          Human vetting ensures quality
        </li>
        <li className="flex items-center gap-2 text-[13px] text-[#444]">
          <ChatCheck />
          Matched on skills, timezone & culture fit
        </li>
      </ul>

      {/* Candidate Stack */}
      <div className="mt-auto flex flex-col gap-2.5">
        <div className="flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-sm">
          <div className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[#d4ede8]">
            {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
            <img
              src="/team-avatars/hassan-malik.webp"
              alt="Hassan Malik"
              width={36}
              height={36}
              className="h-full w-full rounded-full object-cover"
            />
          </div>
          <span className="flex-1 text-[13px] font-medium text-[#111]">Hassan Malik</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8] sm:size-[30px]"
            >
              <ActionOverlap />
            </button>
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8] sm:size-[30px]"
            >
              <ActionChat />
            </button>
          </div>
        </div>
        <div className="ml-2.5 flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-sm">
          <div className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[#e8e0f8]">
            {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
            <img
              src="/team-avatars/sara-qureshi.webp"
              alt="Sara Qureshi"
              width={36}
              height={36}
              className="h-full w-full rounded-full object-cover"
            />
          </div>
          <span className="flex-1 text-[13px] font-medium text-[#111]">Sara Qureshi</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8] sm:size-[30px]"
            >
              <ActionOverlap />
            </button>
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8] sm:size-[30px]"
            >
              <ActionChat />
            </button>
          </div>
        </div>
        <div className="ml-5 flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-sm">
          <div className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[#f5e0dc]">
            {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
            <img
              src="/team-avatars/ali-rehman.webp"
              alt="Ali Rehman"
              width={36}
              height={36}
              className="h-full w-full rounded-full object-cover"
            />
          </div>
          <span className="flex-1 text-[13px] font-medium text-[#111]">Ali Rehman</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8] sm:size-[30px]"
            >
              <ActionOverlap />
            </button>
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8] sm:size-[30px]"
            >
              <ActionChat />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
