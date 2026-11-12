# Design audit - AI dashboard Applicants list

Read-only audit of `/ai-dashboard/applicants`, written as a spec for Claude Design.
Taken from the source at commit 7f767b6, 11 Nov 2026. No code was changed.

Every claim names the file and line it comes from. Where a value was worked out
rather than read (row heights, column widths), it is marked COMPUTED. Nothing was
measured in a browser.

Candidates are called "Candidate A / B". No real data appears here.

---

## 0. How to read the sizes (the zoom)

The whole dashboard sits inside `.ai-shell`, which has `zoom: 0.82`
(`src/app/ai-dashboard/ai-dashboard.css:14-30`).

- Every CSS value below is the **design value**, as written in the code.
- On screen it shows at **82%** of that. So 14px in CSS is 11.5px on screen.
- **Breakpoints are NOT zoomed.** Media queries use the real browser width. A rule
  at `min-[1049px]` changes at a real 1049px window.
- `100vh` is the unzoomed height, so the shell uses `--vh-full: calc(100vh / 0.82)`
  (`ai-dashboard.css:39`). Never use bare `h-screen` inside the shell.

Common conversions (CSS -> on screen):

| CSS | Screen | CSS | Screen | CSS | Screen |
|---|---|---|---|---|---|
| 3px | 2.5 | 13px | 10.7 | 26px | 21.3 |
| 5px | 4.1 | 13.5px | 11.1 | 30px | 24.6 |
| 7px | 5.7 | 14px | 11.5 | 32px | 26.2 |
| 9px | 7.4 | 14.5px | 11.9 | 38px | 31.2 |
| 9.5px | 7.8 | 16px | 13.1 | 40px | 32.8 |
| 10.5px | 8.6 | 18px | 14.8 | 46px | 37.7 |
| 11px | 9.0 | 19px | 15.6 | 64px | 52.5 |
| 11.5px | 9.4 | 20px | 16.4 | 104px | 85.3 |
| 12px | 9.8 | 22px | 18.0 | 236px | 193.5 |
| 12.5px | 10.3 | 24px | 19.7 | 960px | 787.2 |

In the rest of this document, sizes are written as `CSS / screen`.

---

## 1. Layout

**Files**
- Page: `src/app/ai-dashboard/(gated)/applicants/page.tsx`. It reads data on the
  server and renders `ApplicantsClient`.
- Client: `_applicants-client.tsx`. The list render is at `:5727-6215`.

**Shell around the page** (`_components/ai-shell.tsx:73-92`)
- Left sidebar: `236px / 193.5`, dark `--ai-sidebar`. It shows only at a real
  width of 840px or more (`ai-sidebar.tsx:262`). Below that it opens from a menu
  button.
- Topbar: `64px / 52.5` high, sticky, page colour at 86% with a blur
  (`ai-topbar.tsx:60`). Side padding `16px / 13.1`, or `32px / 26.2` from 840px.
- Page background: `--ai-page #F4EFEA`.

**Page container** (`_components/page-container.tsx`)
- `max-width: 1560px / 1279`, centred.
- Side padding `16px / 13.1`, or `32px / 26.2` from 840px.
- Top padding `30px / 24.6`. Bottom padding `64px / 52.5`.

**Order on the page, top to bottom** (`_applicants-client.tsx:5739-6215`)

1. **Header row** (`:5744`). Stacked below a real 525px. From 525px it is one row,
   bottom-aligned, gap `24px / 19.7`, margin below `20px / 16.4`.
   - Left side:
     - Title "Applicants": Sora 800, `32px / 26.2`, line-height 1, letter-spacing
       -0.035em (`:5746`).
     - Lede (`:5749`): DM Sans `14.5px / 11.9`, relaxed line-height, colour
       `--ai-t2`, max width `520px / 426`, `10px / 8.2` below the title. It starts
       with a count sentence (`ledeCount(view.total)`), then reads "Each new
       application is **scored against the job**, unless you've switched scoring
       off for that role." The bold phrase sits on a lime highlight sticker,
       rotated -1.2deg (`:429-435`). This is the page's one highlight.
   - Right side: two buttons, gap `9px / 7.4` (`:5759`).
     - **Export page** (`:5760-5768`): white, `1px` border `--ai-line-strong`,
       radius `12px`, padding `11px 16px`, `13.5px / 11.1` semibold, `--ai-t2`,
       15px download icon. Hover turns it dark (`--ai-sidebar`) with white text.
       While running it reads "Exporting…". It is disabled when the page is empty.
     - **Review top 10** (`:5773-5803`): dark fill `--ai-sidebar`, white, radius
       `12px`, padding `11px 17px`, `13.5px / 11.1` semibold, 15px lightning icon.
       Hover turns it purple with a purple glow `0 10px 26px rgba(126,71,255,.34)`.
       When on, it is purple and reads "Show all" (`aria-pressed`).
