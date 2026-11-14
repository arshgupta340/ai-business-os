# Notes: Saina's side

Unverified assumptions and deviations, per AGENTS.md "Quality bar".

## U-01 web shell (2026-11-13)

### Deviation: Astryx instead of Tailwind and shadcn/ui

SPEC 3.1 and 3.2 say the web app uses Tailwind CSS and shadcn/ui. Saina decided the whole UI uses Meta's Astryx design system only (`@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@stylexjs/stylex`, `@astryxdesign/cli`, all 0.7.16). No Tailwind, no shadcn, no other UI kit. SPEC 3.1 and 3.2 should be updated to match by pull request.

- Theme: neutral, mode `system` (light and dark).
- No StyleX compiler is configured. Screens use component props and tokens only.
- Heroicons was not installed even though the Astryx templates suggest it. The shell and sign-in page use no icons.
- The unscoped npm name `astryx` is not used. The CLI runs as `npm run astryx -- <cmd>`.

### Assumptions

- **Business fields.** docs/CONTRACTS.md has no written `Business` type. docs/API.md (reconciled version) says `Business` carries `contact: { phone?, email?, address? }`, and the `GET /api/businesses` list item has `id`, `name`, `category`, `timezone`. The web type `BusinessSummary` in `apps/web/lib/session/businesses.ts` has those four fields plus optional `contact`. The seeded list leaves `contact` out because the list endpoint does not return it. `address` is assumed to be a string (CONTRACTS.md convention: a field without a type is a string). Categories `restaurant` and `barbershop` come from docs/DATA-MODEL.md 6.1. When packages/contracts exports `Business`, import it there.
- **Demo owner.** Mock mode signs in "Demo Owner", `owner@example.com` (the placeholder email in docs/API.md). The real seeded owner email comes from `SEED_OWNER_EMAIL` and is not known to the web app.
- **Owner display name.** Real mode reads `display_name`, `full_name` or `name` from Supabase user metadata, else the email. Whether the seed sets any of these is not verified.
- **getAccessToken in mock mode** always returns `mock-token`, even when signed out. The guard keeps signed-out owners on `/sign-in`, so this only matters for code that runs outside the shell.
- **Connection health** shows "Mock mode" or a neutral "Checking". There is no health endpoint wired yet.

### Not verified

- Real Supabase sign-in. No Supabase values were available. Only the missing-config path and mock mode were run.
- apps/web is now a workspace of the root (`@abos/web`) and uses the root's vitest 5. npm audit still reports 2 issues, both in the postcss copy bundled inside next. They are build tooling and do not ship to the browser.
- The neutral theme loads Figtree from Google Fonts. Offline demos fall back to a system font.
