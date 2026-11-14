# lib/api

The typed API client, the React Query hooks and the mock layer switch for `apps/web`. Screens import from `@/lib/api` and nothing else. They never read `NEXT_PUBLIC_MOCK` themselves.

## Setup

`ApiProvider` (from `@/lib/api`) is mounted once in the app providers. It creates the QueryClient. With `NEXT_PUBLIC_MOCK=1` it starts the MSW worker first and renders its `fallback` prop (default: nothing) until the worker is ready. Without the flag it never loads MSW.

Every business-scoped hook takes `businessId` as its first argument. Pass `useBusiness().businessId`. The hook stays disabled while it is `null` or `undefined`.

## Files

| File | What it holds |
|---|---|
| `pending-contracts.ts` | Temporary Zod schemas and types transcribed from `docs/CONTRACTS.md`. Type names match CONTRACTS.md; schemas add `Schema`. Replaced by `packages/contracts` once S-02 merges. |
| `api-shapes.ts` | Temporary request and response shapes from `docs/API.md` (`Business`, `Agent`, `AgentVersion`, `PreviewResponse`, `PublishResponse`, `BuilderTurnResponse`, `FactsListResponse`, `OrderCheckout`, `Page`). Same swap rule. |
| `client.ts` | One function per endpoint, exported as `api` from the barrel. Validates every response. |
| `errors.ts` | `ApiError` and the code table. |
| `hooks.ts` | The hooks below. |
| `useActivityFeed.ts` | Live events, mock or Supabase Realtime. |
| `query-keys.ts` | Every query key. |
| `invalidation.ts` | Which queries each activity event refreshes. |
| `mock-bridge.ts` | Mock events and mock controls, with no MSW code in it. |
| `provider.tsx` | `ApiProvider` and `createApiQueryClient()`. Its query and mutation caches send every failure to `session-errors.ts`. |
| `session-errors.ts` | `subscribeApiErrors(listener)`: one central report of failed calls. `SessionErrorHandler` uses it for `UNAUTHENTICATED` and `FORBIDDEN_BUSINESS`. |

## Errors

Every failed call throws `ApiError` (a class; the envelope type from CONTRACTS.md is exported as `ApiErrorBody`).

| Field | Meaning |
|---|---|
| `code` | An `ErrorCode` from API.md section 2. |
| `message` | Safe to show the owner. |
| `status` | HTTP status. `0` for a network failure. |
| `correlationId` | From the `X-Correlation-Id` header. Show it in error states. |
| `retryable` | Show "Try again" when true. |
| `details` | For example `conflictIds` on `CONFLICT_UNRESOLVED`, `state` on `INVALID_STATE`. |
| `kind` | `http`, `network` (no answer; code is `INTERNAL`, retryable) or `invalid_response` (2xx body did not match the contract). |

## Hooks

Queries return the normal React Query result (`data`, `isPending`, `error`, `refetch`, ...). Mutations return the normal mutation result (`mutate`, `mutateAsync`, `isPending`, `error`, `data`). No mutation updates the cache before the server answers.

### Businesses, facts, catalog

| Hook | Arguments | `data` or mutation variables |
|---|---|---|
| `useBusinesses({ enabled? })` | optional `enabled` (default true) | `Page<BusinessListItem>`. `useBusiness()` from `@/lib/session` already uses it for the selector. |
| `useBusiness(businessId)` | | `Business` (contact has `phone?`, `email?`, `address?`) |
| `useUpdateBusiness(businessId)` | mutate `{ name?, contact?, settings? }` | `Business` |
| `useFacts(businessId, { kind?, status? })` | `kind`: `hours`, `policy`, `service`, `contact`, `faq`, `menu_item`. Default status leaves out `superseded`. | `FactsListResponse` `{ items: BusinessFact[], conflicts: FactConflict[] }` (open conflicts) |
| `useProposeFact(businessId)` | mutate `{ kind, key, value, reason? }` or `{ resolvesConflictId, value, reason? }` | `{ approval }`, a `fact_edit` approval with `actorType: "owner"`. Open the confirm dialog and decide it with `useDecideApproval`. Nothing changes before that. |
| `useResolveConflict(businessId)` | mutate `{ conflictId }` | `{ conflict }`. Keeps the authoritative value; no approval. |
| `useCatalog(businessId)` | | `{ items: CatalogItem[], syncedAt }`. Display prices only. |
| `useSyncCatalog(businessId)` | mutate with no argument | `{ jobId }`. Progress arrives as `sync.*` events with `target: "catalog"`. |
| `useProposePrice(businessId)` (SHOULD) | mutate `{ variationId, newPriceMinor, currency: "USD" }` | `{ approval }`, a `price_edit` approval |

