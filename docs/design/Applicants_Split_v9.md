# Applicants Split v9 - developer handoff

Design file: `Applicants_Split_v9.html` (open in a browser; all frames and states, interactive).
Specs it follows: `DESIGN-AUDIT-APPLICANTS-LIST.md`, `DESIGN-AUDIT-APPLICANTS-DRAWER.md`, `CLAUDE-DESIGN-BRIEF-APPLICANTS-LIST.md`.

**Sizes are CSS sizes** (before the dashboard's 82% zoom). Breakpoints are real browser widths. Desktop frame = 1440 px window = 1756 CSS px wide.

Legend: **Product** = changes a rule in the brief / needs backend data or a decision. **Visual** = look only. **Same** = live component and sizes, no change. **Different** = a change to build.

## 1. Changes vs live

Product = a rule in the brief changes, needs your OK and backend data. Visual = look only.

| Type | What | Live | New | Note |
|---|---|---|---|---|
| Visual | Applicants layout | Full-width table; row opens a slide-in drawer, list fades to 30% | Split: list 400px on the left, panel always open on the right (gap 18px; 1038 CSS px at a 1440 px window). Below 1100 px real width: list only - the same Split list item, full width - and a row opens the details full screen. No table at any width: the old 1049 px table/card switch is removed for this page (Tailwind classes + the data-twin rule in root layout.tsx:101). | Brief 7.4 · drawer audit §10 |
| Visual | Page header | "Applicants" title + lede with lime highlight | Job header: 48px logo, job title (Sora 800 32px, -0.035em), meta line. Export page + Review top 10 kept on the right. | Brief 4.1 |
| Product | Summary block | Dark block: total + 5-step funnel | Not shown on this page | Confirmed |
| Product | Shortlist button | - | Dark button in the panel top row. Stage Applied / Screening: shown, any role (hiring managers too - canChangeStage allows Shortlisted). Shortlisted or later: hidden. Saving: spinner, "Shortlisting…", aria-busy, Stage select disabled. Success toast "`<name>` moved to Shortlisted". Error toast "Couldn't shortlist `<name>` - nothing changed." + Try again; stage unchanged. Rejected: shown for owner / admin / recruiter; hidden for a hiring manager (Stage read-only). | Confirmed write action |
| Product | Job select | In the toolbar, "All jobs" default | One job at a time - no "All jobs". Opens on the newest open job the viewer can see. Stays the live native `<select>`: two optgroups, "Open" then "Closed", newest first in each. | Confirmed. Type-ahead covers long lists. Possible later: a "Filter jobs…" box |
| Product | List item data | Rank, name, email, job, Added by team, score, stage, applied date | Name · AI verdict line (scored only; 12.5px --ai-t2, max 2 lines) - when there is no verdict, the email shows in its place (12.5px --ai-t3, live email style) · location and years (each only when filled) · "Applied X ago" · "Screening X/Y met" in neutral --ai-t3, never green (only when the job has screening questions) · Added by team · score ring. No rank, email, job or stage on rows. | Fields exist; location and years are empty for company applicants today. Most common today (~2 in 3): name, email, applied, no-score ring |
| Visual | Row alignment | Grid rows, ring vertically centred | Ring and avatar vertically centred in every row, so short and tall rows stay balanced |  |
| Product | "New" dot and "N new" count | - | Removed | Data does not exist |
| Visual | Score in list | 38px ring | Same 38px ring and bands (unchanged) |  |
| Visual | --ai-t3 / --ai-t4 text (this page, list and panel) | #847E8C / #B0AAB8 | #625C6A / #6E6876 (AA on white, inset and purple tint) | Also fixes the drawer audit's contrast fails for the same text in the panel |
| Visual | Focus ring on list items | Global, offset 2px | Inset, offset -2px |  |
| Visual | Selected stage tab | Colour only | Adds aria-pressed and weight 700 |  |
| Product | Viewer has no jobs | Live empty message inside the table panel | No job header, toolbar or split - "Applicants" title + the live message full width | Uses the live copy |

## 2. Right panel vs the live drawer

Same = live component and sizes, no change. Different = a change to build.

| Type | What | Live drawer | Split panel | Note |
|---|---|---|---|---|
| Same | Panel header | White, 1px --ai-line bottom border, padding 16px top / 22px sides | Same |  |
| Same | Avatar, name, identity line | 54px avatar (Sora 800 18px, purple 10% ring); name Sora 800 21px, lh 1.15, -0.03em, truncates; identity 12.5px 500 --ai-t3: email bold --ai-t2 · location · "Applied 9 Nov 2026", 3px dots | Same |  |
| Same | Header score | 42px mini ring (r18, stroke 4, slate track), Sora 800 14px; band label 12.5px bold "Strong match / Moderate match / Needs review"; "Adjusted" 11px; 1×36px divider; no ring when unscored; hidden below a real 525px | Same | Replaces the v5 96px score box |
| Same | Stage control | Label 11.5px bold --ai-t3 + native select: radius 11, --ai-inset, 1px --ai-line, 9px 34px 9px 30px, 13px bold, 7px dot, neutral colour, purple focus ring | Same | Replaces the v5 coloured stage pill. Hiring-manager read-only rule stays |
| Different | Top row | "Back to applicants" (left) · Previous / "N of M" / Next · Close X (30px icon buttons, radius 11) | Left: Shortlist (dark --ai-sidebar fill) and Details (white, --ai-line-strong border, radius 11, 13.5px bold). Right: Previous / "N of M" / Next kept. No Back, no Close - nothing to close. | New buttons; Shortlist writes (confirmed) |
| Different | Tabs | 6 tabs: Profile · Review · Communication · Interviews · Timeline · Comments | No tabs in the panel. "Details" opens the live drawer, unchanged, with all 6 tabs and the same URL params. | Drawer audit §3 untouched |
| Same | Body and cards | --ai-inset body, padding 18 / 22 / 28; white cards radius 20, 1px --ai-line, shadow 0 6px 30px .06, padding 20px 22px; titles Sora 700 15px -0.02em; meta 11px 500 --ai-t3; 14px under the head | Same | Gap between cards 16px (not stated in the audit) |
| Same | "Worth a look" banner | Lime, radius 16, padding 13px 16px, 30px disc, Sora 700 13px #2F3A00 + reason 12px at 70%, 26px dismiss | Same, on top of the panel body |  |
| Same | Summary card | Review tab: card "Summary", meta "Generated from the CV…", body 13px lh 1.72 --ai-t2 | Same, title "Summary"; shown first, without opening Review |  |
| Same | Scored dimensions | Sub-head Sora 700 15px + hairline; rows 200px \| 8px bar \| Sora 800 25px score + "/100" 12px; reasoning 12.5px --ai-t2 under the bar; 4 AI names; single column below a real 840px | Same |  |
| Different | Must-haves | Review evidence: "Must-haves met" box (purple pill, count N/M) and a separate "Missing requirements" box (danger); rows 12.5px, 16px icon, "View evidence" reveals the quote in italics with a left rule | Same "Must-haves met" style (purple pill, N/M, purple check, "View evidence"). Difference: not-found must-haves sit in the same card, neutral. Strengths (mint), Missing requirements and Risks stay in the drawer. | Confirmed: one card |
| Same | Screening questions | Card, intro line 11.5px, bordered answer boxes (radius 12, 11px 13px), question 12px --ai-t3, "Essential" pill, answer 14px bold, "Meets / Below threshold" slate / amber, never green | Same | Replaces the v5 mint/amber tick list |
| Same | Application card | "Applied to job · 2d ago" 13px; manual-row chip + "Not emailed…" note; Open CV (purple, link) + Email (outline, opens Composer), radius 12, 11px 12px, 13px bold | Same | Replaces v5 "View CV" and "Message" buttons |
| Same | Details card | Rows 13.5px, label --ai-t3 / value bold, 9px padding: Location, Experience, Notice period, Availability, Phone, LinkedIn - each only if present | Same component; panel shows Location, Experience, Notice period | Availability, Phone, LinkedIn stay in the drawer |
| Different | Drawer-only parts | Danger card, Review score card (112px ring, verdict, confidence, Adjust / Re-score), Strengths / Risks, Communication, Interviews, Timeline, Comments | Not in the panel - reached through "Details" |  |
| Different | Unscored | Review card: centred unscored block from unscoredCardState, dashed while in progress, invisible border otherwise | Same block: dashed for Pending ("Scoring this CV"), solid/invisible for No CV text ("No readable CV text"). Then Screening (if any), Application and Details. With no screening: Application and Details side by side; with no details either: Application full width. | Real copy comes from unscoredCardState |
| Different | Frame and behaviour | Fixed overlay, max 1100px, no radius, shadow to the left, role="dialog" aria-modal, focus trap, list inert, Escape closes | A page column: radius 20, 1px --ai-line, list shadow. role="region" aria-label "`<name>` - applicant detail"; no trap, list stays clickable, Escape does nothing (still closes Composer and dialogs above). The drawer opened by "Details" keeps its live behaviour. | Drawer audit §10.1-10.3 |
| Different | Opening state | Drawer opens only on a row click; URL ?applicant=&tab= | First row is selected in state on load; the URL is written only on a click. Clicking down the list keeps the panel on summary data, so Interviews reads don't fire per row. | Drawer audit §10.4, 10.9 |
| Different | Scrolling | Fixed full-height frame; body is the only scroller; page scroll locked | Panel column is sticky (top 80px) at full height minus the 64px topbar and gaps: height calc(var(--vh-full) - 64px - 32px). Header stays; body scrolls on its own (overflow-y auto, overscroll contained). The list scrolls with the page. | Drawer audit §10.7. Never h-screen inside the shell |
| Different | Below 1100 px real width | Overlay at 96% width at every size | List only (Split list item, full width, no table). A row opens the panel content as a full-screen sheet with "Back to applicants" (useModalFocus on only in this mode). 840 / 525 px rules as live | Drawer audit §10.5, 10.6. The list's own 1049px table/card switch still applies |
| Different | Small notes | --ai-t4 #B0AAB8, Danger note 10px (2.26:1) | Panel notes use --ai-t3 #625C6A (6.45:1); no --ai-t4 text at 10px in the panel. The 10px Danger note stays in the drawer only. | Contrast |
| Different | Removed from the panel (were in v5) | - | Facts row with icons, 96px score box, coloured stage pill, "…" menu, mint/amber screening ticks | All replaced by the live components above |

## 3. Changes I had to undo

| Earlier Split page | Now |
|---|---|
| Score shown as plain "92 match" text | Live 38px score ring with fixed bands |
| Filter pills: Best match first, Stage, Location, Years of experience, Skills, CV score 80+ | Live toolbar: stage tabs + Flagged, Sort select, Job select, Search, Add candidate (no new server filters) |
| Purple "new" dot and purple matching-skill chips | Dot removed (no data); must-haves use the live purple "Must-haves met" style (mint is for Strengths in the drawer) |
| Pill-shaped buttons (radius 999px) | Live button radius 12px |
| Cards radius 16px, own shadow | Live panel: radius 20px, 1px --ai-line, shadow 0 6px 30px rgba(20,16,32,.06) |
| No pager, list scrolled | Live footer: ranking note + pager, 20 per page |
| Top match flag on the first person by default | Top match only in Review top 10, only at 90+ |
| Page drawn inside a 0.82 zoom | Drawn at CSS size |
| v5 panel: 96px score box, coloured stage pill | Live mini ring + band label, live neutral Stage select |
| v5 panel: mint ticks on screening answers | Live "Meets / Below threshold" pills - self-reported data never looks verified (green) |
| v5 panel: "View CV" and "Message" buttons | Live "Open CV" (purple link) and "Email" (opens Composer) |
| v7 list: rows with no verdict had only "Applied X ago" under the name | Email fills the second line (live list data) so the most common row stays balanced |
| v6 list: "Screening X/Y met" in mint (green) | Neutral --ai-t3 - self-reported data never looks verified |
| v6 panel: must-haves "found" in mint | Live "Must-haves met" purple style - mint means Strengths in the drawer |
| v6 panel: card title "Why this match" | Live title "Summary", same as the drawer behind Details |
| v5 panel: name Sora 24px, cards radius 20 with 24px 26px padding, section titles 16px | Live sizes: name 21px, card padding 20px 22px, titles Sora 700 15px |

> **Top match - build note (commit 5c):** the build keeps the LIVE rule, not the "only in Review top 10" wording in this file. An applicant who is in the top-10 read and scores 90 or more gets the Top match chip in the normal list too, exactly as the live page does today.


No new fonts or radii. New colour uses: purple tint (the live "Must-haves met" style) for found must-haves, --ai-sidebar fill for Shortlist - both existing tokens.

## 4. States in the design file

1. **Most common row today - about 2 in 3 applicants** - Real data: location and years are empty for company applicants today, only ~35% are AI-scored and ~32% have screening. So the usual row is: name, email, "Applied X ago", and a no-score ring (dashed + clock = Pending; solid + minus = nothing coming). No verdict, no location line, no screening line. The email fills the second line so short rows keep the same rhythm, and the ring is centred. The panel beside it: unscored block, then Application and Details side by side (only Notice period filled).
2. **List item data variants** - Verdict line only when scored. Location and years only when filled - the line is hidden when both are empty, never a "-". "Screening X/Y met" only when the job has screening questions.
3. **List item states** - Default · hover (#FCFBFA, soft shadow, purple bar fades in) · selected (#EEEDFE, bar on) · Worth a look (3.5% purple wash, bar on) · keyboard focus (inset 2px ring, never clipped). Each item is one button - nothing clickable inside it.
4. **Score states (same ring as live)** - Fixed bands: 80-100 green, 60-79 amber, 0-59 red. "Adjusted" when a person changed it. No score never shows a number: dashed + clock = something is coming; solid + minus = nothing is coming.
5. **Top 10 view and long content** - Review top 10 on: button turns purple and reads "Show all", banner above the list. Top match chip + mint avatar ring only here, only at 90+. Long names are cut with "…"; the verdict line wraps to 2 lines then cuts.
6. **Loading** - List: skeleton rows in the real shape. Panel: like the live drawer, there is no whole-panel skeleton - the header renders straight from the list row, and each card shows pulsing bars until its read returns.
7. **Updating after a filter change** - Old list items stay at 50% with aria-busy; the details keep showing the selected person until the new list arrives.
8. **Unscored in the details** - The details never invent a score. Left: Pending with screening answers. Right: No CV text, nothing else filled - the unscored block is solid, and Application takes the full width.
9. **Empty and error** - The 5 live messages, same order. When the list is empty, the details area is hidden and the message spans the full width.
10. **Footer variants** - Below the list: the ranking note per sort, then the pager (20 per page, server side).
11. **Panel on load - first row auto-selected** - When the page opens without ?applicant=, the first row in the current order is selected in state, so the panel is never blank. The URL is written only when the viewer clicks a row (replaceState, no extra history). If the list is empty, the panel is hidden and the empty message spans the full width (see "Empty and error").
12. **Shortlist button states** - Follows the live canChangeStage rules. Shortlisted is allowed for every role, including hiring managers. The button is hidden (not disabled) when it can't do anything, so there is never a dead control; the Stage control beside it already says where the applicant is.
13. **Breakpoints - real browser width** - This page has no table any more. The old 1049 px table/card switch is removed for this page (both the Tailwind classes and the data-twin rule in the root layout.tsx:101 - change both together).
14. **Details - must-haves** - Live "Must-haves met" style: purple pill title, count N/M, evidence rows 12.5px with a 16px round icon, "View evidence" (aria-expanded) reveals the verbatim CV quote in italics with a left rule. Found = purple check; not found = neutral, in the same card. Mint is kept for Strengths (drawer only).
15. **Details - job without screening questions** - The Screening questions card is hidden (same rule as the live drawer); the summary line drops "and N screening answers".
16. **Job select - long list** - The live native `<select>`, unchanged control. One job at a time: no "All jobs". Opens on the newest open job the viewer can see. Two `<optgroup>`s: "Open" then "Closed", newest first in each. Type-ahead jumps through long lists. The open menu on the right shows the grouping only - the browser draws the real menu.
17. **Viewer has no jobs** - No job header, no toolbar, no split - the live title and the live empty message, full width.

Plus the main frames: **Desktop** (1440 px window, interactive: click a list row to switch the panel; Previous/Next; "Details" opens the existing drawer, unchanged) and **Below about 1100 px real width** (list, then details full screen; shown at a 375 px phone).

## 5. Breakpoints (real browser width)

| Real width | What shows |
|---|---|
| 1100 px and up | **Split**: list column 400 CSS px (the Split list item) + panel always open beside it. Panel is sticky, full height minus the 64px topbar, scrolls on its own. |
| 840 - 1099 px | **List only**, full width, with the sidebar. The same Split list item, stretched - no table. A row opens the **details full screen** (same panel content as a full-screen sheet with "Back to applicants"; useModalFocus on in this mode only). |
| below 840 px | Same, without the sidebar (menu button), container padding 16. |
| below 525 px | Same, plus the header score ring is hidden in the details (live rule). |

**The old 1049 px table/card switch is removed for this page** - there is no table at any width. Remove both the Tailwind classes and the data-twin rule in the root `layout.tsx:101` together.

## 6. Out of scope (unchanged, not redesigned)

- The live side drawer and all 6 tabs (opened by "Details").
- Toolbar controls: Sort, Job, Search, Add candidate (shown as dashed "existing" boxes).
