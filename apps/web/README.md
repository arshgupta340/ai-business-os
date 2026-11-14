# apps/web

The owner dashboard. Next.js 15 App Router, React 19, TypeScript strict. No API routes: the app calls the server at `NEXT_PUBLIC_API_URL`.

The whole UI uses Meta's Astryx design system and nothing else. No Tailwind, no shadcn, no other UI kit, no icon packs. This overrides docs/SPEC.md 3.2 (see docs/notes-saina.md).

## Run

```bash
cd apps/web
npm install
npm run dev:mock      # NEXT_PUBLIC_MOCK=1, no backend, no Supabase
npm run dev           # real mode, needs apps/web/.env.local (copy .env.example)
npm run typecheck
npm test
npm run build
```

Mock mode: the sign-in page shows a "Mock mode" notice. Any email and password, or the "Continue as demo owner" button, sign in the demo owner. The session is kept in localStorage (`abos.mockSession`). `getAccessToken()` returns `mock-token`.

Real mode without `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the sign-in page shows a configuration error. Nothing crashes.

## Where things live

| Path | What |
|---|---|
| `app/(dashboard)/<route>/page.tsx` | One screen per route. Each is a placeholder you replace. |
| `app/(dashboard)/layout.tsx` | Wraps every screen in `DashboardShell` (sidebar, top bar, sandbox banner, sign-in guard). |
| `app/icon.svg` | The app icon. Next.js serves it as the favicon. |
| `app/sign-in/page.tsx` | Sign-in. Outside the dashboard group. |
| `components/` | Shared building blocks (below). |
| `components/shell/` | Shell parts. `useShellBadges()` sets the Approvals count. |
| `components/providers/AppProviders.tsx` | Theme, links, auth, `ApiProvider` (React Query, plus the mock API in mock mode), `ApiBusinessProvider` and `SessionErrorHandler`. |
| `lib/session/` | `useBusiness()`, `BusinessProvider`, `ApiBusinessProvider`, seeded businesses, the sign-in notice. |
| `lib/session/auth/` | `useAuth()`, `getAccessToken()`. |
| `lib/supabase/client.ts` | `getSupabaseBrowserClient()`, null when not configured. |
| `lib/api/`, `mocks/` | Typed API client, React Query hooks and the MSW mock layer. Read `lib/api/README.md`. |

## Shared components

Import from `@/components` (or the single file).

- `PageHeader` `{title, description?, actions?}`. The page h1. Start every screen with it.
- `LoadingState` `{label?}`
- `EmptyState` `{title, description?, icon?, actions?, headingLevel?}`
- `ErrorState` `{message, title?, onRetry?, retryLabel?}`. Shows a retry button when `onRetry` is set.
- `StatusBadge` `{label, tone}`, tone `neutral | info | warning | danger | success`. `success` (green) is only for states the server or provider confirmed. Never green before the provider confirms.
- `SandboxBadge`. Put it next to any payment data: totals, payment links, payment status.
- `SessionNotice`. Shows once why the owner landed on /sign-in (for example "Your session ended"). The sign-in page renders it.

## Shell on narrow screens

`AppShell` switches to its mobile layout below the `md` breakpoint (768px). The top bar then shows the app name and the menu button only. The menu (a drawer) holds the business selector, the connection health badges, the owner name with Sign out, and the sections. The sandbox banner stays above the top bar at every width. `TopBarStartContent` and `TopBarEndContent` (from `@/components/shell`) do this with `useTopNavRenderMode()`. Screens do not need to do anything.

## Signed out and wrong business

`SessionErrorHandler` (mounted once in `AppProviders`) listens to every failed API call through the QueryClient:

- `UNAUTHENTICATED`: the owner is signed out, cached data is cleared and the app goes to /sign-in, which shows "Your session ended. Sign in again to continue."
- `FORBIDDEN_BUSINESS`: that business leaves the selector and the selector moves to a business the owner has. The businesses list is refetched.

Hooks still return their errors, so a screen can show its own error state as before. Do not add a second redirect in a screen.

## Shared helpers

- `statusView(machine, state)` and `conflictView(status, required)` from `@/lib/status`. They map every server state to `{label, tone}`. Use them with `StatusBadge` so a state looks the same on every screen. Do not write your own state to color mapping.
  - Machines: `order`, `booking`, `approval`, `execution`, `syncJob` (the Sheets report), `messageDispatch`, `call`, `callStage`, `agent`, `fact`, `fileExtraction`, `integration`, plus `feed` (the `useActivityFeed` status, never green), `catalogSync` (a Square catalog sync job, same states as `syncJob`) and `builderSession` (`active`, `completed`, `abandoned`).
  - `factView(kind, status)` is `statusView('fact', status)` except a `menu_item` draft, which shows `MENU_ITEM_DRAFT_VIEW` ("Menu draft, for comparison only").
- `formatMoney(amountMinor, currency)`, `formatDateTime(iso, timeZone)`, `formatTime`, `formatDate`, `formatRelative`, `secondsUntil`, `formatCountdown`, `lastFour` from `@/lib/format`. Money is in minor units on the wire. Show times in `business.timezone`.

## Hooks

```tsx
const {businesses, business, businessId, setBusinessId} = useBusiness(); // from '@/lib/session'
const {status, owner, signIn, signOut, isMock, configError} = useAuth(); // from '@/lib/session/auth'
const {setPendingApprovalsCount} = useShellBadges(); // from '@/components/shell'
```

`businesses` comes from `GET /api/businesses` once the owner is signed in. While it loads, when it fails, or when signed out, it is the seeded list. `businessId` defaults to `biz_pizza_01` and is kept in localStorage. `business` has `id`, `name`, `category`, `timezone` and an optional `contact: { phone?, email?, address? }` (the location is `contact.address`). Pass it to every business-scoped API call. `status` is `loading | signed_in | signed_out`. Screens under `(dashboard)` only render when `signed_in`, so they can assume an owner.

## Domain names to reuse

- Fact kinds (`FactKind`): `hours`, `policy`, `service`, `contact`, `faq`, `menu_item`. `menu_item` facts are upload drafts only and never a price source.
- Hours facts use one key per weekday: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`.
- Take these and every other shape from `packages/contracts` (re-exported by `@/lib/api`). Never invent a field name.

