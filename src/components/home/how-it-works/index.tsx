import { Step1ChatMockup } from "./step-1-chat-mockup";
import { Step2Candidates } from "./step-2-candidates";
import { Step3Video } from "./step-3-video";

export function HowItWorks() {
  return (
    <section className="bg-white px-6 py-[72px] font-[var(--font-sans)] sm:px-12">
      {/* Header */}
      <div className="mb-12 text-center">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-[#9886FE]">
          How it works
        </div>
        <h2 className="mx-auto mb-3 font-heading text-[28px] font-black leading-[1.1] tracking-[-0.03em] text-[#111] sm:text-[36px]">
          How Remotiv works
        </h2>
        <p className="mx-auto max-w-[480px] text-[15px] leading-[1.65] text-[#777]">
          From browsing to building — find and hire top remote talent in days, not months.
        </p>
      </div>

      {/* Top Row - Two Cards */}
      <div className="mx-auto mb-5 grid max-w-[1060px] gap-5 lg:grid-cols-[45fr_55fr]">
        <Step1ChatMockup />
        <Step2Candidates />
      </div>

      {/* Bottom Row - Purple Card */}
      <Step3Video />
    </section>
  );
}