2. **Quota banner** (`_quota-banner.tsx`). Only owner, admin and recruiter see it,
   and only at 80% or 100% of a plan limit (`page.tsx:82-83`).
3. **Dark summary block** (`DashboardHero`, `:5810-5875`; `_components/dashboard-hero.tsx:79-105`).
   - Margin below `26px`, radius `22px`, fill `--ai-sidebar`, shadow
     `0 18px 46px rgba(20,16,32,.24)`.
   - From a real 1180px: two columns. On the left, a mint block `340px` wide
     reading "Total applicants": eyebrow `10.5px` 800 uppercase, total in Sora
     `46px / 37.7` 800, "+N this week" delta, and "Across N open roles". On the
     right, the funnel.
   - Funnel: five steps, Applied / Screening / Shortlisted / Interview / Hired,
     with Offer and Rejected left out on purpose (`:174-187`). Each step has a dot,
     a label (`11.5px` white at 55%), a number (Sora `26px / 21.3`), a `4px` bar
     and "N% of total" (`11px`, white at 38%).
   - Below a real 840px the funnel steps wrap.
4. **List panel** (`:5878`): white `--ai-surface`, `1px` border `--ai-line`,
   radius `20px / 16.4`, shadow `0 6px 30px rgba(20,16,32,.06)`, overflow hidden.
   - **Toolbar** (`:5879`): padding `14px 18px`, `1px` bottom border, gap `12px`.
     It wraps.
     - Stage tabs on the left (section 4).
     - Control cluster on the right (`:5899`), from a real 630px. Below 630px it
       takes the full width and wraps. Order: **Sort** select, **Job** select,
       **Search** box, **Add candidate**.
   - **"Top 10" banner** (`:5994`), only when Review top 10 is on.
   - **Table** (desktop) or **cards** (narrow). Section 2, and section 7 for widths.
   - **Footer** (`:6196-6215`): ranking note on the left, pager on the right.

---

## 2. Table (desktop, real width 1049px and up)

**Grid**
- It is a CSS grid of `<button>` rows, not an HTML `<table>`.
- One constant `GRID` (`_applicants-client.tsx:161-162`) is used by both the
  header row and every data row:
  `grid-cols-[46px_minmax(0,2.1fr)_1.35fr_104px_1fr_0.8fr_40px]`, gap `14px / 11.5`,
  side padding `20px / 16.4`.
- The table sits inside `min-w-[960px]` (`:6055`), with `overflow-x-auto` as a
  safety net (`:6054`).

**Header row** (`:6056-6067`)
- Fill `--ai-inset #F7F3EF`, `1px` bottom border `--ai-line`.
- Padding `11px / 9.0` top and bottom.
- Text: `10.5px / 8.6`, bold, uppercase, letter-spacing 0.08em, colour `--ai-t3`.
- Headers cannot be clicked. Sorting is done with the Sort select only.

**Column widths** (COMPUTED)
- At the widest page (container 1560): # 46, Candidate ≈472, Job ≈303, CV score
  104, Stage ≈225, Applied ≈180, end column 40 (CSS px).
- At the 960 minimum: Candidate ≈258, Job ≈166, Stage ≈123, Applied ≈98.

