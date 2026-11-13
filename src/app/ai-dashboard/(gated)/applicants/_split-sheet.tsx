import { ChevronLeft } from "lucide-react";
import { useRef } from "react";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { fullName } from "./_list-row-parts";
import { SplitPanelContent, type SplitPanelProps } from "./_split-panel";

/**
 * The Applicants Split details below 1100px real width: the panel's content as
 * a full-screen sheet over the list (commit 7; docs/design/Applicants_Split_v9.md
 * section 5, "details full screen ... useModalFocus on in this mode only").
 *
 * Unlike the 1100+ panel this IS a modal: it covers the list, so it traps
 * focus, makes the page inert, locks the page scroll and returns focus to the
 * row that opened it, all from the shared primitive. Escape and "Back to
 * applicants" both call `onClose`; the client decides what that does to the
 * history (a pushed entry is popped, a deep link is replaced, never left).
 *
 * z-[90]: under the live drawer (z-[95]) that Details opens on top of it, and
 * under the Composer and confirm dialogs (z-[100]). The modal stack makes the
 * top layer the one that answers Escape, so one press closes one layer.
 */
export function SplitSheet({ onClose, ...content }: SplitPanelProps & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true, { onClose });

  return (
    // var(--vh-full), never h-screen: inside .ai-shell's zoom, vh comes out 18%
    // short. Same frame rule as the live drawer.
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${fullName(content.row)} - applicant detail`}
      data-split-sheet
      className="fixed inset-x-0 top-0 z-[90] flex h-[var(--vh-full)] w-full flex-col bg-[var(--ai-surface)] outline-none"
    >
      <div className="shrink-0 border-b border-[var(--ai-line-soft)] bg-[var(--ai-surface)] px-[22px] pb-2.5 pt-3">
        <button
          type="button"
          onClick={onClose}
          data-split-sheet-back
          className="-ml-1.5 flex items-center gap-2 rounded-[11px] py-1.5 pl-1.5 pr-2.5 text-[12.5px] font-semibold text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
        >
          <ChevronLeft className="size-4" strokeWidth={1.6} />
          Back to applicants
        </button>
      </div>
      <SplitPanelContent {...content} />
    </div>
  );
}