A price conflict (`kind: "menu_item"`) is never resolved by a fact edit. Keep Square's price with `useResolveConflict`, or propose a price change.

### Files

| Hook | Arguments | Result |
|---|---|---|
| `useUploadFile(businessId)` | mutate `{ file: Blob, fileName? }` | `FileRecord` in `PENDING` |
| `useFile(businessId, fileId)` | | `FileRecord`. Polls every 2 seconds while `PENDING` or `EXTRACTING`. |

### Builder

| Hook | Arguments | Result |
|---|---|---|
| `useCreateBuilderSession(businessId)` | mutate `{ agentId? }` or nothing | `BuilderSessionResponse` (`BuilderSession` with `messages`, plus `progress`) |
| `useBuilderSession(businessId, sessionId)` | | `BuilderSessionResponse` |
| `useSendBuilderMessage(businessId, sessionId)` | mutate `{ text, inputMode: "text" \| "voice" }` | `BuilderTurnResponse`: `reply`, `draftSpec`, `missingFields`, `suggestions`, `stopConditions`, `progress`, `unsupportedRequests` (always), `proposedChange?` `{ approvalId, bundleType }`. When `proposedChange` is present, open the confirm dialog for that approval. |
| `useRealtimeClientSecret(businessId)` | mutate `{ builderSessionId }` | `RealtimeClientSecret`. In mock mode the secret is fake, so fall back to typed input. |

### Agents

| Hook | Arguments | Result |
|---|---|---|
| `useAgents(businessId, { state?, limit?, cursor? })` | | `Page<Agent>` |
| `useAgent(businessId, agentId)` | | `Agent` (`state`, `activeVersionId?`, `activeVersion?`, `draftSpec`, `isLiveAgent`) |
| `useAgentVersions(businessId, agentId)` | | `Page<AgentVersion>`, newest first |
| `useCreateAgent(businessId)` | mutate `{ builderSessionId }` or `{ spec }` | `Agent` in `draft` |
| `usePreviewAgent(businessId, agentId)` | mutate `{ scenarios? }` or nothing | `PreviewResponse`. Mock tools only. |
| `usePublishAgent(businessId, agentId)` | mutate `{ confirm: true, makeLive? }` | `PublishResponse` `{ agent, version, phoneNumber }`. `CONFLICT_UNRESOLVED` lists `details.conflictIds`. |
| `usePauseAgent(businessId, agentId)` | mutate with no argument | nothing; the agent refetches |
| `useRollbackAgent(businessId, agentId)` (SHOULD) | mutate `{ toVersionId, confirm: true }` | `PublishResponse` |
| `useAgentConversation(businessId, agentId, mode)` | `mode`: `"test"` or `"sim-call"` | `{ mode, turns, sessionId, send(message), end(), isPending, error, reset() }`. `turns` holds `{ role, text, response? }`; the agent turn's `response.toolTrace` and `response.guardrail` drive the trace panel. Label `test` as "Test with mock tools" and `sim-call` as "Simulated call". |

### Live agent (owner-scoped, no businessId)

| Hook | Arguments | Result |
|---|---|---|
| `useLiveAgent()` | | `LiveAgent` `{ phoneNumber, businessId, agentId?, agentVersionId?, updatedAt }`. `agentId` is absent when nothing answers the number. |
| `useSetLiveAgent()` | mutate `{ agentId }` | `LiveAgent` |

### Approvals

| Hook | Arguments | Result |
|---|---|---|
| `useApprovals(businessId, { state?, bundleType?, limit?, cursor? })` | `state` defaults to `PENDING` on the server | `Page<ApprovalRequest>`. For the pending list pass `PENDING_APPROVALS_QUERY` (`{ state: "PENDING", limit: 200 }`), the same query the sidebar badge uses, so both read one cache entry. |
| `useApproval(businessId, approvalId)` | | `ApprovalRequest` |
| `useDecideApproval(businessId)` | mutate `{ approvalId, decision: "approve" \| "reject", payloadHash, reason? }` | `{ approval: { id, state, decidedBy?, decidedAt? } }` |

`useDecideApproval` sends the hash you displayed and an `Idempotency-Key` that stays the same for the same approval, decision and hash, so a retry is safe. Disable both buttons while `isPending`. Show "Approved" only from the returned state. Steps, link, message and payment arrive later as activity events. Handle `PAYLOAD_HASH_MISMATCH` (the approval is refetched; show the new payload), `APPROVAL_EXPIRED` and `APPROVAL_ALREADY_DECIDED`.