| # | Header | Width | Align | Shows | Truncation | Empty / fallback |
|---|---|---|---|---|---|---|
| 1 | `#` | 46px / 37.7 | left | Rank in the filtered population, padded to two digits: "01", "21" on page 2 (`:6097-6105`). Sora 800 `14px / 11.5`. Purple ink on a top match, `--ai-t4` otherwise. Turns purple on row hover. | none | - |
| 2 | `Candidate` | minmax(0, 2.1fr) | left | Avatar + name + chips, then email (or the flag reason) underneath (`:6107-6152`) | Name and email cut off with "…" on one line (`truncate`). The chips never shrink. | Name falls back to the email's local part, then "Unknown" (`:274-276`). Initials fall back to the first 2 letters of the email, then "?" (`:267-272`). |
| 3 | `Job` | 1.35fr | left | Job title pill, plus "Added by team" when the row was filed by hand (`:6158-6163`) | Title pill cuts off with "…" ("Sales Development Repr…"). The tag never shrinks. | The title comes from the live job, falling back to the title saved at apply time when the job is deleted (`applicant-types.ts:76-79`). |
| 4 | `CV score` | 104px / 85.3 | left | Score ring, or a pending state (section 3) | none | Dashed ring + "Pending" / "Failed" / "No CV text". Solid ring + "Scoring off" / "Limit reached". |
| 5 | `Stage` | 1fr | left (`justify-self-start`) | Stage pill | no wrap | "Unknown stage" in a neutral pill (`stage-pill.ts:25-28`) |
| 6 | `Applied` | 0.8fr | left | "28d ago" on top, "14 Oct" underneath (`:6172-6177`) | no wrap | "-" when the date can't be read (`:322`) |
| 7 | (blank) | 40px / 32.8 | - | **Empty.** The mock's "⋯" menu column has no content (`:6179`). | - | - |

---

## 3. Row anatomy

**The row** (`:6077-6090`)
- A full-width `<button>` using the grid above.
- Padding `13px / 10.7` top and bottom, `20px / 16.4` sides.
- Divider: `1px` `--ai-line-soft` (rgba(20,16,32,.06)). The last row has none.
- Height, COMPUTED: about 67px / 55 on screen. That is 13 + 40 (avatar) + 13 + 1.

**Avatar** (`:6108-6121`)
- Circle `40px / 32.8`, initials `13px / 10.7` bold.
- Two letters: first-name initial + last-name initial, in capitals.
- Colour: one of six tint pairs, picked by a stable hash of the applicant id, never
  by position (`:249-265`). The pairs (fill / letters): purple
  `#EEEDFE / #2E2470`, mint `#E1F5EE / #04342C`, peach `#FAECE7 / #7A3618`, sky
  `#E4EEFB / #123B6E`, amber `#FBEBCF / #7A4E05`, slate `#EDEBF0 / #4A4550`.
- Ring around it (a box-shadow): a 2px white gap, then a 1.5px ring.
  - Top match: mint `#49D7A7`.
  - Otherwise: rgba(20,16,32,.07).

**Name line** (`:6125`)
- Name: `14.5px / 11.9` bold, tight line-height, letter-spacing -0.01em, `--ai-t1`.
  Gap `8px` to the chips.
- **Top match** chip (`:6127-6129`): lime `#D9F972`, text `#2F3A00`, radius 5px,
  padding `2px 7px`, `9.5px / 7.8` 800, uppercase, letter-spacing 0.06em.
  - It shows only when the applicant is in the top-10 read AND scored ≥ 90
    (`TOP_MATCH_MIN_SCORE`, `applicant-types.ts:470`; `:4945-4953`).
- **Worth a look** chip (`:830-836`): purple outline at 45%, purple wash at 6%,
  purple text, pill shape, `9.5px` 800 uppercase.
  - It shows when the applicant met the company's auto-shortlist rule AND is still
    in Applied or Screening (`applicant-types.ts:146-151`).

**Second line**
- Normally the email: `12.5px / 10.3`, `--ai-t3`, `2px` below the name, cut off with
  "…" (`:6147-6150`).
- On a "Worth a look" row, the flag reason replaces the email, in purple
  `12.5px` medium (`:872-878`). Fallback text: "Met your auto-shortlist mark."
- **No phone number, LinkedIn or CV link appears on the list.**

**Job pill** (`:6159-6161`)
- Fill `--ai-inset`, `1px` border `--ai-line-soft`, radius 8px.
- Padding `5px 10px`, `12.5px / 10.3` semibold, `--ai-t2`.

**"Added by team" tag** (`:854-864`)
- Fill slate `#EDEBF0`, text `#4A4550`, radius 8px, padding `5px 8px`.
- `10.5px / 8.6` bold, uppercase, letter-spacing 0.05em.
- Tooltip: "Added by someone on your team. They didn't apply through the job board,
  and weren't emailed."
