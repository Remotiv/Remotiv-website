import type { LIVE_PRIVACY_SECTION } from "@/lib/interviews/live-consent";

/**
 * Section 15 of the privacy page, AI video interviews, rendered from the one
 * copy of its text (lib/interviews/live-consent.ts). The page renders it, and
 * its link from section 1, only when livePrivacySection() returns it: never
 * while a placeholder is left in the text.
 */
export function LiveInterviewsSection({ section }: { section: typeof LIVE_PRIVACY_SECTION }) {
  return (
    <section id={section.id} className="scroll-mt-28">
      <h2 className="mt-14 mb-4 font-heading text-[1.45rem] font-extrabold tracking-[-0.02em] text-[#111]">
        {section.number}. {section.title}
      </h2>
      {section.blocks.map((block) => {
        if (block.kind === "h3") {
          return (
            <h3
              key={block.text}
              className="mt-8 mb-3 font-heading text-[1.05rem] font-bold text-[#111]"
            >
              {block.text}
            </h3>
          );
        }
        if (block.kind === "p") {
          return (
            <p key={block.text} className="mb-4 text-[0.98rem] leading-[1.75] text-[#3f3f46]">
              {block.text}
            </p>
          );
        }
        return (
          <ul
            key={block.items.map((i) => i.lead).join("|")}
            className="mb-4 flex list-disc flex-col gap-2 pl-5 text-[0.98rem] leading-[1.7] text-[#3f3f46]"
          >
            {block.items.map((item) => (
              <li key={item.lead}>
                <strong className="font-semibold text-[#111]">{item.lead}</strong> - {item.text}
              </li>
            ))}
          </ul>
        );
      })}
    </section>
  );
}
