<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Learned User Preferences

- When converting a design (HTML/Figma), match the original pixel-for-pixel — padding, colors, font sizes, content, and layout must be exact; the user will check and correct discrepancies repeatedly
- Use design token classes (e.g. `bg-remotiv-green`) instead of hardcoded hex values in components
- Remove obvious/redundant JSX comments like `{/* Left */}` or `{/* CTA */}` — code should be self-documenting
- Replace nested ternaries with extracted functions or `cn()` calls for conditional classNames
- Extract repeated className strings into module-level constants (DRY)
- Use Biome for linting and formatting — do not use ESLint or Prettier
- Run `/simplify` skill after feature implementation to clean up code
- Commit and push only when explicitly asked; use private GitHub repos by default

## Learned Workspace Facts

- Stack: Next.js 16 + TypeScript + Tailwind CSS v4 + shadcn/ui (base-nova style) + App Router
- Fonts: Sora (headings, `font-heading` class) + DM Sans (body, `font-sans` class) via `next/font/google`
- Brand colors as Tailwind tokens: `remotiv-green` (#49D7A7), `remotiv-green-light` (#3bc494), `remotiv-purple` (#7E47FF), `remotiv-purple-light` (#9886fe), `remotiv-lime` (#D9F972), `remotiv-lime-card` (#c9ff85), `remotiv-bg` (#f8f4f1)
- Biome config at project root with `css.parser.tailwindDirectives: true` for Tailwind v4 at-rules
- VS Code `.vscode/settings.json` has `css.lint.unknownAtRules: "ignore"`
- GitHub: private repo `HarisJavedskipq2022/remotiv`
- Component layout: shared components in `src/components/`, homepage sections in `src/components/home/`
- Original design source: `Remotiv_Homepage.html` at workspace root — the ground truth for all visual matching
- Dev server: `npx next dev --port 3000`