- Deliberately slate, not purple: purple means "you can click this" (`:839-853`).

**Score ring** (`:529-579`; spec comment at `:440-447`)
- Size `38px / 31.2`, radius 16, stroke 3.5, rounded end.
- It fills clockwise from twelve o'clock (rotated -90deg). The arc length is
  `100.53 × score / 100`.
- Track: rgba(20,16,32,.08).
- The number sits inside: Sora 800, `12.5px / 10.3`, letter-spacing -0.03em,
  even-width digits.
- Colour bands (`scoreBand`, `:449-453`). These are fixed and do not depend on the job:

  | Score | Ring | Number |
  |---|---|---|
  | 80-100 | `#49D7A7` green | `#04342C` |
  | 60-79 | `#F5A524` amber | `#7A4E05` |
  | 0-59 | `#E0524B` red | `#B02A24` |

- **Adjusted** label: when a person on the team has changed the score, the word
  "Adjusted" appears after the ring (`10px / 8.2` bold, uppercase, `--ai-t3`).
- Tooltip: "Adjusted by a member of your team", or "AI score · high confidence",
  or "AI score".
- The ring + label group has a gap of `9px / 7.4`.

**No score yet** (`:500-526`)
- Same `38px` circle with a `1.5px` border:
  - Pending / Failed / No CV text: a dashed `--ai-line-strong` border and a clock
    icon.
  - Scoring off / Limit reached: a solid `--ai-line` border on an `--ai-inset`
    fill, and a minus icon. Nothing is coming, so it must not look like a queue.
- Label `12px / 9.8` semibold, `--ai-t4`.
- A number is never invented.

**Stage pill** (`:6165-6170`; colours in `lib/stage-pill.ts:30-60`)
- Pill shape, padding `5px 12px`, `12px / 9.8` bold.
- `5px / 4.1` dot, gap `6px`.

| Stage | Fill | Text | Dot |
|---|---|---|---|
| Applied | `#EDEBF0` | `#4A4550` | `#B0AAB8` |
| Screening | `#FBEBCF` | `#7A4E05` | `#E0A020` |
| Shortlisted | `#E1F5EE` | `#04342C` | `#49D7A7` |
| Interview | `#E4EEFB` | `#123B6E` | `#4C8DD9` |
| Offer | `#EEEDFE` | `#2E2470` | `#7E47FF` |
| Hired (the only solid one) | `#49D7A7` | `#04342C` | `#04342C` |
| Rejected | `#FBEAE8` | `#B02A24` | `#E0524B` |
| Unknown | black at 6% | `--ai-t3` | `--ai-t4` |

**Applied date** (`:320-334`, `:6172-6177`)
- Top line: `13px / 10.7`, `--ai-t2`. It reads "Today", "1d ago" or "28d ago".
- Bottom line: `11.5px / 9.4`, `--ai-t4`, `1px` below, as "14 Oct" (en-GB,
  2-digit day, short month, no year).
- On the first server render the date is formatted in UTC. After the page
  hydrates it uses the reader's own clock and time zone, to avoid a hydration
  mismatch (`:280-316`).

---

## 4. States

**Row states** (`:6080-6106`)

| State | Background | Left bar (3px, purple `#7E47FF`) | Other |
|---|---|---|---|
| Default | white | hidden | rank `--ai-t4` |
| Hover | `#FCFBFA` (a hard-coded hex) | fades in | Shadow `0 6px 22px rgba(20,16,32,.07)`, row raised (`z-2`), rank turns purple |
| Selected (drawer open on this row) | `--ai-purple-tint #EEEDFE` | always on | - |
| Worth a look | purple at 3.5% | always on, so flagged rows can be spotted while scrolling | Selected wins if both apply |
| Keyboard focus | unchanged | unchanged | Global rule: `2px` solid purple outline, `2px` offset (`src/app/globals.css:300-304`). POSSIBLE: clipped at the panel's left and right edges by `overflow-hidden` / `overflow-x-auto` (not checked in a browser). |

**Whole-list states**
- **Drawer open**: the whole list fades to 30% and can't be clicked (`:5739-5741`).
  The drawer makes everything outside it inert (`useModalFocus`).
- **Updating** after a filter change: the old rows stay on screen at 50% opacity
  with `aria-busy`, and are not cleared (`:6029-6032`). Counts in the tabs and the
  summary block also dim to 50%.
