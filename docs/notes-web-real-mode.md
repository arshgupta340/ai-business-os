# Web app in real mode: readiness audit

Checked on 2026-11-14 against `origin/arsh/integration` at `1588eaa`, read from git without checking it out. `packages/contracts` is identical on `main` and on the integration branch, so both sides use the same `ENDPOINTS` table.

Sources read: `apps/web/lib/api/*`, `apps/web/lib/session/*`, `apps/server/src/api/routes.ts`, `apps/server/src/api/simcall/index.ts`, `apps/server/src/app.ts`, `apps/server/src/auth/verify.ts`, `apps/server/src/compose/index.ts`, `apps/server/src/builder/**` (route registrations), `apps/server/src/telemetry/plugin.ts`.

## How the web client calls the server

- Every call goes through `apps/web/lib/api/client.ts`. Method, path and response schema come from `ENDPOINTS` in `@abos/contracts`, so the web side cannot drift from the contract on method or path.
- Base URL is `NEXT_PUBLIC_API_URL`, inlined at build time. A production build only talks to the URL it was built with.
- Token: `Authorization: Bearer <Supabase access token>` from `supabase.auth.getSession()` (`lib/session/auth/token.ts`). No token, no header; the server then answers `UNAUTHENTICATED`.
- Business scope: `businessId` in the path for `/api/businesses/:id/...`, a query parameter everywhere else. Matches the server guard (`createAuthGuard` reads `params.id` for `/api/businesses/:id*`, else `query.businessId`).
- Lists go out as comma strings (`status=A,B`, `types=a,b`). The contract's `commaList` accepts that. `limit` goes out as a decimal string, which `QueryLimitSchema` accepts.
- `decideApproval` sends `Idempotency-Key`. The server's CORS allows `Authorization`, `Content-Type`, `X-Correlation-Id`, `Idempotency-Key` and exposes `X-Correlation-Id`. Methods allowed: GET, POST, PUT, PATCH, OPTIONS. The web app uses no DELETE.

## Error handling

| Answer | What the web app does |
|---|---|
| 401 / `UNAUTHENTICATED` | `SessionErrorHandler` signs the owner out, clears the query cache and goes to `/sign-in` with a notice. |
| 403 / `FORBIDDEN_BUSINESS` | That business is dropped from the selector and another one is selected. |
| 404 / `NOT_FOUND` | Thrown as `ApiError`; each screen shows its own message. An unregistered route also answers `NOT_FOUND` (Fastify not-found handler, message "No route for ..."). |
| 2xx body that fails the response schema | `ApiError` with `kind: "invalid_response"`, code `INTERNAL`, not retryable. Screens show an error. Nothing is shown from the bad body. |
| Network failure | `ApiError` with `kind: "network"`, retryable. Queries retry twice; mutations never retry on their own. |

## Realtime

`useActivityFeed` subscribes to `postgres_changes` INSERT on `public.activity_events` filtered by `business_id`, after `supabase.realtime.setAuth(token)`. Every row triggers a refetch of what it affects (`handleRealtimeRow`). A row that fails `activityEventFromRow` only refetches and logs one warning per type, without the payload. It is never added to the live feed. Covered by `lib/api/realtime-row.test.ts`.

## Mock fallback in real mode

- MSW starts only behind a literal `NEXT_PUBLIC_MOCK === "1"` check. A clean real-mode build (`NEXT_PUBLIC_MOCK=0`) has no `setupWorker` or `mockServiceWorker` string in `.next/static` (checked 2026-11-14).
- The access token is the fixed mock token only when `NEXT_PUBLIC_MOCK=1`.
- One soft fallback remains: the business selector shows the two seeded businesses while `GET /api/businesses` loads or after it fails (see mismatch 3). Only names and ids, no data; every business-scoped call still goes to the server.

## Endpoints the UI calls

The contract has 42 REST endpoints. The UI calls 39 of them. The integration branch serves 38 of those 39.

