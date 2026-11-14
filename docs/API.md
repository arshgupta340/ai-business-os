# AI Business OS: API

**Version:** 1.1 | **Date:** 2026-11-13 | **Implements:** `docs/SPEC.md` v1.1 sections 2.8 and 2.9, `docs/PRD.md` section 12

This file defines every REST endpoint, webhook and WebSocket of `apps/server`. Saina builds `apps/web` against it through the mock layer. Shapes named here (Cart, Quote, Contact, Fulfillment, Order, Booking, ApprovalRequest, ActivityEvent, ApiError, AgentSpec, BusinessFact, FactConflict, Call, IntegrationHealth, LiveAgent) are defined in full in `docs/CONTRACTS.md`. Tables are in `docs/DATA-MODEL.md`. Step-by-step flows are in `docs/FLOWS.md`. Per SPEC 2.9, this file wins on paths and error codes.

**Route ownership (D-07).** Saina implements the builder routes in `apps/server/src/builder`, registered as one Fastify plugin: builder sessions (3.3), agents except `sim-call` (3.4), files and extraction (3.2) and the realtime client secret (3.5). Arsh implements every other route, plus all webhooks and `/ws/phone`. Each group below names its owner.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `NEXT_PUBLIC_API_URL`. All REST paths start with `/api`. The web app has no API routes. |
| Format | JSON in and out, except file upload (multipart) and Twilio webhooks (form-encoded in, TwiML out). Fields are camelCase. Optional fields are absent, never `null`. |
| Money | Integer minor units (`amountMinor`, `subtotalMinor`, `taxMinor`, `totalMinor`, `priceMinor`) with a separate `currency`, always `"USD"`. |
| Time | ISO 8601 UTC strings ending in `Z`. Bookings also carry an IANA `timezone`. Both seeded businesses use `America/Los_Angeles`. |
| Phone | E.164, for example `"+15555550123"`. Events show only the last four digits. |
| IDs | Prefixed text, using the list in SPEC 2.1 (`biz_`, `agt_`, `agv_`, `ord_`, `qte_`, `bkg_`, `svc_`, `apv_`, `cfl_`, `tst_` and the rest). Square catalog IDs are Square's own, unprefixed. |
| Auth | `Authorization: Bearer <Supabase access token>`. The server verifies the JWT with Supabase and loads the owner. A missing or invalid token returns `UNAUTHENTICATED`. |
| Business scope | `businessId` is in the path for `/api/businesses/...` and a query parameter on every other business-scoped route, GET and POST alike. The server checks the owner owns that business (`FORBIDDEN_BUSINESS` if not), then checks the resource belongs to it (`NOT_FOUND` if not, so IDs from another business are never confirmed to exist). `GET /api/businesses` and `/api/live-agent` are owner-scoped instead. |
| Correlation | Every response has an `X-Correlation-Id` header. The client may send one; otherwise the server makes one. Errors repeat it in the body. |
| Pagination | List endpoints take `limit` (default 50, max 200) and `cursor` (opaque). They return `{ "items": [...], "nextCursor": "..." }`. `nextCursor` is absent on the last page. |
| Idempotency | `POST /api/approvals/:id/decision` is safe to send twice (section 3.7) and also accepts an `Idempotency-Key` header. The server keeps the first response for 24 hours and replays it for the same key and body; the same key with a different body returns `VALIDATION_FAILED`. Other POSTs have no idempotency guarantee; the UI disables their button while a request is open. |
| Live updates | The browser subscribes to Supabase Realtime `postgres_changes`, event `INSERT`, table `public.activity_events`, filter `business_id=eq.<businessId>`. Realtime delivers the raw row, so its columns are snake_case. The UI reads `type` and the IDs in `payload` (`orderId`, `bookingId`, `approvalId`, `agentId`, `callId`, `fileId`, as present) and refetches that resource over REST. There is no SSE endpoint. |
| Sandbox | Any response with payment data comes from Square sandbox. The UI shows a sandbox label wherever it renders one. |

### Error body

Every non-2xx response from `/api` is an `ApiError`. `details` is sanitized: it never holds secrets, tokens, full phone numbers or raw provider responses.

```json
{ "code": "PAYLOAD_HASH_MISMATCH", "message": "The approval payload changed since you loaded it.", "correlationId": "6f1c2b9e-8f2a-4c1d-9b77-3e5a0d2c4f10", "retryable": false, "details": { "approvalId": "apv_123" } }
```

## 2. Error codes

This is the one canonical list (SPEC 2.9). `packages/contracts` exports exactly these values as `ErrorCode`. The last three are also used as `errorCode` on action executions and as tool failure reasons.

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | no | No bearer token, or the token is invalid or expired. The UI sends the owner to sign in. |
| `FORBIDDEN_BUSINESS` | 403 | no | The owner does not own the `businessId` in the path or query. |
| `NOT_FOUND` | 404 | no | The resource does not exist in this business. |
| `VALIDATION_FAILED` | 400 | no | Body, query or upload failed validation. `details.issues` lists `{ path, message }`. |
| `INVALID_STATE` | 409 | no | The resource's state does not allow this call, for example pausing a draft agent. `details.state` gives the current state. |
| `CONFLICT_UNRESOLVED` | 409 | no | Publish blocked by an open required `FactConflict`. `details.conflictIds` lists them. |
| `APPROVAL_EXPIRED` | 409 | no | The approval reached `expiresAt` (10 minutes after creation) before it was decided. |
| `APPROVAL_ALREADY_DECIDED` | 409 | no | A different decision was already recorded. `details.state` gives it. |
| `PAYLOAD_HASH_MISMATCH` | 409 | no | The `payloadHash` sent does not match the stored hash. The UI reloads the approval. |
| `CAPABILITY_NOT_ALLOWED` | 422 | no | A spec names a capability that is not in the registry, or lists a `write` or `external_message` capability as a tool. |
| `INTEGRATION_UNAVAILABLE` | 503 | yes | A provider (OpenAI, Square, Google, Twilio, message channel) failed or timed out. `details.provider` names it. |
| `ENVIRONMENT_MISMATCH` | 503 | no | Square is not configured as `sandbox` (AC-19). The server refuses payment work. |
| `SIGNATURE_INVALID` | 401 | no | Webhooks only. The provider signature did not verify. |
| `RATE_LIMITED` | 429 | yes | Too many requests. A `Retry-After` header gives seconds. |
| `INTERNAL` | 500 | yes | Unexpected server error. The correlation ID finds it in the logs. |
| `QUOTE_EXPIRED` | 409 | no | A proposal used a quote older than 5 minutes. The agent re-quotes. |
| `ITEM_UNAVAILABLE` | 409 | no | A cart line is unavailable in the catalog. `details.variationId` names it. |
| `SLOT_CONFLICT` | 409 | no | The requested slot is no longer free at the recheck before insert. |

## 3. Endpoints

Each entry lists method and path, input, success response, errors beyond the common set, activity events and screens. The common set is `UNAUTHENTICATED`, `FORBIDDEN_BUSINESS`, `VALIDATION_FAILED`, `RATE_LIMITED`, `INTERNAL`. Every `/api` endpoint is called by the signed-in owner only. Endpoints marked SHOULD follow the SPEC 5 SHOULD tier; all others are MUST.