- **Loading** (route skeleton, `loading.tsx`):
  - A pulsing `--ai-line-soft` block for the title, and a copy of the summary block.
  - A panel with a `36px` toolbar bar and 5 placeholder rows: `40px` circle, two
    text lines, a `38px` circle and a `96×28` block, with padding `13px 20px`.
  - Note: the skeleton has **no header row, no rank column, no job column and no
    date column**, so the layout jumps when the data arrives.
- **Empty and error** (`:5656-5715`, drawn at `:5974-5987`): an icon tile `66px`
  (purple tint, 20px radius, 28px people icon), a title in Sora 800 `19px / 15.6`,
  and text `13.5px / 11.1` `--ai-t3`, max width `340px`. Padding `60px` top, `64px`
  bottom. The copy, checked in this order:
  1. Read failed: "We couldn't run that search" / "A different spelling won't help - this is on our side, not your query. Reload the page to try again."
  2. Search with no hits: "No applicants match “…”" / "Try a different name or email, or clear your search to see everyone."
  3. Reader is on no jobs: "You haven't been assigned to any roles yet" / "You'll see applicants for the roles you're on. Ask an owner or admin to add you to a job's hiring team."
  4. Company has no applicants: "No applicants yet" / "When someone applies to one of your published roles, they'll appear here - scored and ranked by your AI recruiter."
  5. Otherwise: "Nothing in this view" / "No applicants match this stage or role filter. Switch tabs to see everyone."
- **Unknown counts**: a count that couldn't be read shows as "-", never "0"
  (`counts-state.ts:206-208`).

**Stage tabs** (`_stage-tabs.tsx`)
- The strip: `--ai-inset` fill, `1px` `--ai-line` border, radius `11px`, padding
  `3px`. It wraps onto more rows on narrow screens and never scrolls sideways
  (`:57-67`).
- Chips in order: All, Applied, Screening, Shortlisted, Interview, Offer, Hired,
  Rejected, then **Flagged**.
- Each stage chip: radius 8px, padding `7px 14px`, `12.5px / 10.3` semibold, plus a
  count badge (`10.5px` bold, pill shape, black at 7%).
  - Active chip: dark fill, white text, shadow `0 3px 10px rgba(20,16,32,.2)`.
  - Inactive chip: `--ai-t3`, `--ai-t1` on hover.
- Flagged is a toggle (`aria-pressed`) that works together with any stage. It is
  outlined: pill shape, `--ai-line-strong` border, white fill. Its purple badge
  shows only when the count is above 0.

**Toolbar controls** (`:240-241`, `:5908-5973`)
- Selects: radius `10px`, `1px` `--ai-line` border, padding `8px 30px 8px 12px`,
  `12.5px` semibold, `--ai-t2`. Focus: purple border plus a `3px` purple ring at 14%.
  - Sort options: "Best match" (the default) and "Newest first".
  - Job options: "All jobs" plus every job the company has.
- Search: `210px / 172` wide from a real 630px, at least `160px` below that.
  Padding `7px 12px`, 15px search icon, `13px` input text, placeholder
  "Search applicants…".
- **Add candidate**: purple fill, white, radius `10px`, padding `8px 13px`, `13px`
  bold, plus icon.
  - Only owner, admin and recruiter see it (`canCreateJobs`, `:4264`).
  - When there are no jobs it is shown but disabled, at 45% opacity, with the
    tooltip "Create a job first - a candidate has to be added to a role."

**"Top 10" banner** (`:5994-6012`)
- Purple-tint fill, padding `10px 20px`.
- Text `12.5px` semibold purple-ink: "Showing the top N scored applicants of M."
- A "Show all applicants" link on the right.

**Footer** (`:6196-6215`)
- Fill `--ai-inset`, `1px` top border, padding `13px 20px`.
- Left text, `12.5px / 10.3` `--ai-t3`:
  - Best match: "Ranked by AI score. Anything without a score sits at the end."
  - Newest first: "Newest first. Scores don't affect this order."
- Pager on the right (`:724-788`):
  - Range text "**1–20** of 57" (`12.5px` semibold `--ai-t2`, the range in bold
    purple), plus "(filtered from N)" in `--ai-t3` when a filter is on.
  - Previous and Next buttons (`32px / 26.2` squares, radius 8px, white, 1px
    border) with "page / pages" between them. They show only when there is more
    than one page.
  - There are no numbered page links and no "jump to page".