### Orders, bookings, calls

| Hook | Arguments | Result |
|---|---|---|
| `useOrders(businessId, { status?: string[], callId?, limit?, cursor? })` | | `Page<Order>`, newest first |
| `useOrder(businessId, orderId)` | | `Order` |
| `useOrderCheckout(businessId, orderId)` | | `OrderCheckout` `{ orderId, ready, environment: "sandbox", checkoutUrl?, qrText?, squarePaymentLinkId?, message?: { id, channel, status, sentAt? } }`. Render the QR from `qrText` with the `qrcode` package and a sandbox label. |
| `useBookings(businessId, { status?, from?, to? })` | | `Page<Booking>` |
| `useBooking(businessId, bookingId)` | | `Booking` |
| `useCalls(businessId, { agentId?, since?, limit?, cursor? })` | | `Page<Call>` |
| `useCall(businessId, callId)` | | `Call` (`channel` `test_console` means "simulated call") |
| `useCancelOrder(businessId)` (SHOULD) | mutate `{ orderId }` | `Order` |
| `useResolveExecution(businessId)` (SHOULD) | mutate `{ executionId, action: "retry" \| "abandon" }` | `ActionExecution` |

Leave the Cancel, Retry and Abandon buttons out of screens until the server has those routes (SPEC P-19). The client functions and mocks exist so the screens can be finished later. There is no "mark ready" route: the server moves a paid order to `FULFILLMENT_READY` itself.

Green only for `PAID_VERIFIED`, `FULFILLMENT_READY` and `BOOKED_VERIFIED` (FLOWS.md 3.5).

### Activity, health, telemetry

| Hook | Arguments | Result |
|---|---|---|
| `useActivity(businessId, { types?, correlationId?, since?, limit?, cursor? })` | | `Page<ActivityEvent>`, newest first. Use `correlationId` (a `call_` id) for one call's timeline. |
| `useActivityFeed(businessId, { limit? })` | | `{ events, status, source, lastEventAt? }`. `events` are the ones received since mount, newest first. In mock mode the mock `reset()` control empties `events` and refetches every query. Label `status` with `statusView('feed', status)`. `status` is `connecting`, `connected`, `disconnected`, `unavailable` (no Supabase settings) or `idle` (no business). `source` is `mock` or `realtime`. Each event also refetches the affected queries, so most screens only need to mount it once. |
| `useIntegrationsHealth(businessId)` | | `IntegrationHealth`: one entry per provider (`square`, `twilio`, `openai`, `google_calendar`, `google_sheets`, `message_channel`) with `state` `connected`, `degraded` or `disconnected`. Refetches every minute. |
| `useRefreshIntegrationsHealth(businessId)` | mutate with no argument | runs the live checks (`refresh=1`) |
| `useTelemetry(businessId, { since? })` (SHOULD) | | `{ metrics: { name, p50Ms, p95Ms, count }[] }` |

Read an event payload with its CONTRACTS.md types through `payloadOf(event)`.

`CAPABILITY_REGISTRY` gives each capability's `effect` and `approvalMode`, for the read versus approval-gated lists in the builder and preview.

## Mock mode

Run `npm run dev:mock` (or set `NEXT_PUBLIC_MOCK=1`). Requests go to MSW in the browser; the mock keeps state in memory until the page reloads. Builder sessions are the one exception: the browser mock keeps them in sessionStorage (`abos.mock.builderSessions`), so reloading /build resumes the session. The node test server does not persist them.

### Mock controls

`useMockControls()` returns `null` outside mock mode. In mock mode it returns the controls below. Show them in a panel clearly labelled "Mock controls".

