import { ChatCheck } from "@/components/icons";

export function Step1ChatMockup() {
  return (
    <div className="flex flex-col rounded-[24px] bg-[#F8F4F1] p-6 sm:p-8">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#9886FE]">
        Step 01
      </div>
      <h3 className="mb-2 font-heading text-[20px] font-black leading-[1.15] tracking-[-0.02em] text-[#111]">
        Tell us your requirements
      </h3>
      <p className="mb-4 text-[13px] leading-[1.65] text-[#666]">
        Share your requirements in 2 minutes. No long forms, no back-and-forth.
      </p>
      <ul className="mb-4 flex flex-col gap-2">
        <li className="flex items-center gap-2 text-[13px] text-[#444]">
          <ChatCheck />
          Define role, seniority & skills
        </li>
        <li className="flex items-center gap-2 text-[13px] text-[#444]">
          <ChatCheck />
          Set budget and timezone
        </li>
        <li className="flex items-center gap-2 text-[13px] text-[#444]">
          <ChatCheck />
          Remote or on-site preferences
        </li>
      </ul>

      {/* Chat UI Mockup */}
      <div className="mt-auto rounded-[16px] bg-white p-3 shadow-sm">
        <div className="mb-2 flex gap-2">
          <div className="flex flex-col items-center gap-1">
            <div className="flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-[#e8e0f8]">
              {/* biome-ignore lint/performance/noImgElement: tiny 1.9KB local WebP, simpler than next/image here */}
              <img
                src="/team-avatars/aisha.webp"
                alt="Aisha"
                width={38}
                height={38}
                className="h-full w-full rounded-full object-cover"
              />
            </div>
            <span className="text-[10px] text-[#888]">Aisha</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-[#d4ede8]">
              {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
              <img
                src="/team-avatars/rayan.webp"
                alt="Rayan"
                width={38}
                height={38}
                className="h-full w-full rounded-full object-cover"
              />
            </div>
            <span className="text-[10px] text-[#888]">Rayan</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-[#f5e0dc]">
              {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
              <img
                src="/team-avatars/sara.webp"
                alt="Sara"
                width={38}
                height={38}
                className="h-full w-full rounded-full object-cover"
              />
            </div>
            <span className="text-[10px] text-[#888]">Sara</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div
            className="flex items-end gap-1.5 animate-[popIn_500ms_ease-out_both]"
            style={{ animationDelay: "300ms" }}
          >
            <div className="max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-[#F9DE6F] px-3 py-2 text-[11px] leading-[1.5] text-[#333] sm:text-[12px]">
              Senior React dev, remote, UTC+5.
            </div>
            <span className="mb-0.5 text-[10px] text-[#aaa]">10:21</span>
          </div>
          <div
            className="flex items-end gap-1.5 animate-[popIn_500ms_ease-out_both]"
            style={{ animationDelay: "500ms" }}
          >
            <div className="max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-[#F9DE6F] px-3 py-2 text-[11px] leading-[1.5] text-[#333] sm:text-[12px]">
              Budget $4k/mo. Start ASAP.
            </div>
            <span className="mb-0.5 text-[10px] text-[#aaa]">10:22</span>
          </div>
          <div
            className="flex flex-row-reverse items-end gap-1.5 animate-[popIn_500ms_ease-out_both]"
            style={{ animationDelay: "700ms" }}
          >
            <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-[#C9FF85] px-3 py-2 text-[11px] leading-[1.5] text-[#333] sm:text-[12px]">
              Shortlist ready in 24 hrs!
            </div>
            <span className="mb-0.5 text-[10px] text-[#aaa]">10:23</span>
          </div>
        </div>
      </div>
    </div>
  );
}