---

## 5. Typography and colour tokens

**Fonts**
- **Sora** (`font-heading`): title, rank, score number, summary-block figures,
  empty-state title.
- **DM Sans** (`font-sans`): everything else.
- Both are loaded in `src/app/layout.tsx:2-16`.

**Sizes used on this page** (weight in brackets)
- 9.5 (800): chips
- 10 (700): "Adjusted"
- 10.5 (700/800): header row, tags, badges, eyebrow
- 11 / 11.5: funnel and date sub-line
- 12 (600/700): stage pill, pending label
- 12.5 (500/600): email, job pill, tabs, selects, footer, pager
- 13 (400/700): applied date, search, Add candidate, initials
- 13.5 (600): header buttons, empty-state text
- 14 (800): rank
- 14.5 (400/700): lede, name
- 19 (800): empty title
- 26 (800): funnel numbers
- 32 (800): page title
- 46 (800): total applicants

On screen, multiply each by 0.82.

**Colour tokens** (`ai-dashboard.css:41-77`, scoped to `.ai-shell`, deliberately
not `@theme`)

| Group | Tokens |
|---|---|
| Base | `--ai-sidebar #141020`, `--ai-page #F4EFEA`, `--ai-surface #FFFFFF`, `--ai-inset #F7F3EF` |
| Lines | `--ai-line rgba(20,16,32,.09)`, `--ai-line-soft .06`, `--ai-line-strong .16` |
| Text | `--ai-t1 #17131F`, `--ai-t2 #4A4550`, `--ai-t3 #847E8C`, `--ai-t4 #B0AAB8` |
| Tint pairs | purple `#EEEDFE` / `#2E2470`; mint `#E1F5EE` / `#04342C`; amber `#FBEBCF` / `#7A4E05` (dot `#E0A020`); peach `#FAECE7` / `#7A3618`; sky `#E4EEFB` / `#123B6E`; slate `#EDEBF0` / `#4A4550` |
| Brand (global) | `remotiv-purple #7E47FF`, `remotiv-green #49D7A7`, `remotiv-lime #D9F972` |

**Hard-coded colours on this page** (not tokens)
- Row hover `#FCFBFA`.
- Score bands `#49D7A7`, `#F5A524`, `#E0524B`, `#04342C`, `#7A4E05`, `#B02A24`.
- Top-match text `#2F3A00`.
- Rejected `#FBEAE8` / `#B02A24`.
- Interview dot `#4C8DD9`.
- Purple hover `#6d38ec`.

---

## 6. Sizes

Every value above is written as `CSS / screen`. The table in section 0 converts the
rest. One rule of thumb: **screen = CSS × 0.82**, and breakpoints are in real
pixels and are not scaled.

---

## 7. Responsive

All widths are the real browser width.

| Real width | What changes |
|---|---|
| below 525 | Header stacks: the title and lede, then the buttons under them (`:5744`) |
| below 630 | Toolbar controls take the full width and wrap. The job select is capped at 45%. Search is at least 160px (`:5899`, `:5925`, `:5934`). |
| below 840 | No sidebar (opens from a menu). Container padding 16 instead of 32. Funnel steps wrap. |
| below 1049 | **The table is replaced by cards.** |
| 1049 and up | Grid table |
| 1180 and up | The summary block becomes two columns (340px mint + funnel) |

**Cards** (`ApplicantCard`, `:880-996`)
- Same information, stacked, and **no horizontal scroll**. The card padding is
  `16px` and each card is a full-width `<button>`.
- Line 1: rank + 40px avatar + name and chips, with email (or flag reason)
  underneath.
- Line 2: job pill + "Added by team".
- Line 3: score ring on the left, stage pill on the right.
- Line 4: "Applied 28d ago · 14 Oct" (`11.5px / 9.4`, `--ai-t4`).
- The same selected and flag left bar, and the same pager below.

**At a real 375px phone**
- The zoomed layout is about 457 CSS px wide (375 / 0.82). After the container
  padding, about 425 CSS px are left for the panel.
- There is no sidebar. Cards are shown.
- The stage chips wrap onto about 3 rows. The sort, job and search controls wrap
  under the tabs.

