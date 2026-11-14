# Web app in real mode: readiness audit

First written on 2026-11-14 against `origin/arsh/integration` at `1588eaa`, before that branch was merged. Re-checked later the same day against `main` at `50d4c80`, after #97 (the integration branch), #101, #102, #107, #109, #104 and #110 were merged. Everything below describes `main` unless it says otherwise. It was read from the code. Nothing here was run against the deployed server (see "Not verified").

Sources read: `apps/web/lib/api/*`, `apps/web/lib/session/*`, `apps/web/components/providers/SessionErrorHandler.tsx`, `apps/server/src/app.ts`, `apps/server/src/api/routes.ts`, `apps/server/src/api/prices/index.ts`, `apps/server/src/api/recovery/index.ts`, `apps/server/src/api/conflicts.ts`, `apps/server/src/api/simcall/index.ts`, `apps/server/src/auth/verify.ts`, `apps/server/src/compose/index.ts`, `apps/server/src/builder/**` (route registrations and `auth.ts`), `apps/server/src/telemetry/plugin.ts`, `apps/server/test/e2e/builder-auth.test.ts`, `apps/server/test/e2e/conflict-resolve.test.ts`.

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
| 403 / `FORBIDDEN_BUSINESS` | That business is dropped from the selector and another one is selected. If the server refused every business, the shell shows "No business you can open" in place of the screen. |
| 404 / `NOT_FOUND` | Thrown as `ApiError`; each screen shows its own message. An unregistered route also answers `NOT_FOUND` (Fastify not-found handler, message "No route for ..."). The Prices screen tells the two apart (`isMissingRoute`). |
| 2xx body that fails the response schema | `ApiError` with `kind: "invalid_response"`, code `INTERNAL`, not retryable. Screens show an error. Nothing is shown from the bad body. |
| Network failure | `ApiError` with `kind: "network"`, retryable. Queries retry twice; mutations never retry on their own. |
| `GET /api/businesses` fails, or answers an empty list | The shell shows an error state with a retry, or "This account has no business yet", in place of the screen (`BusinessListGate`, added in #109). No screen mounts without a business the server returned. |
| A background refetch fails while old data is on screen | Overview and My Agents keep the last data and show "Could not refresh. Showing the last data we have." with "Try again" (`RefreshFailedNotice`, added in #109). |

## Realtime

`useActivityFeed` subscribes to `postgres_changes` INSERT on `public.activity_events` filtered by `business_id`, after `supabase.realtime.setAuth(token)`. Every row triggers a refetch of what it affects (`handleRealtimeRow`). A row that fails `activityEventFromRow` only refetches and logs one warning per type, without the payload. It is never added to the live feed. Covered by `lib/api/realtime-row.test.ts`.

## Mock fallback in real mode

- MSW starts only behind a literal `NEXT_PUBLIC_MOCK === "1"` check. A clean real-mode build (`NEXT_PUBLIC_MOCK=0`) had no `setupWorker` or `mockServiceWorker` string in `.next/static` when this was checked on 2026-11-14, before #102, #107 and #109. The build was not repeated after those merges.
- The access token is the fixed mock token only when `NEXT_PUBLIC_MOCK=1`.
- The soft fallback this audit first reported is gone. In real mode `chooseBusinesses` is called with `fallback: "none"`, so the selector is empty until `GET /api/businesses` answers and never shows the seeded businesses (#109, `apps/web/lib/session/ApiBusinessProvider.tsx`, `business-list.ts`, `BusinessListGate.tsx`). The seeded list is used in mock mode only.

## Endpoints the UI calls

The contract has 42 REST endpoints. The UI calls 39 of them. `main` registers all 42: the app was built in a script with an empty environment (`buildApp(parseEnv({}))`) and its `routeInventory()` was compared with `ENDPOINTS`, and no endpoint was missing. That shows the routes exist. It does not show what each one answers with real data.

| Endpoint | Method and path | UI caller | Registered on `main` by |
|---|---|---|---|
| listBusinesses | GET /api/businesses | ApiBusinessProvider | api/routes |
| getBusiness | GET /api/businesses/:id | Settings | api/routes |
| updateBusiness | PATCH /api/businesses/:id | Settings profile | api/routes |
| listFacts | GET /api/businesses/:id/facts | Knowledge, Prices, Settings, Preview | api/routes |
| proposeFact | POST /api/businesses/:id/facts/propose | Knowledge, Settings | api/routes |
| getCatalog | GET /api/businesses/:id/catalog | Knowledge, Prices, Approvals | api/routes |
| syncCatalog | POST /api/businesses/:id/catalog/sync | Knowledge | api/routes |
| proposePrice | POST /api/businesses/:id/catalog/prices/propose | Prices editor | api/prices (was missing, see mismatch 1) |
| resolveConflict | POST /api/conflicts/:id/resolve | Knowledge conflicts | builder, plus a hook in `app.ts` for conflicts stored in the database |
| uploadFile | POST /api/businesses/:id/files | Knowledge upload | builder |
| getFile | GET /api/files/:id | Knowledge file card, Knowledge conflicts | builder |
| createBuilderSession | POST /api/builder/sessions | Build, Change agent | builder |
| getBuilderSession | GET /api/builder/sessions/:id | Build, Preview | builder |
| sendBuilderMessage | POST /api/builder/sessions/:id/messages | Build, Change agent | builder |
| listAgents | GET /api/agents | Agents, Agent detail, Overview, Activity | builder |
| createAgent | POST /api/agents | Build spec panel | builder |
| getAgent | GET /api/agents/:id | Agent detail, Preview, Versions, Integrations | builder |
| previewAgent | POST /api/agents/:id/preview | Preview | builder |
| testAgent | POST /api/agents/:id/test | Test console | builder |
| simCall | POST /api/agents/:id/sim-call | Test console (simulated call) | api/simcall |
| publishAgent | POST /api/agents/:id/publish | Publish panel | builder |
| pauseAgent | POST /api/agents/:id/pause | Pause control | builder |
| listAgentVersions | GET /api/agents/:id/versions | Versions | builder |
| rollbackAgent | POST /api/agents/:id/rollback | Rollback dialog | builder |
| createRealtimeClientSecret | POST /api/realtime/client-secret | Build voice | builder |
| getLiveAgent | GET /api/live-agent | Agents, Agent detail, Overview, Preview, Integrations | api/routes |
| putLiveAgent | PUT /api/live-agent | Phone number card | api/routes |
| listApprovals | GET /api/approvals | Approvals, badge, Overview, Knowledge, Prices, Settings | api/routes |
| getApproval | GET /api/approvals/:id | Approval detail, Call detail, Build spec panel, Prices, Settings | api/routes |
| decideApproval | POST /api/approvals/:id/decision | Approval detail | api/routes |
| listOrders | GET /api/orders | Activity, Overview | api/routes |
| getOrder | GET /api/orders/:id | Approval detail | api/routes |
| getOrderCheckout | GET /api/orders/:id/checkout | Call detail | api/routes |
| listBookings | GET /api/bookings | Activity, Overview | api/routes |
| getBooking | GET /api/bookings/:id | Approval detail | api/routes |
| listCalls | GET /api/calls | Activity, Agent detail, Overview | api/routes |
| listActivity | GET /api/activity | Activity, Overview, Settings, Integrations, Versions, Prices | api/routes |
| getIntegrationsHealth | GET /api/integrations/health | Integrations, Overview, top bar, Call detail, Approval detail | api/routes |
| getTelemetry | GET /api/telemetry | Telemetry | telemetry plugin |

Not called by any screen: `getCall` (hook `useCall` exists, no caller), `cancelOrder` and `resolveExecution` (hooks exist, no caller). `main` registers all three: `getCall` in `api/routes`, the other two in `api/recovery`. When this audit was first written, `cancelOrder` and `resolveExecution` were not served.

## Mismatches

Status of the five mismatches from the first audit, checked against `main`.

1. **`proposePrice` is not served.** Fixed on `main`.
   - Server: `pricesPlugin` is registered in `apps/server/src/app.ts` with the owner auth policy. It arrived with #97 (commit `d2e420f`). #110 added one refusal: a price proposal that carries `resolvesConflictId` answers `VALIDATION_FAILED` with a sentence saying what to do.
   - Web: #109 added `isMissingRoute` in `apps/web/app/(dashboard)/knowledge/prices/_lib/propose-errors.ts`. A `NOT_FOUND` whose message starts "No route for" now reads "The price editor is not available on this server" and no longer "This variation is not in the catalog". This only matters against a server build older than #97.
   - Still to check: the route reads the current price from Square before it stores the approval, and answers `INTEGRATION_UNAVAILABLE` when Square is not configured. The price editor has not been used from the web app against a real server.
2. **Builder auth misconfiguration signs the owner out.** Fixed on `main` for a server that has a database.
   - With a database and no token verifier (`authConfigured` false in `apps/server/src/compose/index.ts`), the builder now gets an auth that answers `INTEGRATION_UNAVAILABLE` "Sign-in is not configured on this server." The web app does not sign the owner out for that code. It arrived with #97 (commit `bc0fcda`) and is covered by `apps/server/test/e2e/builder-auth.test.ts`.
   - Still open, narrow: a server started with no `DATABASE_URL` passes no auth to the builder plugin, which keeps its own default `NotConfiguredAuth` and answers `UNAUTHENTICATED` "Builder auth is not configured." (`apps/server/src/builder/auth.ts`). The web app would sign the owner out in that case. A server without a database cannot serve the other screens either, so this only shows on a misconfigured server.
3. **The business selector falls back to the seeded list when `GET /api/businesses` fails.** Fixed on `main` by #109. In real mode the selector shows only what the server returned. While the list loads, after it fails, when it is empty and when every business was refused, the shell shows a loading, error or empty state in place of the screen (`BusinessListGate`). Covered by `apps/web/lib/session/business-list.test.ts`, `ApiBusinessProvider.test.tsx` and `apps/web/components/shell/DashboardShell.test.tsx`.
4. **CORS origin.** Still open. It is deploy configuration, and the code is unchanged: the server allows one origin, `WEB_ORIGIN`, default `http://localhost:3000` (`apps/server/src/app.ts`). A laptop on any other port is refused by the browser. Run the web app on port 3000, or set `WEB_ORIGIN` on Render to match. The value set on Render was not checked.
5. **Live agent needs `TWILIO_PHONE_NUMBER`.** Still true, and it is the intended behavior. `getLiveAgent` and `putLiveAgent` answer `INTEGRATION_UNAVAILABLE` "Phone number is not configured." without it (`apps/server/src/api/routes.ts`, covered by `apps/server/test/e2e/builder-auth.test.ts`). The web app retries twice, then the phone number card shows an error. It only needs the variable set on the server. Whether it is set on Render was not checked.

## New since the first audit

- **Conflict resolution.** #110 changed the server: "keep the current value" (`resolution: "keep_authoritative"`) on a conflict stored in the database is resolved on the database with no approval, by a hook in `apps/server/src/app.ts` that runs before the builder's in-memory resolve route (`apps/server/src/api/conflicts.ts`, `apps/server/test/e2e/conflict-resolve.test.ts`). Any other body on such a conflict answers `INTEGRATION_UNAVAILABLE` with `details.use` naming `facts/propose` with `resolvesConflictId`, or `CAPABILITY_NOT_ALLOWED` for a price conflict.
- **The web fallback for that answer.** #109 was written against the integration branch, where every database conflict got the `INTEGRATION_UNAVAILABLE` answer. On that answer the Knowledge screen proposes the kept value through `facts/propose` with `resolvesConflictId` and says that a confirmation is waiting in Approvals (`isResolveOnFactsList` in `apps/web/app/(dashboard)/knowledge/_components/ApiErrorBanner.tsx`, `Conflicts.tsx`). The web app always sends `keep_authoritative`, so against `main` after #110 the resolve route should answer directly and the fallback should not be reached. If it were reached, `facts/propose` on `main` refuses a value equal to the current verified value with `VALIDATION_FAILED` ("This is the current value. Keep it on the conflict instead of proposing it."). Both statements come from reading the code. Neither was run from the web app.
- **Publish and rollback errors.** #109 turns each documented publish and rollback error into a plain sentence (`publishErrorView` in `apps/web/app/(dashboard)/agents/[id]/preview/_lib/preview.ts`, `rollbackErrorView` in `agents/[id]/versions/_lib/versions.ts`). The texts are tested against error objects built in the tests, not against answers captured from a server.

## Not verified

- No call was made to the deployed server, in the first audit or in this re-check. Which commit is deployed was not checked, so nothing here says what the deployed server serves. `main` registers every contract route (see "Endpoints the UI calls").
- No real sign-in was done. The web app has not been run against a real server with a Supabase session, so no real response was parsed by the web client. Response bodies were checked only by reading that each server route validates against the same `ENDPOINTS` response schema before sending.
- Supabase Realtime delivery depends on the `activity_events` publication and row-level security in the database. Not tested.
- The values of `WEB_ORIGIN`, `TWILIO_PHONE_NUMBER` and the Supabase settings on Render were not checked.
- The real-mode build check for MSW strings was done before #102, #107 and #109 and was not repeated.