| Control | What it does |
|---|---|
| `startPizzaCall()` | Starts the Flow B call: `call.started`, stage changes, `proposal.created`, `approval.requested`, a pending approval and order, then `call.ended`. Resolves with `{ callId, orderId, approvalId }`. After you approve, the order runs to `PAYMENT_PENDING`, then about 6 seconds later `payment.verified`, `PAID_VERIFIED`, the Sheets sync and `FULFILLMENT_READY`. Steps are about 1.5 seconds apart. |
| `startBookingCall({ slotConflict? })` | The Flow C call for the barbershop. After approval it reaches `BOOKED_VERIFIED`, or `SLOT_CONFLICT` with three alternatives. |
| `simulatePaymentFailed()` | Fails the newest order waiting for payment, or the next one. |
| `simulateSyncRetry()` | The next Sheets sync fails once (`sync.failed`, `final: false`) and then succeeds. |
| `simulateCallLost()` | Drops the scripted call before its proposal, or starts one that drops. No order is created. |
| `simulateRejectedWebhook()` | Emits `webhook.rejected` for the pizza business. |
| `simulatePayloadChanged(approvalId)` | Changes a pending approval's stored payload, so the next decision gets `PAYLOAD_HASH_MISMATCH`. |
| `simulateNoLiveAgent()` | Leaves the number unanswered: the live agent loses `agentId` and `agentVersionId`. |
| `reset()` | Puts every fixture back, clears stored builder sessions, and tells `useActivityFeed` to drop its events (`subscribeMockReset`). |
| `simulateExtractionFailed?()` | The next uploaded file ends in `FAILED`: `extraction.completed` with `extractionState: "FAILED"` and no drafts or conflicts. |
| `simulateCatalogSyncFailed?()` | The next catalog sync ends with `sync.failed` (`target: "catalog"`, `final: true`). The catalog and `syncedAt` stay as they were. |
| `simulateQrOnlyChannel?()` | The next pizza call is proposed with `messageChannel: "qr_only"`. After approval the message step is `SKIPPED`: no dispatch, no message event, `checkout.message` is absent, and the order goes from `PAYMENT_LINK_READY` straight to `PAYMENT_PENDING`, then to a verified sandbox payment. |

The last three are optional members of `MockControls`, so call them as `controls.simulateQrOnlyChannel?.()`.

Approving a `price_edit` (from `useProposePrice`) runs `square.catalog.price.update` and `local.catalog.sync`; afterwards `useCatalog` shows the new price.

Approving any pending approval runs its scripted follow-up, not only the ones from these controls. Pending approvals expire 10 minutes after creation, like the server.

### Rules the mock enforces

Wrong payload hash, a second different decision, deciding an expired approval, publish without `confirm: true`, publish while a required conflict is open (the pizza fixture `cfl_pizza_01` blocks it), a simulated call on an agent that is not live, an upload over 10 MB or of a type that is not accepted, pausing a draft, resolving a price conflict through a fact edit, a reused `Idempotency-Key` with a different body. Each answers with the API.md error code. The test console reads fixtures only: it returns `apv_mock_` IDs and never stores a row or writes an event.

### Fixtures (`apps/web/mocks/fixtures`)

Times are relative to when the mock starts, so pending approvals always show a live countdown.

| Business | What is seeded |
|---|---|
| `biz_pizza_01` Demo Pizza Co. | Catalog: Margherita and Pepperoni in three sizes with a Toppings modifier list. Hours `mon` to `sun` (Friday edited once, with a superseded version), pickup window, special requests, contact. `file_menu_01` menu.pdf with draft facts and two open conflicts: `cfl_pizza_01` (Large Margherita 2100 in the menu, 2000 in Square, required) and `cfl_pizza_02` (pickup window, not required). Agents: `agt_pizza_01` live with versions v1 and v2 and on the phone number, `agt_pizza_faq_01` paused. Orders in `AWAITING_OWNER_APPROVAL`, `PAYMENT_PENDING` (message failed, QR only), `PAID_VERIFIED` (Sheets sync retrying), `FULFILLMENT_READY`, `PAYMENT_FAILED` (simulated call), `REJECTED`, `APPROVAL_EXPIRED`. Calls including a dropped one and one with a guardrail refusal. Fact edit approvals in all four states. A rejected webhook. |
| `biz_barber_01` Demo Barbershop | Services Haircut, Beard trim, Haircut and beard as `service` facts, hours, notice policy, an FAQ. `file_services_01` with one low-confidence draft. Agents: `agt_barber_01` live (not on the number), `agt_barber_faq_01` draft. Bookings in `AWAITING_OWNER_APPROVAL`, `BOOKED_VERIFIED`, `SLOT_CONFLICT`, `REJECTED`, `EXPIRED`, and a dropped call. |

Integration health: Google Calendar `degraded`, Google Sheets `disconnected`, the rest `connected`; Square is always `sandbox`. All payment data is sandbox.

### Tests

`mocks/server.ts` runs the same handlers on `msw/node`. `mocks/test-setup.ts` has `useMockServer()`, which starts it with fast timing, points the client at it and resets the db before each test. Use `whenIdle()` to wait for scripted steps to finish.