**How the swap works** (`:6038`, `:6054`)
- The two views carry `data-twin-narrow` and `data-twin-wide`.
- They are hidden by Tailwind classes AND by an inline style in the **root**
  `src/app/layout.tsx:101`:
  `@media(min-width:1049px){[data-twin-narrow]{display:none}}@media(max-width:1048px){[data-twin-wide]{display:none}}`.
- To move the breakpoint, change both places, or one view will show twice or not
  at all.

---

## 8. Behaviour the design must keep

**Opening an applicant**
- Clicking a row (or card) opens the side drawer. The URL becomes
  `?applicant=<id>&tab=<profile|review|comm|interviews|timeline|comments>`
  (`list-state.ts:486-509`, `_applicants-client.tsx:4677-4691`).
- The URL is changed with `history.replaceState`, so a shared link opens the same
  applicant and the same tab.
- The drawer has Previous and Next applicant buttons that move through the filtered
  population, across page boundaries (`:1777-1789`).

**List URL**
- `q`, `job`, `stage`, `flagged=1`, `sort=newest`, `page`, `top=1`
  (`list-state.ts:342`, `:428-481`).
- The first server render reads the URL, so a refresh keeps the filters
  (`page.tsx:25-46`).

**Sorting** (server side)
- "Best match" orders by `effective_score`, which is the team's adjusted score when
  there is one, otherwise the AI score. Applicants without a score come last.
- "Newest first" orders by apply date.

**Filters** (all server side)
- Stage tab, the Flagged toggle (which works with any stage), the job select, and
  search.
- Search matches name and email, without case, and is sent `250ms` after typing
  stops (`list-state.ts:57`). Maximum 120 characters.
- Changing a filter goes back to page 1.

**Review top 10**
- Its own server read, limited to 10 (`TOP_SCORED_LIMIT`, `applicant-types.ts:456`).
  It narrows within the current filters and always fits on one page.
- If that read failed, a toast says so instead of showing an empty table
  (`:5783-5790`).

**Export page**
- A CSV of **the current page only** (at most 20 rows, `CSV_EXPORT_MAX`), with
  screening answers.
- If any applicant's answers can't be read, no file is written and an error toast
  appears (`:5600-5654`).
- File name: `applicants-page-<n>-<YYYY-MM-DD>.csv`.

**Add candidate**
- Opens a modal form. It needs at least one job.

**No bulk actions**
- There are no checkboxes and no multi-select.

**Paging**
- Server paging, **20 rows per page** (`APPLICANT_PAGE_SIZE`,
  `applicant-types.ts:492`). The database returns at most 20 rows, and at most 20
  rows are drawn.
- A job with 2,500 applicants is 125 pages. There is no virtual scrolling and none
  is needed.
- Counts (the totals, each tab, Flagged) are counted in the database across the
  whole population, never from the 20 visible rows.

---

## 9. Accessibility (findings)

**Markup**
- Rows are `<button>`s in a CSS grid, not a `<table>`.
- The header row is plain `<span>`s, so screen readers get **no column headers**.
  Each row button reads as one long string: rank, initials, name, email, job, score,
  stage and date.
- POSSIBLE improvement: `role="table"` / `row` / `columnheader` / `cell`, or a real
  `<table>` with a button or link in the name cell.
- **Nothing clickable may go inside a row**, because rows are `<button>`s. A nested
  `<button>` broke hydration once already (`:799-829`). That is why the "Worth a
  look" dismiss is in the drawer.

**Labels**
- Sort, job filter and search have `aria-label` (`:5911`, `:5920`, `:5940`).
- Pager arrows have `aria-label` (`:753`, `:768`).
- Flagged and Review top 10 have `aria-pressed`.
- **The stage tab chips do not**: the selected tab is shown by colour only
  (`_stage-tabs.tsx:143-152`). POSSIBLE fix: `aria-pressed` or `aria-current`.
- The score ring SVG is `aria-hidden`. The number is real text.
- Score and tag tooltips use `title`, which keyboard and screen-reader users don't
  get.

**Focus**
- A global purple outline, `2px` with a `2px` offset (`globals.css:300-304`).
  There is no row-specific focus style.

**Contrast** (COMPUTED, WCAG ratio)