## Astryx conventions

Look things up with the local CLI. Never run the unscoped `npx astryx`, it is a different npm package.

```bash
npm run astryx -- build "<what the screen does>"   # closest template plus blocks
npm run astryx -- template --list
npm run astryx -- template <slug> <path>          # scaffold, then adapt
npm run astryx -- component                       # list components
npm run astryx -- --dense component Table         # props and usage for one
npm run astryx -- docs tokens                     # spacing, color, radius tokens
npm run astryx -- docs layout
```

- Import each component from its own entry: `import {Button} from '@astryxdesign/core/Button'`.
- Layout: `VStack`, `HStack` (`gap`, `padding`, `hAlign`, `vAlign`, `wrap`), `Center`, `Grid`, `Card`, `Layout`/`LayoutContent`, `Section`. No raw `<div>`.
- Text: `Heading level={n}`, `Text type="body|supporting|label"` with `color`.
- Spacing values are steps (`gap={4}`), not pixels. Colors come from tokens like `var(--color-background-body)`. No hex.
- Data rows: `Table` or `List`/`Item`. `Badge` is for counts and short labels.
- Status colors: `Banner status`, `Badge variant`, `StatusDot variant`.
- Icons: pass a semantic name (`'warning'`, `'check'`, `'clock'`, see `docs icons available-names`). Do not install heroicons even if a template asks for it. Remove the icon or use a semantic name.
- Links: `AppProviders` sets `LinkProvider` to `next/link`, so `href` on `SideNavItem`, `Button` and `Link` does client-side navigation.

## Astryx with Next.js: gotchas

- Astryx components use hooks. Put `'use client'` at the top of any file that renders them with state or handlers. A server `page.tsx` can still render the shared components because each of them is a client component.
- CSS order: `app/globals.css` imports `reset.css` then `astryx.css`. The theme CSS comes from `astryx-themes.ts` (generated by `theme add neutral`, do not edit). These are cascade layered (`reset`, `astryx-base`, `astryx-theme`), so any unlayered CSS you add wins over component styles. Avoid global CSS.
- No StyleX compiler is set up. Do not call `stylex.create()` and do not pass `xstyle`. Some templates use `stylex.create`. If you scaffold one, replace those styles with component props (or an inline `style` with tokens) or you get "Unexpected stylex.create call at runtime".
- Theme mode is `system`, so light and dark both work.
- The neutral theme loads the Figtree font from Google Fonts (`fonts.css`). Offline, text falls back to the system font.
- Auth and business selection are read from localStorage after mount. Server HTML always shows the default business and a "Checking sign-in" state.