### 3.1 Businesses, facts and catalog (owner: Arsh)

**`GET /api/businesses`**. Lists the owner's businesses for the selector (P-14). Events: none. Screens: top bar.

```json
{ "items": [ { "id": "biz_pizza_01", "name": "Demo Pizza Co.", "category": "restaurant", "timezone": "America/Los_Angeles" },
             { "id": "biz_barber_01", "name": "Demo Barbershop", "category": "barbershop", "timezone": "America/Los_Angeles" } ] }
```

**`GET /api/businesses/:id`**. Returns the profile. Errors: `NOT_FOUND`. Events: none. Screens: Overview, Knowledge review.

```json
{ "id": "biz_pizza_01", "name": "Demo Pizza Co.", "category": "restaurant", "timezone": "America/Los_Angeles",
  "contact": { "phone": "+15555550100", "email": "owner@example.com" }, "settings": {}, "createdAt": "2026-11-13T08:00:00Z", "updatedAt": "2026-11-13T08:00:00Z" }
```

**`PATCH /api/businesses/:id`**. Changes `name`, `contact` and `settings` only (SPEC 2.8). Sending a fact field returns `VALIDATION_FAILED`; facts change through `facts/propose`. Body `{ "name": "Demo Pizza Co." }`. Response: the profile. Errors: `NOT_FOUND`. Events: none.

**`GET /api/businesses/:id/facts`**. Query: `kind` (`hours`, `policy`, `service`, `contact`, `faq`, `menu_item`), `status` (`draft`, `verified`, `superseded`; default all but `superseded`). Returns BusinessFacts and open FactConflicts. Hours are one fact per weekday; services are facts of kind `service`. Screens: Knowledge review, Agent details.

```json
{ "items": [ { "id": "fact_hours_fri", "businessId": "biz_pizza_01", "kind": "hours", "key": "fri", "value": { "open": "11:00", "close": "22:00" },
               "sourceType": "seed", "status": "verified", "confidence": 1, "version": 1, "verifiedAt": "2026-11-13T08:00:00Z",
               "createdAt": "2026-11-13T08:00:00Z", "updatedAt": "2026-11-13T08:00:00Z" } ],
  "conflicts": [ { "id": "cfl_01", "businessId": "biz_pizza_01", "kind": "policy", "key": "pickup_window", "required": true, "state": "open",
                   "candidates": [ { "factId": "fact_7a1", "sourceType": "upload", "value": { "minutes": 20 } },
                                   { "factId": "fact_pw_01", "sourceType": "seed", "value": { "minutes": 30 } } ],
                   "createdAt": "2026-11-13T19:00:30Z" } ] }
```

FactConflict fields follow CONTRACTS.md.

**`POST /api/businesses/:id/facts/propose`**. Proposes a fact change, or resolves a conflict by choosing a value. Creates an approval with `bundleType: "fact_edit"`, `actorType: "owner"` and `actionBundle: ["local.fact.update"]` (P-09). The UI shows a confirm dialog and sends the decision to `POST /api/approvals/:id/decision`. Nothing changes until then. Errors: `NOT_FOUND` (unknown fact or conflict ID), `INVALID_STATE` (a subject mismatch, including a stale version, changed value, resolved conflict, or a new-key proposal when a verified row exists), and `VALIDATION_FAILED` (malformed body). Events: `approval.requested`. After approval: `approval.decided`, `execution.started`, `fact.changed`, `execution.succeeded`, and a second `fact.changed` carrying `resolvedConflictId` when the edit resolved a conflict (below). Screens: Knowledge review, Agent details (opening-hours edit, P-05).

```json
{ "kind": "hours", "key": "fri", "value": { "open": "11:00", "close": "23:00" }, "reason": "Open late on Fridays" }
```

```json
{ "approval": { "id": "apv_f01", "businessId": "biz_pizza_01", "actorType": "owner", "bundleType": "fact_edit",
  "actionBundle": ["local.fact.update"], "subjectId": "fact_hours_fri",
  "payload": { "businessId": "biz_pizza_01", "subjectId": "fact_hours_fri", "kind": "hours", "key": "fri", "fromVersion": 1,
               "before": { "open": "11:00", "close": "22:00" }, "after": { "open": "11:00", "close": "23:00" },
               "actionBundle": ["local.fact.update"], "expiresAt": "2026-11-13T20:10:00Z" },
  "payloadHash": "sha256:9c1e...", "state": "PENDING", "expiresAt": "2026-11-13T20:10:00Z", "createdAt": "2026-11-13T20:00:00Z" } }
```

For an existing value, `subjectId` is the existing verified fact's `fact_` ID, `fromVersion` is its version, and `before` is its value. For a new key, `subjectId` is a draft fact for the same business, kind and key whose value equals `after`; `fromVersion` is `0`, `before` is `null`, and no verified row may exist for that key. On confirmation, that draft becomes the verified row with version `1`. Migration 0005 adds support for the new-key case. Until then, the server refuses it with `INVALID_STATE`. A conflict is resolved in one of two ways. To keep the authoritative value, call `POST /api/conflicts/:id/resolve` (section 3.12): nothing external is written, so no approval is needed. To replace a local fact with the uploaded value, send `{ "resolvesConflictId": "cfl_01", "value": {...} }` here instead of `kind` and `key`; the conflict moves to `resolved` when the edit is approved and applied. The step that applies the fact resolves only the conflict the proposal named, only in the same business, kind and key, and only if it is still open; a conflict resolved in the meantime, or a newer one on the same key, is left alone. It then writes a second `fact.changed` with `resolvedConflictId`, the new fact's ID and `fromVersion` equal to `toVersion` (the version change itself is the first event). The conflict ID is not one of the hashed fields: the returned `payload` never contains it. The server stores it with the proposal, in the approval row beside the hashed fields, which cannot change after insert, and reads it from there when the step runs. The decision request cannot name a conflict. An edit that is already waiting for confirmation without a conflict cannot gain one: the same value sent again with `resolvesConflictId` returns `INVALID_STATE`; confirm the pending edit, then keep the current value on the conflict. A price that lives in Square cannot be changed this way: that is a price change (`catalog/prices/propose`, SHOULD).

**`POST /api/businesses/:id/catalog/sync`**. Refreshes the `catalog_items` cache from Square (P-10). Body `{}`. Response `202 { "jobId": "job_cat_01" }`. Errors: `INTEGRATION_UNAVAILABLE`, `ENVIRONMENT_MISMATCH`. Events: `sync.queued`, then `sync.succeeded` or `sync.failed` with `payload.target: "catalog"`. Screens: Knowledge review.

**`POST /api/businesses/:id/catalog/prices/propose`** (SHOULD). Proposes a Square price change. Creates an approval with `bundleType: "price_edit"`, `actorType: "owner"` and `actionBundle: ["square.catalog.price.update", "local.catalog.sync"]`, which the normal decision endpoint confirms. The server reads the variation's current Square object and `version` at proposal time. Errors: `NOT_FOUND` (variation), `INTEGRATION_UNAVAILABLE`, `ENVIRONMENT_MISMATCH`. Events: `approval.requested`. After approval: `approval.decided`, `execution.started`, `execution.succeeded` or `execution.failed`. Screens: Knowledge review, Agent details.

