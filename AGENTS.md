<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Standing Constraints

These are hard rules, not preferences.

- **Never echo any part of a credential — not the value, not a prefix, not a truncated sample, not a pattern label.** If a probe or sweep needs to report which secret it used, report the variable name only (e.g. `SUPABASE_SERVICE_ROLE_KEY`), never its contents. This covers project-identifying URLs too. Watch for the indirect leaks: `execFileSync`/`execSync` error messages embed the full argv, and a "safe" truncation such as `cut -c1-12` is still part of the secret.

- **When driving a browser against production, never read generic text out of the DOM.** Whitelist the attributes and shapes you need — ids, ordinals, scores, dates, counts — and return only those. Never read `aria-label`, button text, row text or the page title from a list of real candidates, and take no screenshots of real data. Refer to an applicant by the last six characters of its id. Watch for the indirect leaks: a probe that collects every `button` label to find a control, or an `aria-label` read on a drawer, returns candidate names into the transcript — scope the selector first, then read.

- **A test run is not green until the test count proves it ran.** `node --test` exits 0 when it executes nothing, so an exit code alone is never evidence. Always report the file count and the test count, and always cross-check the file count against `find src -name '*.test.ts' | wc -l` — a suite that shrank is a suite that silently stopped covering something. The specific trap that has produced four false greens in a row: **the shell here is zsh, which does not word-split an unquoted variable**, so `FILES=$(find ...); node --test $FILES` passes one argument containing newlines, matches no file, and reports `tests 0` with exit 0. Use node's own glob, quoted, so the shell never touches it: `node --test "src/**/*.test.ts"`. The same applies to any `$(...)` list piped into a command expecting separate arguments.

## Learned User Preferences

- When converting a design (HTML/Figma), match the original pixel-for-pixel — padding, colors, font sizes, content, and layout must be exact; the user repeatedly flags discrepancies in navbar, hero, footer, inquiry form, and outer page padding
- Port full HTML content verbatim — do not summarize or abbreviate sections when rebuilding pages
- Use design token classes (e.g. `bg-remotiv-green`) instead of hardcoded hex values in components
- Remove obvious/redundant JSX comments like `{/* Left */}` or `{/* CTA */}` — code should be self-documenting
- Replace nested ternaries with extracted functions or `cn()` calls for conditional classNames
- Extract repeated className strings into module-level constants (DRY)
- Use Biome for linting and formatting — do not use ESLint or Prettier
- Run `/simplify` skill after feature implementation to clean up code
- When given a plan file with pre-created todos, execute todos sequentially and never edit the plan file itself
- Task is done only when both `next build` and Biome lint pass with zero errors
- Commit and push only when explicitly asked; use private GitHub repos by default

## Learned Workspace Facts

- Stack: Next.js 16 + TypeScript + Tailwind CSS v4 + shadcn/ui (base-nova style) + App Router
- Fonts: Sora (headings, `font-heading` class) + DM Sans (body, `font-sans` class) via `next/font/google`
- Brand colors as Tailwind tokens: `remotiv-green` (#49D7A7), `remotiv-green-light` (#3bc494), `remotiv-purple` (#7E47FF), `remotiv-purple-light` (#9886fe), `remotiv-lime` (#D9F972), `remotiv-lime-card` (#c9ff85), `remotiv-bg` (#f8f4f1)
- Biome config at project root with `css.parser.tailwindDirectives: true` for Tailwind v4 at-rules; `.vscode/settings.json` sets `css.lint.unknownAtRules: "ignore"`
- GitHub: private repo `HarisJavedskipq2022/remotiv`
- Component layout: shared components in `src/components/`, homepage sections in `src/components/home/`
- Original design source: `Remotiv_Homepage.html` at workspace root — the ground truth for all visual matching
- Use Next.js `<Link>` from `next/link` for all internal navigation — never raw `<a>` tags (Biome a11y + Next lint flag this)
- Prefer Tailwind utility classes over arbitrary values that alias them — use `font-heading` / `font-sans`, not `font-[var(--font-heading)]` (Biome flags duplicate CSS output)
- Prefer functional state updates (`setX(prev => ...)`) inside `useEffect`/`useCallback` to keep dependency arrays minimal
- SVG `<title>` must contain non-empty text for a11y — omit the element entirely if no label is needed
- All app routes are statically prerendered at build time; dev server: `npx next dev --port 3000`