| Endpoint | Method and path | UI caller | Served by integration |
|---|---|---|---|
| listBusinesses | GET /api/businesses | ApiBusinessProvider | yes |
| getBusiness | GET /api/businesses/:id | Settings | yes |
| updateBusiness | PATCH /api/businesses/:id | Settings profile | yes |
| listFacts | GET /api/businesses/:id/facts | Knowledge, Prices, Settings, Preview | yes |
| proposeFact | POST /api/businesses/:id/facts/propose | Knowledge, Settings | yes |
| getCatalog | GET /api/businesses/:id/catalog | Knowledge, Prices | yes |
| syncCatalog | POST /api/businesses/:id/catalog/sync | Knowledge | yes |
| proposePrice | POST /api/businesses/:id/catalog/prices/propose | Prices editor | **no** |
| resolveConflict | POST /api/conflicts/:id/resolve | Knowledge conflicts | yes (builder) |
| uploadFile | POST /api/businesses/:id/files | Knowledge upload | yes (builder) |
| getFile | GET /api/files/:id | Knowledge file card | yes (builder) |
| createBuilderSession | POST /api/builder/sessions | Build, Change agent | yes (builder) |
| getBuilderSession | GET /api/builder/sessions/:id | Build, Preview | yes (builder) |
| sendBuilderMessage | POST /api/builder/sessions/:id/messages | Build, Change agent | yes (builder) |
| listAgents | GET /api/agents | Agents, Overview, Activity | yes (builder) |
| createAgent | POST /api/agents | Build spec panel | yes (builder) |
| getAgent | GET /api/agents/:id | Agent detail, Preview, Versions | yes (builder) |
| previewAgent | POST /api/agents/:id/preview | Preview | yes (builder) |
| testAgent | POST /api/agents/:id/test | Test console | yes (builder) |
| simCall | POST /api/agents/:id/sim-call | Test console (simulated call) | yes (api/simcall) |
| publishAgent | POST /api/agents/:id/publish | Publish panel | yes (builder) |
| pauseAgent | POST /api/agents/:id/pause | Pause control | yes (builder) |
| listAgentVersions | GET /api/agents/:id/versions | Versions | yes (builder) |
| rollbackAgent | POST /api/agents/:id/rollback | Rollback dialog | yes (builder) |
| createRealtimeClientSecret | POST /api/realtime/client-secret | Build voice | yes (builder) |
| getLiveAgent | GET /api/live-agent | Agents, Overview, Preview, Integrations | yes |
| putLiveAgent | PUT /api/live-agent | Phone number card | yes |
| listApprovals | GET /api/approvals | Approvals, badge, Overview, Knowledge | yes |
| getApproval | GET /api/approvals/:id | Approval detail, Call detail | yes |
| decideApproval | POST /api/approvals/:id/decision | Approval detail | yes |
| listOrders | GET /api/orders | Activity, Overview | yes |
| getOrder | GET /api/orders/:id | Approval detail | yes |
| getOrderCheckout | GET /api/orders/:id/checkout | Call detail | yes |
| listBookings | GET /api/bookings | Activity, Overview | yes |
| getBooking | GET /api/bookings/:id | Approval detail | yes |
| listCalls | GET /api/calls | Activity, Agent detail, Overview | yes |
| listActivity | GET /api/activity | Activity, Overview, Settings, Integrations, Versions | yes |
| getIntegrationsHealth | GET /api/integrations/health | Integrations, Overview, top bar | yes |
| getTelemetry | GET /api/telemetry | Telemetry | yes (telemetry plugin) |

Not called by any screen: `getCall` (hook `useCall` exists, no caller), `cancelOrder` and `resolveExecution` (SHOULD tier; neither is served).

## Mismatches

1. **`proposePrice` is not served.** The Prices screen offers the editor, and the 404 from the not-found handler is shown as "This variation is not in the catalog" (`apps/web/app/(dashboard)/knowledge/prices/_lib/propose-errors.ts`), which is wrong for a missing route. Fix: register `proposePrice` on the server (`apps/server/src/api/routes.ts` only registers MUST-tier Arsh endpoints). Side: server (Arsh). Until then, do not use the price editor in a real-mode demo.
2. **Builder auth misconfiguration signs the owner out.** When the server has no token verifier (`authConfigured` false in `apps/server/src/compose/index.ts`), builder routes use `NotConfiguredAuth`, which answers `UNAUTHENTICATED` "Builder auth is not configured." The web app treats every `UNAUTHENTICATED` as an expired session and signs the owner out the moment Build loads. Fix: answer `INTEGRATION_UNAVAILABLE` for "not configured", as `createVerifier` already does for owner routes. Side: server (`apps/server/src/builder/auth.ts`, Saina's lane on the server).
3. **The business selector falls back to the seeded list when `GET /api/businesses` fails.** `chooseBusinesses` in `apps/web/lib/session/ApiBusinessProvider.tsx` uses `SEEDED_BUSINESSES` while loading and on error, with no error shown. If the seed ids match the database this is harmless; if the call fails, the owner sees businesses the server never confirmed. Fix: on a failed list in real mode, show the error and an empty selector. Side: web (Saina). Not changed tonight because it changes the selection default that BusinessProvider and its tests rely on.
4. **CORS origin.** The server allows one origin, `WEB_ORIGIN`, default `http://localhost:3000`. A laptop on any other port is refused by the browser. Fix: run the web app on port 3000, or set `WEB_ORIGIN` on Render to match. Side: deploy config. The value set on Render was not checked.
5. **Live agent needs `TWILIO_PHONE_NUMBER`.** `getLiveAgent` and `putLiveAgent` answer `INTEGRATION_UNAVAILABLE` without it. The web app retries twice, then the phone number card shows an error. Behavior is correct; it only needs the variable set on the server.

No web-side mismatch was small and certain enough to fix in this pass.

## Not verified

- No call was made to the deployed server. Today it serves only `/health` and the builder routes, so every other screen answers `NOT_FOUND` "No route" until the integration branch is deployed.
- Supabase Realtime delivery depends on the `activity_events` publication and row-level security in the database. Not tested.
- Response bodies were checked only by reading that each server route validates against the same `ENDPOINTS` response schema before sending. No real response was parsed by the web client.