```json
{ "variationId": "SQ_VAR_PEP_LG", "newPriceMinor": 1900, "currency": "USD" }
```

Response `201 { "approval": {...} }` with `payload` holding the `price_edit` fields of CONTRACTS.md section 4.

### 3.2 Files and extraction (owner: Saina)

**`POST /api/businesses/:id/files`**. Multipart form, one field `file`, at most 10 MB. Accepted types (P-12): PDF (`application/pdf`), image (`image/png`, `image/jpeg`, `image/webp`), CSV (`text/csv`) and spreadsheet (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`). Anything else, or a larger file, returns `VALIDATION_FAILED`. The file is stored privately and one structured-output extraction is queued. It saves draft facts with confidence and opens a FactConflict where a draft disagrees with an authoritative source. It never changes verified facts. Response `202`. Events: `extraction.completed` when the job ends (`payload.fileId`, `payload.extractionState`). Screens: Build an Agent, Knowledge review.

```json
{ "file": { "id": "file_menu_01", "businessId": "biz_pizza_01", "name": "menu.pdf", "mime": "application/pdf", "sizeBytes": 182044,
  "sha256": "4be0...", "extractionState": "PENDING", "draftFactIds": [], "createdAt": "2026-11-13T19:00:00Z" } }
```

**`GET /api/files/:id?businessId=`**. Returns the same `file` object. `extractionState` is `PENDING`, `EXTRACTING`, `EXTRACTED` or `FAILED` (CONTRACTS.md `FileRecord`). When `EXTRACTED`, `draftFactIds` lists the new drafts and `conflictIds` lists any new conflicts. The UI refetches on `extraction.completed`. Errors: `NOT_FOUND`.

### 3.3 Builder sessions (owner: Saina)

**`POST /api/builder/sessions?businessId=`**. Starts an interview. Body `{}`, or `{ "agentId": "agt_pizza_01" }` to revise an existing agent; that session writes its draft spec to the agent's draft. Response `201`. Errors: `NOT_FOUND` (agent). Events: none. Screens: Build an Agent, Agent details (change instruction field).

```json
{ "id": "bld_01", "businessId": "biz_pizza_01", "status": "active", "messages": [ { "id": "bmsg_01", "sessionId": "bld_01", "role": "assistant", "inputMode": "text", "text": "What would you like an agent to do for your business?", "createdAt": "2026-11-13T19:00:00Z" } ],
  "draftSpec": {}, "missingFields": [], "progress": { "answered": 0, "required": 0 }, "createdAt": "2026-11-13T19:00:00Z", "updatedAt": "2026-11-13T19:00:00Z" }
```

**`GET /api/builder/sessions/:id?businessId=`**. Returns the session as above. Errors: `NOT_FOUND`.

**`POST /api/builder/sessions/:id/messages?businessId=`**. Sends one owner message, typed or transcribed from browser voice (`inputMode: "text" | "voice"`, as on `BuilderMessage`). The server runs one Responses API call with strict Structured Outputs, validates the resulting `AgentSpec` against the registry and computes missing fields. An unsupported request is answered in `reply` and left out of the spec; it is not an error. Errors: `NOT_FOUND`, `INTEGRATION_UNAVAILABLE` (OpenAI). Events: none.

```json
{ "text": "I run a pizza shop and want an AI that takes pickup orders.", "inputMode": "text" }
```

```json
{ "reply": { "id": "bmsg_02", "sessionId": "bld_01", "role": "assistant", "inputMode": "text", "text": "I can do that. What is the latest pickup time you accept on weekdays?", "evidenceRefs": ["fact_hours_fri"], "createdAt": "2026-11-13T19:01:00Z" },
  "draftSpec": { "template": "restaurant_order_taker", "name": "Pizza Order Assistant", "channel": "phone",
    "capabilities": ["catalog.read", "business.facts.read", "order.quote", "order.propose", "order.status.read", "order.checkout.prepare", "message.checkout.send", "sheets.rows.append"] },
  "missingFields": ["policy.pickup_window"], "suggestions": ["Upload menu", "Use Square catalog"], "stopConditions": [], "progress": { "answered": 3, "required": 6 },
  "unsupportedRequests": [] }
```

Every builder message carries `sessionId` and `inputMode`; the server fills them on assistant messages (SPEC 2.9). `unsupportedRequests` is always present and may be empty (SPEC 2.9, section 3.12). `stopConditions` lists PRD section 6 stop conditions that block a draft, for example `{ "code": "missing_timezone" }`.

### 3.4 Agents (owner: Saina, except `sim-call`: Arsh)

Agent summary: `{ id, businessId, name, template, state, activeVersionId?, activeVersion?, draftSpec, isLiveAgent, createdAt, updatedAt }`. `state` is `draft`, `live` or `paused`. AgentVersion: `{ id, agentId, version, spec, knowledgeSnapshotRef, createdBy, publishedAt }`, immutable.

**`GET /api/agents?businessId=`**. Query: `state`, `limit`, `cursor`. Screens: Overview, Agent details.

**`POST /api/agents?businessId=`**. Creates a draft. Body `{ "builderSessionId": "bld_01" }` or `{ "spec": AgentSpec }`. Errors: `NOT_FOUND` (session), `CAPABILITY_NOT_ALLOWED`. Events: none. Screens: Build an Agent.

```json
{ "id": "agt_pizza_01", "businessId": "biz_pizza_01", "name": "Pizza Order Assistant", "template": "restaurant_order_taker", "state": "draft",
  "draftSpec": { "template": "restaurant_order_taker", "capabilities": ["catalog.read", "order.propose"] }, "isLiveAgent": false,
  "createdAt": "2026-11-13T19:05:00Z", "updatedAt": "2026-11-13T19:05:00Z" }
```

**`GET /api/agents/:id?businessId=`**. Returns the agent summary. Errors: `NOT_FOUND`. Screens: Agent preview, Agent details.

**`POST /api/agents/:id/preview?businessId=`**. Runs the draft spec's illustrative example calls against the mock toolset and returns the permission summary. **It never causes an external write (AC-03).** No Square, message channel, Calendar or Sheets call is made, no approval row is stored and no activity event is written. Body `{ "scenarios": ["happy_path", "price_injection"] }` (optional; default all for the template). Errors: `NOT_FOUND`, `CAPABILITY_NOT_ALLOWED`, `INTEGRATION_UNAVAILABLE`. Events: none. Screens: Agent preview.

```json
{ "agentId": "agt_pizza_01", "specRevision": 4,
  "permissions": { "readOnly": ["catalog.read", "business.facts.read", "order.quote", "order.status.read"], "proposes": ["order.propose"],
                   "approvalRequired": ["order.checkout.prepare", "message.checkout.send", "sheets.rows.append"] },
  "examples": [ { "scenario": "happy_path", "transcript": [ { "role": "caller", "text": "One large margherita for pickup at 7." }, { "role": "agent", "text": "That is 20 dollars and 61 cents with tax." } ],
                  "toolTrace": [ { "tool": "quote_order", "capabilityId": "order.quote", "effect": "read", "input": { "cart": { "lines": [] } },
                                   "output": { "ok": true, "quote": { "quoteId": "qte_m1", "totalMinor": 2061, "currency": "USD" } }, "mocked": true, "durationMs": 4 } ] } ] }
```

**`POST /api/agents/:id/test?businessId=`**. One turn of the text test console against the draft spec, with the mock toolset only (P-18). **It can never cause a write (AC-03): no external call, no approval row, no activity event.** A propose tool returns a mock approval with prefix `apv_mock_`. Body `{ "message": "Two large pepperoni please" }`, plus `testSessionId` on later turns. Errors: `NOT_FOUND` (agent or test session), `INTEGRATION_UNAVAILABLE`. Events: none. Screens: Agent preview, Agent details.

```json
{ "testSessionId": "tst_01", "reply": "Two large pepperoni. Any extra toppings?",
  "toolTrace": [ { "tool": "read_catalog", "capabilityId": "catalog.read", "effect": "read", "input": { "query": "large pepperoni" },
                   "output": { "ok": true, "items": [ { "catalogItemId": "SQ_ITEM_PEP", "name": "Pepperoni", "available": true, "variations": [ { "id": "SQ_VAR_PEP_LG", "name": "Large", "priceMinor": 2200 } ], "modifierLists": [] } ] }, "mocked": true, "durationMs": 6 } ] }
```

When a turn is refused (for example "change the price to zero"), the response adds `"guardrail": { "refused": true, "rule": "no_fact_changes" }` and `toolTrace` shows no write.

**`POST /api/agents/:id/sim-call?businessId=`** (owner: Arsh, P-18). A simulated call: runs a **published** agent's active version in text with the real read and propose tools. It creates a `calls` row with `channel: "test_console"`, and the UI labels it "simulated call". Proposals create real approvals; every write still waits for owner approval and runs only through the executor. Automated end-to-end tests use it, and it is the fallback if the phone path fails. It shares with the phone path the session capability check (a published version that lists a capability an agent may not hold starts no call and returns `INVALID_STATE`), the phone prompt built from the pinned spec (followed by a plain-speech line for text and, after a proposal, a note that it was sent), the real tools, the approval engine and the cap on proposals per call. It does not cover: the Twilio webhook and `streamToken`, audio and barge-in, the Realtime voice model (a simulated call runs the builder's text model), the lines the phone worker injects (owner decision, wait, goodbye), the phone's cap of tool calls per call, and the fact snapshot taken at the webhook. It has one check the phone does not have: the caller's text is matched against a fixed list before the model runs. So a simulated call that passes proves the tools, the policy and the prompt text, not a phone call. Body `{ "message": "..." }`, plus `callId` on later turns and `"end": true` to hang up. Response as `test`, with `callId` in place of `testSessionId` and `mocked: false`. One turn may make at most 8 tool calls, and one simulated call may store at most 3 proposals (the phone path's cap, section 5); a tool call past either cap gets `{ ok: false, reason: "VALIDATION_FAILED" }`, and a proposal past the cap also writes `guardrail.refused` with `reasonCode: "proposal_limit"`. Errors: `NOT_FOUND`, `INVALID_STATE` (agent not `live`, or its published version cannot take calls), `INTEGRATION_UNAVAILABLE`, `QUOTE_EXPIRED`. Events: `call.started` (`payload.channel: "test_console"`), `proposal.created`, `approval.requested`, `order.status_changed` or `booking.status_changed`, `guardrail.refused`, `call.ended`. Screens: Agent details, Live operations.

**`POST /api/agents/:id/publish?businessId=`**. Body `{ "confirm": true, "makeLive": true }`. `confirm` must be `true`, else `VALIDATION_FAILED`. The server syncs the catalog cache, checks every Builder stop condition in FLOWS, validates the spec, writes a new immutable AgentVersion, sets the agent `live` and, if `makeLive` is true, points the phone number at it (P-06). A missing required fact returns `VALIDATION_FAILED` with every stop condition code in `details.issues`; a required integration that is down returns `INTEGRATION_UNAVAILABLE`; and an open required FactConflict returns `CONFLICT_UNRESOLVED`. In-flight calls stay pinned to their starting version. Errors: `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT_UNRESOLVED`, `CAPABILITY_NOT_ALLOWED`, `INTEGRATION_UNAVAILABLE`, `ENVIRONMENT_MISMATCH`. Events: `agent.published`, and `live_agent.changed` when `makeLive` moves the number. Screens: Agent preview, Agent details.

```json
{ "agent": { "id": "agt_pizza_01", "state": "live", "activeVersionId": "agv_pizza_01_v2", "isLiveAgent": true },
  "version": { "id": "agv_pizza_01_v2", "agentId": "agt_pizza_01", "version": 2, "spec": { "template": "restaurant_order_taker" },
               "knowledgeSnapshotRef": { "facts": [ { "id": "fact_hours_fri", "version": 1 } ], "catalogSyncedAt": "2026-11-13T19:30:00Z" }, "createdBy": "usr_owner_01", "publishedAt": "2026-11-13T19:30:00Z" },
  "phoneNumber": "+15555550199" }
```

To take a paused agent live again, call `publish`. If the draft has not changed since the active version, no new version is written and the current one is reactivated.

**`POST /api/agents/:id/pause?businessId=`**. Body `{}`. Sets `state: "paused"`. If it was the live agent, the number then answers with a short closed message and hangs up. In-flight calls finish on their pinned version; approved bundles already queued still run. Errors: `NOT_FOUND`, `INVALID_STATE` (agent is `draft`). Events: `agent.paused`. The `live_agent` row does not change. Screens: Agent details, Overview.

**`GET /api/agents/:id/versions?businessId=`**. Lists AgentVersions, newest first. Query: `limit`, `cursor`. Errors: `NOT_FOUND`. Screens: Agent details.

**`POST /api/agents/:id/rollback?businessId=`** (SHOULD). Body `{ "toVersionId": "agv_pizza_01_v1", "confirm": true }`. Moves only the agent's active version back to an earlier immutable version; no version is edited or deleted. A paused agent stays paused. If the agent is live and is the live agent, the number follows. In-flight calls keep their pinned version. Response as `publish`. Errors: `NOT_FOUND`, `INVALID_STATE` (target is already active, or agent is `draft`), `CONFLICT_UNRESOLVED`. Events: `agent.published` (`payload.rolledBackFrom`), and `live_agent.changed` if live. Screens: Agent details.

### 3.5 Owner voice (owner: Saina)

**`POST /api/realtime/client-secret?businessId=`**. Mints a short-lived OpenAI Realtime client secret for owner browser voice in the builder (P-03). The server calls OpenAI `POST /v1/realtime/client_secrets` with the session settings (model `OPENAI_REALTIME_MODEL`, builder voice instructions, no tools). The browser then posts its SDP offer to OpenAI `/v1/realtime/calls` with that secret and talks over WebRTC. **The response never contains `OPENAI_API_KEY`.** The browser sends each final owner transcript to `POST /api/builder/sessions/:id/messages` with `inputMode: "voice"`, so spec logic stays on the server, and the voice session speaks the returned `reply`. Body `{ "builderSessionId": "bld_01" }`. Errors: `NOT_FOUND` (session), `INTEGRATION_UNAVAILABLE`. Events: none. Screens: Build an Agent.

```json
{ "clientSecret": "ek_...", "expiresAt": "2026-11-13T19:11:00Z", "model": "gpt-realtime-2.1", "builderSessionId": "bld_01" }
```

### 3.6 Live agent (owner: Arsh)

One phone number serves both businesses, so this route is owner-scoped (P-06).

**`GET /api/live-agent`**. Returns the LiveAgent (SPEC 2.9). `phoneNumber` and `businessId` are always present. `agentId` and `agentVersionId` are absent when no agent answers the number, which the UI shows as "No agent is answering". If the agent it names is `paused`, the number plays a short closed message. Who made a switch is recorded in the `live_agent.changed` event. Screens: Overview, Agent details.

```json
{ "phoneNumber": "+15555550199", "businessId": "biz_pizza_01", "agentId": "agt_pizza_01", "agentVersionId": "agv_pizza_01_v2", "updatedAt": "2026-11-13T19:30:00Z" }
```

**`PUT /api/live-agent`**. Body `{ "agentId": "agt_barber_01" }`. The server checks the owner owns that agent's business. To leave the number unanswered, pause the live agent. Response as GET. Errors: `NOT_FOUND`, `FORBIDDEN_BUSINESS`, `INVALID_STATE` (agent not `live`). Events: `live_agent.changed`.

### 3.7 Approvals (owner: Arsh)

**`GET /api/approvals?businessId=`**. Query: `state` (default `PENDING`), `bundleType` (`order_bundle`, `booking_bundle`, `fact_edit`, `price_edit`), `limit`, `cursor`. Returns ApprovalRequests. `payload` holds exactly the hashed material fields and never `messageConsent` (CONTRACTS.md section 4); the Approvals screen fetches the subject (`GET /api/orders/:id`, `/api/bookings/:id` or the fact) for itemized lines. Screens: Approvals, Overview (count), Live operations.

**`GET /api/approvals/:id?businessId=`**. Returns one ApprovalRequest. Errors: `NOT_FOUND`.

```json
{ "id": "apv_123", "businessId": "biz_pizza_01", "actorType": "deployed_agent", "bundleType": "order_bundle",
  "actionBundle": ["square.checkout.create", "message.checkout.send", "local.order.record", "sheets.order.append"], "subjectId": "ord_123",
  "payload": { "businessId": "biz_pizza_01", "subjectId": "ord_123", "agentVersionId": "agv_pizza_01_v2", "cartHash": "sha256:ab12...", "totalMinor": 3264,
               "currency": "USD", "pickupAt": "2026-11-14T02:00:00Z", "messageRecipient": "+15555550123", "messageChannel": "surge",
               "actionBundle": ["square.checkout.create", "message.checkout.send", "local.order.record", "sheets.order.append"], "expiresAt": "2026-11-13T19:52:00Z" },
  "payloadHash": "sha256:77fe...", "state": "PENDING", "expiresAt": "2026-11-13T19:52:00Z", "createdAt": "2026-11-13T19:42:00Z" }
```

**`POST /api/approvals/:id/decision?businessId=`**. Body `{ "decision": "approve" | "reject", "payloadHash": "sha256:77fe..." }`, with the hash the UI displayed. Optional `Idempotency-Key` header. The database routine `private.decide_and_enqueue` (migration 0004) makes these checks in one transaction with a row lock:
1. Approval exists in this business, else `NOT_FOUND`.
2. `payloadHash` equals the stored hash, else `PAYLOAD_HASH_MISMATCH`.
3. If the approval is already decided and the request repeats the same outcome from the same owner with the same `reason`, return `200` with the current approval. The routine updates nothing and writes no second `approval.decided` event. The one thing it may still do is create execution rows that an earlier, partly completed approval left missing. A double click or retry is safe (AC-10).
4. If `state` is the other outcome, `APPROVAL_ALREADY_DECIDED`. The routine also refuses a repeat whose `reason` differs from the recorded one. If `state` is `EXPIRED`, or the approval is `PENDING` and `now >= expiresAt`, `APPROVAL_EXPIRED`. A late decision does not change the row: it stays `PENDING` until the expiry job runs.
5. Record the decision. On approve, enqueue one execution per action type except the Sheets step, each with the SPEC 2.9 idempotency key, and return at once. The message step is created already `SKIPPED` when the approval's `messageChannel` is `qr_only`. The Sheets sync job is created later, when the subject reaches `PAID_VERIFIED` or `BOOKED_VERIFIED` (SPEC 2.9). On reject, move the subject to `REJECTED`; no external call is made (AC-08).

Response `200`. Execution progress arrives only as activity events; the response never waits for a provider.

```json
{ "approval": { "id": "apv_123", "state": "APPROVED", "decidedBy": "usr_owner_01", "decidedAt": "2026-11-13T19:44:10Z" } }
```

Errors: `NOT_FOUND`, `PAYLOAD_HASH_MISMATCH`, `APPROVAL_ALREADY_DECIDED`, `APPROVAL_EXPIRED`, `ENVIRONMENT_MISMATCH` (approve of an `order_bundle` or `price_edit`). Events: `approval.decided` when the decision is recorded (an identical repeat writes no second one), plus `order.status_changed` or `booking.status_changed` on every transition of the subject. Then from the executor:
- `order_bundle`: `execution.started`, `checkout.created`, `message.sent` or `message.failed`, `execution.succeeded` or `execution.failed`, later `payment.verified` or `payment.failed` from the webhook job, then `sync.queued` and `sync.succeeded` or `sync.failed` once the order is `PAID_VERIFIED` (SPEC 2.3).
- `booking_bundle`: `execution.started` and `execution.succeeded` for each step, or `booking.slot_conflict` with `execution.failed` if the slot is taken; `message.sent` or `message.failed`; `booking.verified` when `local.booking.record` moves the booking to `BOOKED_VERIFIED`; then the Sheets `sync.*` events.
- `fact_edit`: see 3.1. `price_edit`: see 3.1.

A background job calls `private.expire_approvals`, which sets each `PENDING` approval that has reached `expiresAt` to `EXPIRED` and emits `approval.expired`. It emits the subject's status event only when an order or booking still in `AWAITING_OWNER_APPROVAL` actually moves. Screens: Approvals, Live operations, Knowledge review (confirm dialog).

### 3.8 Orders (owner: Arsh)

**`GET /api/orders?businessId=`**. Query: `status` (comma list), `callId`, `limit`, `cursor`. Newest first. Screens: Overview, Live operations.

**`GET /api/orders/:id?businessId=`**. Returns one Order. Errors: `NOT_FOUND`. Screens: Live operations, Approvals.

```json
{ "id": "ord_123", "businessId": "biz_pizza_01", "callId": "call_77", "status": "PAYMENT_PENDING", "totalMinor": 3264, "currency": "USD",
  "cart": { "lines": [ { "catalogItemId": "SQ_ITEM_PEP", "variationId": "SQ_VAR_PEP_LG", "quantity": 2, "modifierIds": ["SQ_MOD_XCHEESE"] } ] },
  "cartHash": "sha256:ab12...", "quote": { "quoteId": "qte_1", "cartHash": "sha256:ab12...", "subtotalMinor": 3000, "taxMinor": 264, "totalMinor": 3264,
    "currency": "USD", "lines": [], "quotedAt": "2026-11-13T19:40:00Z", "expiresAt": "2026-11-13T19:45:00Z" },
  "contact": { "name": "Sam", "messageRecipient": "+15555550123", "messageConsent": true, "consentAt": "2026-11-13T19:41:00Z" },
  "fulfillment": { "type": "pickup", "pickupAt": "2026-11-14T02:00:00Z" }, "approvalId": "apv_123",
  "squareOrderId": "SQ_ORD_9", "squarePaymentLinkId": "SQ_PL_4", "checkoutUrl": "https://sandbox.square.link/u/abc",
  "createdAt": "2026-11-13T19:42:00Z", "updatedAt": "2026-11-13T19:45:00Z" }
```

**`GET /api/orders/:id/checkout?businessId=`**. Link and QR data for Live operations. The QR code is the always-on backup (D-08). `ready` is `false` until the Square payment link exists. `message` is absent when no dispatch exists (always, under `qr_only`); its fields are `MessageDispatch` fields (CONTRACTS.md). Errors: `NOT_FOUND`. Events: none. Screens: Live operations.

```json
{ "orderId": "ord_123", "ready": true, "environment": "sandbox", "checkoutUrl": "https://sandbox.square.link/u/abc", "qrText": "https://sandbox.square.link/u/abc",
  "squarePaymentLinkId": "SQ_PL_4", "message": { "id": "msg_31", "channel": "surge", "status": "SENT", "sentAt": "2026-11-13T19:45:02Z" } }
```

### 3.9 Bookings (owner: Arsh)

**`GET /api/bookings?businessId=`**. Query: `status`, `from`, `to` (UTC, on `startUtc`), `limit`, `cursor`. Screens: Overview, Live operations.

**`GET /api/bookings/:id?businessId=`**. Returns one Booking. Errors: `NOT_FOUND`. Screens: Live operations, Approvals.

```json
{ "id": "bkg_12", "businessId": "biz_barber_01", "callId": "call_80", "status": "BOOKED_VERIFIED", "serviceId": "svc_cut", "serviceName": "Haircut",
  "calendarId": "demo-barber@group.calendar.google.com", "startUtc": "2026-11-14T18:00:00Z", "endUtc": "2026-11-14T18:30:00Z", "timezone": "America/Los_Angeles",
  "customer": { "name": "Ana", "messageRecipient": "+15555550124", "messageConsent": true }, "approvalId": "apv_200",
  "googleEventId": "3f9a0c...", "createdAt": "2026-11-13T20:00:00Z", "updatedAt": "2026-11-13T20:02:00Z" }
```

### 3.10 Activity (owner: Arsh)

**`GET /api/activity?businessId=`**. The paged audit list. Query: `types` (comma list of SPEC 2.5 types), `correlationId`, `since` (UTC), `limit`, `cursor`. Newest first. Payloads are redacted. Screens: Overview, Live operations, Agent details.

```json
{ "items": [ { "id": "evt_901", "businessId": "biz_pizza_01", "type": "payment.verified", "correlationId": "call_77", "actorType": "provider",
               "occurredAt": "2026-11-13T19:47:30Z", "payload": { "orderId": "ord_123", "squarePaymentId": "SQ_PAY_2", "amountMinor": 3264, "currency": "USD", "sandbox": true } } ],
  "nextCursor": "eyJvIjoiZXZ0XzkwMCJ9" }
```

### 3.11 Integrations health (owner: Arsh)

**`GET /api/integrations/health?businessId=`**. Returns `IntegrationHealth` (CONTRACTS.md): one entry per SPEC 2.9 provider key. Query: `refresh=1` runs live checks now; otherwise the last stored results return. Events: none. Screens: top bar, Overview.

```json
{ "square": { "state": "connected", "environment": "sandbox", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "twilio": { "state": "connected", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "openai": { "state": "connected", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "google_calendar": { "state": "degraded", "detail": "free/busy slow", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "google_sheets": { "state": "disconnected", "detail": "sheet not shared", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "message_channel": { "state": "connected", "channel": "surge", "detail": "18 of 25 messages left", "lastCheckedAt": "2026-11-13T19:00:00Z" } }
```

`state` is `connected`, `degraded` or `disconnected` (CONTRACTS.md). `square.environment` is always `"sandbox"`; the server will not start otherwise (AC-19).

### 3.12 Added at the contract freeze (issue #56)

The UI lead's review of every screen found these missing. All are in `packages/contracts` (task S-02).

| Endpoint | Owner | Tier | Returns | Screens |
|---|---|---|---|---|
| `GET /api/businesses/:id/catalog` | Arsh | MUST | `{ items: CatalogItem[], syncedAt }`. Items are grouped, each with its `variations` array. | Knowledge review, price edit |
| `GET /api/calls?businessId=&agentId=&since=&limit=&cursor=` | Arsh | MUST | `Page<Call>` | Overview, Agent details, Live operations |
| `GET /api/calls/:id?businessId=` | Arsh | MUST | `Call` | Live operations |
| `POST /api/conflicts/:id/resolve?businessId=` | Saina | MUST | `{ conflict: FactConflict }` | Knowledge review |
| `GET /api/telemetry?businessId=&since=` | Arsh | SHOULD | `{ metrics: [{ name, p50Ms, p95Ms, count }] }` | Telemetry panel |
| `POST /api/orders/:id/cancel?businessId=` | Arsh | SHOULD | `{ order: Order }` | Live operations |
| `POST /api/executions/:id/resolve?businessId=` | Arsh | SHOULD | `{ execution: ActionExecution }` | Live operations |

Details:
- `POST /api/conflicts/:id/resolve` takes `{ "resolution": "keep_authoritative" }`. It marks the conflict `resolved` and the draft fact `superseded`. It writes nothing external, so it needs no approval. Choosing the uploaded value over a Square price is not a fact edit: it is a price change and goes through `POST /api/businesses/:id/catalog/prices/propose` (SHOULD). Until that exists, the screen tells the owner to change the price in Square and sync.
- `POST /api/executions/:id/resolve` takes `{ "action": "retry" | "abandon" }`. It covers a step in `NEEDS_REVIEW`, a booking in `RETRY_REQUIRED` and a message in `UNKNOWN`. A retry reuses the original idempotency key. This and the cancel route are proposal P-19 in `docs/SPEC.md`. Until they exist, leave these buttons out. The database cannot serve this route today: migration 0004 has no routine that moves a step out of `NEEDS_REVIEW`, and `update_dispatch` refuses every change to a dispatch in `UNKNOWN`. Migration 0005, not yet applied, adds the routine for resolving a `NEEDS_REVIEW` step.
- There is no "mark ready" route. The server sets `FULFILLMENT_READY` itself.
- Telemetry metric names: `call_answer_latency`, `first_audio`, `tool_latency`, `approval_time`, `webhook_delay`.

Two fields are added to the response of `POST /api/builder/sessions/:id/messages`:
- `unsupportedRequests: string[]`, always present and possibly empty. Each entry is one thing the owner asked for that no registered capability covers.
- `proposedChange?: { approvalId, bundleType }`, present when the turn created a `fact_edit` or `price_edit` approval. The UI opens the confirm dialog for that approval.

`Business` carries `contact: { phone?, email?, address? }`. The business location is `contact.address`.

Response shapes have named schemas in `packages/contracts`, so the UI never redefines one: `Business`, `Agent`, `AgentVersion`, `PreviewResponse`, `PublishResponse`, `BuilderTurnResponse`, `FactsListResponse`, `OrderCheckout`, and the `Page<T>` envelope `{ items, nextCursor? }`.

`GET /api/live-agent` returns `phoneNumber` and `businessId` always. `agentId` and `agentVersionId` are absent when no agent answers the number.

## 4. Webhooks (owner: Arsh)

Webhooks are called by providers, never by the browser, and carry no Supabase JWT. Each one verifies the signature on the raw body, deduplicates, persists, enqueues a job and responds fast. Slow work (Square API reads, state transitions, events) runs in the job. Fastify keeps the raw body for `/webhooks/*` with a content-type parser that stores the buffer before parsing. Only signature-verified events are stored in `webhook_events`, so a forged request can never claim a real event ID. A request that fails verification gets `401 SIGNATURE_INVALID` and writes one `webhook.rejected` activity event and nothing else (SPEC 2.9).

| Endpoint | Signature check | Dedupe key in `webhook_events` | Response |
|---|---|---|---|
| `POST /webhooks/twilio/voice` | `X-Twilio-Signature` validated with `TWILIO_AUTH_TOKEN` over the exact public URL plus the form params (`twilio.validateRequest`) | `calls.provider_call_id = CallSid` is unique; a retry finds the row and returns the same TwiML | TwiML, under 1 second, no LLM call |
| `POST /webhooks/twilio/status` | Same as above | `source = "twilio_status"`, `provider_event_id = CallSid:CallStatus`, or `MessageSid:MessageStatus` when the channel is `whatsapp_sandbox` | `204`, then a job |
| `POST /webhooks/square` | `x-square-hmacsha256-signature` compared in constant time with HMAC-SHA256, keyed with `SQUARE_WEBHOOK_SIGNATURE_KEY`, over `SQUARE_WEBHOOK_URL` (the exact registered URL) followed by the raw body. Spike B-02 confirms whether the header is base64 | `source = "square"`, `provider_event_id = event_id`, unique on the pair | `200` well within Square's 10 seconds, then a job |

**`/webhooks/twilio/voice`.** Twilio posts `CallSid`, `From`, `To`. The server reads `live_agent`, creates the `calls` row (`channel: "phone"`, status `IN_PROGRESS`), pins `agentVersionId` to the live version at that moment, mints the `streamToken`, emits `call.started` and returns:

```xml
<Response><Connect><Stream url="wss://SERVER/ws/phone">
  <Parameter name="callId" value="call_77"/><Parameter name="streamToken" value="st_..."/>
</Stream></Connect></Response>
```

If the agent named in `live_agent` is not `live` (it is paused), it returns `<Say>` with a short closed message and `<Hangup/>`, and emits `call.started` then `call.ended` (`reason: "completed"`). That call row is created and ended in the webhook, with no `streamToken`, no fact snapshot and no model session. When no agent answers the number at all, the same closed message plays and no `calls` row is written, because a call row needs an agent and a version.

**`/webhooks/twilio/status`.** The job maps `CallStatus` `completed` to `COMPLETED`, `busy`, `no-answer` and `canceled` to `DROPPED`, and `failed` to `FAILED`, and emits `call.ended` with `reason` once per call, whichever of this callback or the stream `stop` comes first. A call that ends before customer confirmation produces no approval (AC-18). Message status is handled only when the channel is `whatsapp_sandbox`: it updates `message_dispatches` and emits `message.failed` on failure.

**`/webhooks/square`.** The job handles `payment.created` and `payment.updated`. It ignores the payload's claimed state, reads the payment from the Square API, and marks the order `PAID_VERIFIED` only when the payment is `COMPLETED` and its `order_id`, amount, currency and location match the stored order (AC-11). It does not wait for the Square order state. Delivery order is not guaranteed, so the job always compares against current Square state. Outcomes emit `payment.verified` or `payment.failed` and `order.status_changed`, then queue the Sheets row. The payment poller (every 30 seconds for 15 minutes after the link is ready) resolves a missed webhook through the same code path.

## 5. `/ws/phone` (owner: Arsh)

Not a browser endpoint. Only Twilio Media Streams connects here, opened by the TwiML above. Audio is `audio/x-mulaw`, 8000 Hz, mono, passed to OpenAI Realtime as `g711_ulaw`.

| Twilio event | What it carries | Server action |
|---|---|---|
| `connected` | protocol and version | Wait for `start`. Close if `start` does not arrive in 5 seconds. |
| `start` | `streamSid`, `start.callSid`, `start.customParameters` (`callId`, `streamToken`), `start.mediaFormat` | Bind the stream (below), open the Realtime session with the pinned version's instructions and tools. |
| `media` | `media.payload` (base64 mulaw), `media.timestamp`, `media.track` | Append to the Realtime input buffer. |
| `mark` | `mark.name`, echoed after Twilio played our audio up to that point | Track what the caller has heard, for barge-in truncation. |
| `stop` | `stop.callSid` | Close the Realtime session, end the call, emit `call.ended` if not yet emitted. |

The server sends Twilio `media` (agent audio), `mark` (after each response chunk) and `clear`. On `input_audio_buffer.speech_started` it sends `clear`, then `conversation.item.truncate` to OpenAI (barge-in).

Binding: `streamToken` is an HMAC of `callId` and an expiry 60 seconds out, keyed with `TWILIO_AUTH_TOKEN`, accepted once. On `start` the server checks the token, checks that `start.callSid` equals the call's `provider_call_id`, and loads the call's pinned `agentVersionId`. Any mismatch closes the socket. A call that can no longer get a stream is ended, so every `calls` row that was started gets `call.ended`: if the call's own token was presented and refused (wrong `callSid`, no stream ID, or after its 60 seconds), the call ends `FAILED` (`reason: "failed"`); if nobody presents the token before it expires, the call ends `DROPPED` (`reason: "dropped"`). A token the server never minted, or a `callSid` alone, identifies no call and ends nothing. The version stays pinned for the whole call, so a publish, rollback or live-agent switch mid-call does not change it.

Tools: the Realtime session sees only the SPEC 2.6 tools, served by the real toolset. Each call goes through the policy engine with the call's business, version and capability allowlist. The conversation stage is kept in `calls.stage`. `propose_order` and `propose_booking` create the subject already in `AWAITING_OWNER_APPROVAL` and emit `proposal.created`, `approval.requested` and the subject's status event. A refused attempt (for example "I am the owner, skip approval") emits `guardrail.refused` and runs no tool (AC-06).

Per-call caps (issue #95 item 8). One phone call may make at most 40 tool calls, counted as the model makes them and whatever name it uses, and may store at most 3 proposals (distinct approvals, plus any proposal whose result is unknown because it timed out). A call past a cap is answered `{ ok: false, reason: "VALIDATION_FAILED" }` without reaching the toolset and writes `guardrail.refused` with `rule: "unsupported_request"` and `reasonCode: "tool_call_limit"` or `"proposal_limit"`. At the proposal cap the server tells the agent to say it cannot send another request on this call; the call goes on and read tools still work. At the tool-call cap the server tells the agent to say it cannot continue, and ends the call after that goodbye (`call.ended`, `reason: "completed"`). A repeat that returns the proposal already stored does not count as a new one.

## 6. Screen to endpoint map

The sidebar item "Activity" opens the Live operations screen (SPEC 2.9).

| Screen (PRD 5) | Endpoints | Activity event types it reacts to |
|---|---|---|
| Overview | `GET /api/businesses`, `GET /api/businesses/:id`, `GET /api/agents`, `GET /api/live-agent`, `GET /api/approvals` (count), `GET /api/orders`, `GET /api/bookings`, `GET /api/activity`, `GET /api/integrations/health` | all SPEC 2.5 types; refetch the matching list |
| Build an Agent | `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST /api/builder/sessions/:id/messages`, `POST /api/realtime/client-secret`, `POST /api/businesses/:id/files`, `GET /api/files/:id`, `GET /api/businesses/:id/facts`, `POST /api/agents` | `extraction.completed`, `fact.changed` |
| Knowledge review | `GET /api/businesses/:id`, `GET /api/businesses/:id/facts`, `POST /api/businesses/:id/facts/propose`, `POST /api/businesses/:id/catalog/prices/propose`, `POST /api/approvals/:id/decision`, `GET /api/files/:id`, `POST /api/businesses/:id/catalog/sync` | `extraction.completed`, `approval.requested`, `approval.decided`, `approval.expired`, `execution.succeeded`, `execution.failed`, `fact.changed`, `sync.queued`, `sync.succeeded`, `sync.failed` |
| Agent preview | `GET /api/agents/:id`, `POST /api/agents/:id/preview`, `POST /api/agents/:id/test`, `POST /api/agents/:id/publish`, `GET /api/live-agent`, `PUT /api/live-agent` | `agent.published`, `live_agent.changed` |
| Agent details | `GET /api/agents/:id`, `GET /api/agents/:id/versions`, `POST /api/agents/:id/test`, `POST /api/agents/:id/sim-call`, `POST /api/agents/:id/publish`, `POST /api/agents/:id/pause`, `POST /api/agents/:id/rollback`, `POST /api/builder/sessions` (with `agentId`), `GET /api/businesses/:id/facts`, `POST /api/businesses/:id/facts/propose`, `GET /api/activity` (filtered) | `agent.published`, `agent.paused`, `live_agent.changed`, `call.started`, `call.ended`, `fact.changed`, `guardrail.refused` |
| Live operations | `GET /api/activity`, `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/checkout`, `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decision`, `POST /api/agents/:id/sim-call` | `call.started`, `call.ended`, `proposal.created`, `approval.requested`, `approval.decided`, `approval.expired`, `execution.started`, `execution.succeeded`, `execution.failed`, `checkout.created`, `message.sent`, `message.failed`, `payment.verified`, `payment.failed`, `booking.verified`, `booking.slot_conflict`, `order.status_changed`, `booking.status_changed`, `sync.queued`, `sync.succeeded`, `sync.failed`, `guardrail.refused`, `webhook.rejected` |
| Approvals | `GET /api/approvals`, `GET /api/approvals/:id`, `GET /api/orders/:id`, `GET /api/bookings/:id`, `POST /api/approvals/:id/decision` | `approval.requested`, `approval.decided`, `approval.expired`, `execution.started`, `execution.succeeded`, `execution.failed` |

The routes added in section 3.12 list their screens in that section's own table: Knowledge review and price edit (catalog read, conflict resolve), Overview, Agent details and Live operations (calls), the telemetry panel, and Live operations (cancel and resolve).

## 7. Mock layer notes

`NEXT_PUBLIC_MOCK=1` makes `apps/web` start MSW from `apps/web/mocks` and serve fixtures from `packages/contracts`. With the flag off, every call goes to `NEXT_PUBLIC_API_URL`. UI code calls one client module and never checks the flag itself.

Nothing is cut (D-09), so the handlers cover every endpoint in section 3. Build them MUST tier first, in this order:
1. `GET /api/businesses`, `GET /api/businesses/:id`, `PATCH /api/businesses/:id`, `GET /api/integrations/health`, `GET /api/live-agent`, `PUT /api/live-agent`.
2. `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST /api/builder/sessions/:id/messages` (a canned interview of 5 to 6 turns ending in a full pizza spec, and one for the barbershop), `POST /api/realtime/client-secret` (returns a fake secret; mock mode falls back to typed input), `POST /api/agents`, `GET /api/agents`, `GET /api/agents/:id`.
3. `POST /api/businesses/:id/files`, `GET /api/files/:id` (moves to `EXTRACTED` after 3 seconds and emits `extraction.completed`), `GET /api/businesses/:id/facts` (with one open conflict), `POST /api/businesses/:id/facts/propose`, `POST /api/businesses/:id/catalog/sync`.
4. `POST /api/agents/:id/preview`, `POST /api/agents/:id/test` (tool traces and one guardrail refusal), `POST /api/agents/:id/publish` (one fixture returns `CONFLICT_UNRESOLVED`), `POST /api/agents/:id/pause`, `GET /api/agents/:id/versions`, `POST /api/agents/:id/sim-call`.
5. `GET /api/approvals`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decision` (fixtures for `PAYLOAD_HASH_MISMATCH` and `APPROVAL_EXPIRED`).
6. `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/checkout`, `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/activity`.

Then SHOULD: `POST /api/agents/:id/rollback`, `POST /api/businesses/:id/catalog/prices/propose`.

The mock activity feed replaces Supabase Realtime in mock mode. It emits ActivityEvents through the same subscriber interface the UI uses for Realtime. After a mocked approve of an order bundle it plays the order sequence of section 3.7 on timers about 1.5 seconds apart, changing the mocked Order status to match, so Live operations can be built and rehearsed before the backend exists. It plays the booking sequence the same way, with one fixture that ends in `booking.slot_conflict`. It also has triggers for an incoming call (`call.started`, `proposal.created`, `approval.requested`) and a rejected webhook (`webhook.rejected`).

## 8. Names added by this doc

Paths, fields and values that SPEC v1.1 does not define. Error codes are defined here by SPEC 2.9, so they are not listed.

| Added | Where |
|---|---|
| Header `Retry-After`; 24-hour replay of `Idempotency-Key` | sections 1 and 2 |
| Request fields: `reason`, `resolvesConflictId` (facts propose); `variationId`, `newPriceMinor` (prices propose); `scenarios` (preview); `message`, `end` (test, sim-call); `makeLive`, `confirm` (publish, rollback); `toVersionId` (rollback); `builderSessionId` (client secret) | section 3 |
| Response fields: `conflicts`, `suggestions`, `stopConditions`, `progress`, `toolTrace` (`tool`, `capabilityId`, `effect`, `input`, `output`, `mocked`, `durationMs`), `guardrail`, `permissions`, `examples`, `specRevision`, `isLiveAgent`, `phoneNumber`, `ready`, `qrText`, `environment`, `message` (checkout), the `knowledgeSnapshotRef` keys `facts` and `catalogSyncedAt` | section 3 |
| Accepted upload MIME types | section 3.2 |
| `streamToken` recipe (HMAC with `TWILIO_AUTH_TOKEN`, 60 seconds, single use); Twilio status dedupe keys; CallStatus to Call state mapping | sections 4 and 5 |

Still open:
1. Whether the Square signature header value is base64 (spike B-02, SPEC 2.9).
2. The owner recovery actions (cancel an order, retry or abandon a stuck step) are defined in section 3.12 as SHOULD-tier routes (SPEC proposal P-19). Until they are built, leave those buttons out.
