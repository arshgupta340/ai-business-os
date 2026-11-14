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

## U-02 API client and mock layer (2026-11-13)

`packages/contracts` (S-02) had not merged when this was built. `apps/web/lib/api/pending-contracts.ts` and `api-shapes.ts` are temporary transcriptions of docs/CONTRACTS.md and docs/API.md. They get replaced by imports from `@abos/contracts` once S-02 merges.

### Mock mode without a service worker

MSW normally runs as a service worker. Some browsers refuse to register one (embedded webviews, some private windows). `apps/web/mocks/browser.ts` falls back to answering API calls in the page with the same handlers, so mock mode behaves the same either way. The service worker path itself was not exercised in a browser yet. The Playwright task (U-14) will cover it.

### Choices made where the docs were silent or disagreed

- `LiveAgent`: `agentId` and `agentVersionId` are optional (API.md 3.12 and SPEC 2.9). CONTRACTS.md still shows them as required.
- `GET /api/businesses` items carry only `id`, `name`, `category`, `timezone`. Other `Business` fields are optional on the list item.
- The builder session response includes `progress` (API.md 3.3). The CONTRACTS `BuilderSession` type does not have it.
- `POST /api/agents/:id/pause` has no documented body. The client returns nothing and the hook refetches.
- A `price_edit` approval's `subjectId` is derived in the mock as `cat_<variation id>`. The UI never reads it.
- `facts/propose` with `resolvesConflictId` on a `menu_item` conflict returns `VALIDATION_FAILED` in the mock. The docs say it is a price change and name no error.
- A proposed fact with no verified row gets `before: null` and `fromVersion: 0`.
- Deciding an `EXPIRED` approval returns `APPROVAL_EXPIRED`. The same decision sent twice returns 200.
- A network failure surfaces as `ApiError` with code `INTERNAL`, `retryable: true`, status 0. No new error code was added.
- `stopConditions` is always empty in the mock. Its code values are not listed anywhere.

### Still missing from the contract (not blocking the first screens)

- No endpoint lists a business's uploaded files. After a reload, uploads can only be rebuilt from `fact.fileId` and `extraction.completed` events.
- No read for the action executions or sync jobs of an approval or order. Step progress comes only from `execution.*` events.
- No message status for a booking confirmation. `OrderCheckout` covers orders only.
- No `GET` for a single fact.

### Not verified

- The real Supabase Realtime subscription (no Supabase values).
- The React hooks are typechecked and used through MSW in tests, but not rendered in a component test.
- In a production build, the MSW code sits in lazy chunks that real mode never loads. It is not removed from the output.