| Colour | Ratio | Where it is used | Verdict |
|---|---|---|---|
| `--ai-t4 #B0AAB8` on white | 2.26 | rank numbers, the "14 Oct" sub-line, pending labels, card date | **Fails AA** |
| `--ai-t4` on inset | 2.05 | - | **Fails AA** |
| `--ai-t3 #847E8C` on white | 3.93 | email line `12.5px`, footer text | **Fails AA** for small text (needs 4.5) |
| `--ai-t3` on inset | 3.56 | header row `10.5px` | **Fails AA** |
| `--ai-t3` on hover `#FCFBFA` | 3.80 | - | **Fails AA** |
| Purple on white | 4.96 | - | Passes |
| Every stage pill, the Top-match chip, the score numbers | 5.6-13.7 | - | Pass |

- The score ring arcs (green, amber, red) are told apart by colour only. The number
  carries the meaning, so this is acceptable, but don't drop the number.

---

## 10. Constraints for Claude Design

### Must not change (product and privacy rules)

**What the list shows**
- **Data**: rank, name, email, job title, "Added by team", score, stage, applied
  date. **No phone, no LinkedIn, no CV link on the list.** Those stay in the drawer.

**Scoring display**
- Fixed bands: 80 and up green, 60-79 amber, below 60 red.
- "Top match" only at **≥ 90** and only inside the top-10 read.
- An unscored row **never shows a number**. It shows the pending, failed, no-text,
  scoring-off or limit state.
- "Adjusted" marks a score a person changed.
- "Top match" (lime, filled, the AI's view) and "Worth a look" (purple outline, the
  company's rule) must never look alike.

**Counts and copy**
- Unknown counts show "-", never "0".
- Copy uses hyphens, not em dashes. The pager range uses an en dash, "1–20"
  (`:747`). Keep or swap it on purpose.

**Ranking and paging**
- The footer note that explains the order is part of the honesty rule. Keep it,
  per sort.
- Paging, sorting, filtering and counts are server-side and limited to 20 rows. Do
  not design anything that needs the whole population in the browser: "select all",
  client-side sort by column header, infinite scroll of every applicant.

**Interaction**
- A row is one big button that opens the drawer. Nothing clickable inside it.
- The drawer URL params `applicant` and `tab` and the list params `q`, `job`,
  `stage`, `flagged`, `sort`, `page`, `top` are public link formats people have
  shared. Keep the names and values.
- "Add candidate" is the only control in the toolbar that writes, and it stays last.

### Fragile (handle with care)

**Zoom and breakpoints**
- **Zoom**: everything is designed at CSS size and shows at 82%. Specs from a mock
  drawn at 1.0 will look 22% bigger in the app unless converted.
- **Breakpoints** are real-width: 525, 630, 840, 1049, 1180. The 1049 one is
  duplicated in the root layout's inline style (section 7).
- **vh**: inside the shell use `--vh-full`, not `100vh`.

**Tokens and global CSS**
- **Tokens** are scoped to `.ai-shell` in `ai-dashboard.css`, on purpose not in
  `@theme`. Adding `@theme` tokens leaks them into the marketing site.
- **Global CSS bleed**:
  - `globals.css` sets a border-colour default on every element and the purple
    focus outline on every element.
  - The root layout's inline style forces the html/body background and the
    `data-twin` rules.
  - A new list component inside the shell gets all of these.

**Shared code**
- **One `GRID` string** is shared by the header and the rows. Change both together,
  or the columns stop lining up.

**Tests that pin source text** (they read the file text, not the rendered page)
- `applicants/search-floor.test.ts` (search box classes)
- `applicants/stage-tabs.test.ts`
- `applicants/drawer-header.test.ts`
- `applicants/screening-export.test.ts`
- `_components/a11y-wiring.test.ts`
- `lib/copy-honesty.test.ts`
- `lib/ai/cv-scoring-cap-wiring.test.ts`
- `lib/interview-cap-wiring.test.ts`
- `ai-dashboard/lib/company-roles.test.ts`

A redesign that renames classes or copy will turn these red, and they must be
updated in the same change.

**Hydration**
- Dates use the server clock, then the browser's. Any new time display must use
  the same `PageClock` (`:280-316`), or it will cause hydration mismatches.

**File size**
- `_applicants-client.tsx` is 6,571 lines and also holds the drawer. Work on the
  list touches the same file as the drawer.
