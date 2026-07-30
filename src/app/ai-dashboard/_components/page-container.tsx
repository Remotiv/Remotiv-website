/**
 * The single definition of the /ai-dashboard page frame.
 *
 * Deliberately a component rather than a class on the shell's <main>: the
 * wizard renders a full-bleed sticky sub-topbar as a SIBLING of its content,
 * and that bar needs the full main width plus its own padding. Putting the
 * frame on <main> would trap it inside the 1560px column and double its
 * horizontal padding. As a component, a page wraps only the parts that should
 * be constrained and leaves full-bleed chrome outside it.
 *
 * No page should ever declare this class string itself — duplicating it across
 * pages is exactly how the wizard drifted to 1400px/26px in the first place.
 *
 * `w-full` is load-bearing, not decorative. This box is a flex item (the shell
 * renders `flex min-h-full flex-col`, and the wizard nests another column flex
 * container). In a COLUMN flex container the cross axis is horizontal, and an
 * auto cross-axis margin overrides `align-self: stretch` — so `mx-auto` alone
 * makes the item size to fit-content and centre, instead of filling. Measured:
 * 483px inside a 768px parent. `w-full` restores a definite cross size, and
 * `max-w` still caps it while `mx-auto` centres the remainder.
 *
 * This was the real cause of the wizard's "wrong" column widths: the grid's
 * `200px minmax(0,1fr) 280px` was always correct, but it was resolving inside
 * a box that had already shrink-wrapped.
 */
export function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1560px] px-4 pb-16 pt-[30px] min-[840px]:px-8">
      {children}
    </div>
  );
}
