# AI Business OS: Contracts

**Version:** 1.1 (conforms to SPEC v1.1) | **Date:** 2026-11-13 | **Frozen at:** hour 2 | **Edited by:** Arsh | **Reviewed by:** Saina

This is the contract freeze. Both apps code against it. Task S-02 transcribes it into Zod schemas in `packages/contracts`. Names in `docs/SPEC.md` section 2 are binding. For a field name that no SPEC ruling covers, this file wins (SPEC 2.9). Names this file invented are listed in section 11.

## 1. Conventions

- JSON fields are camelCase. Database columns are snake_case. The mapping is mechanical (`totalMinor` is `total_minor`).
- Money is an integer in minor units (`amountMinor`, `totalMinor`, `priceMinor`) with a separate `currency`. The only currency is `"USD"`.
- Timestamps are ISO 8601 UTC strings ending in `Z`. Local times are never stored, only an IANA `timezone` next to a UTC value. Both businesses use `America/Los_Angeles`.
- Phone numbers are E.164 (`+15555550123`). Events and logs show only the last four digits.
- IDs are prefixed text, using exactly the list in SPEC 2.1 (`usr_`, `biz_`, `agt_`, `agv_`, `ord_`, `qte_`, `bkg_`, `svc_`, `apv_`, `exe_`, `call_`, `evt_`, `msg_`, `fact_`, `cfl_`, `file_`, `job_`, `bld_`, `bmsg_`, `tst_`, `int_`, `cat_`, `whk_`, `syn_`). The mock toolset returns approvals prefixed `apv_mock_`. Square IDs (`squareItemId`, `catalogItemId`, `variationId`, `modifierIds`) are Square's own, unprefixed.
- Optional fields are absent, never `null`. `?` below marks optional. A field written without a type is `string`.
- Every error has one shape. `ErrorCode` is exactly the table in `docs/API.md` section 2. The last three codes are also used as `errorCode` on executions and as tool failure reasons.

```ts
type ApiError = {
  code: ErrorCode;
  message: string;          // safe for the owner UI; no secrets, no full phone numbers
  correlationId: string;    // also sent as the X-Correlation-Id header
  retryable: boolean;       // true only if the same request may be sent again unchanged
  details?: Record<string, unknown>; // sanitized
};
type ErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN_BUSINESS" | "NOT_FOUND" | "VALIDATION_FAILED" | "INVALID_STATE"
  | "CONFLICT_UNRESOLVED" | "APPROVAL_EXPIRED" | "APPROVAL_ALREADY_DECIDED" | "PAYLOAD_HASH_MISMATCH"
  | "CAPABILITY_NOT_ALLOWED" | "INTEGRATION_UNAVAILABLE" | "ENVIRONMENT_MISMATCH" | "SIGNATURE_INVALID"
  | "RATE_LIMITED" | "INTERNAL" | "QUOTE_EXPIRED" | "ITEM_UNAVAILABLE" | "SLOT_CONFLICT";
```

## 2. Capability registry

The registry is server-owned code in `packages/contracts/src/capabilities.ts`. The LLM may request a capability by `id`. It can never register one or change its `effect`.

```ts
type Capability = {
  id: CapabilityId; description: string;
  effect: "read" | "propose" | "write" | "external_message";
  approvalMode: "none" | "creates_approval" | "required";
  requiredScopes: string[];   // checked by the policy engine against the agent version
  handlerId: string;          // server function that runs it
  timeoutMs: number;
  tier: "MUST" | "SHOULD";
  inputSchema: ZodSchema; outputSchema: ZodSchema;
};
```

**Rule:** an agent that talks to callers (phone, sim-call or test console) may only be given `read` and `propose` capabilities as tools. A spec that offers a `write` or `external_message` capability as a tool fails publish with `CAPABILITY_NOT_ALLOWED`. Those capabilities appear in `AgentSpec.capabilities` only as the bundle the executor may run after approval.

| id | effect | approvalMode | requiredScopes | handlerId | timeoutMs | tier |
|---|---|---|---|---|---|---|
| `catalog.read` | read | none | `catalog:read` | `catalog.searchCache` | 1500 | MUST |
| `business.facts.read` | read | none | `facts:read` | `facts.readVerified` | 1000 | MUST |
| `order.quote` | read | none | `square:orders.calculate` | `square.calculateOrder` | 5000 | MUST |
| `order.propose` | propose | creates_approval | `orders:propose` | `orders.propose` | 6000 | MUST |
| `order.status.read` | read | none | `orders:read` | `orders.readStatus` | 1000 | MUST |
| `order.checkout.prepare` | write | required | `square:checkout.write` | `square.createPaymentLink` | 10000 | MUST |
| `message.checkout.send` | external_message | required | `message:send` | `message.sendCheckout` | 10000 | MUST |
| `calendar.availability.read` | read | none | `calendar:freebusy` | `calendar.freeBusy` | 4000 | MUST |
| `booking.propose` | propose | creates_approval | `bookings:propose` | `bookings.propose` | 6000 | MUST |
| `calendar.event.create` | write | required | `calendar:events.write` | `calendar.insertEvent` | 8000 | MUST |
| `message.booking.confirm` | external_message | required | `message:send` | `message.sendBookingConfirm` | 10000 | MUST |
| `sheets.rows.append` | write | required | `sheets:append` | `sheets.appendRow` | 8000 | MUST |
| `catalog.price.update` | write | required | `square:catalog.write` | `square.updateVariationPrice` | 8000 | SHOULD |

Input and output shapes. Server context (`businessId`, `callId`, `agentVersionId`, `correlationId`) is never part of a model-supplied input. The `write` and `external_message` rows are called by the executor only.

| Capability | Input | Output |
|---|---|---|
| `catalog.read` | `{ query?; includeUnavailable?: boolean }` (empty query returns the whole cached menu) | `{ items: CatalogItem[]; syncedAt }` |
| `business.facts.read` | `{ kinds?: FactKind[] }` (default hours, policy, service, contact, faq; `menu_item` facts are drafts and never returned) | `{ facts: { kind: FactKind; key; value: unknown; version: number }[]; timezone }`, verified only |
| `order.quote` | `{ cart: Cart }` | `Quote` |
| `order.propose` | `{ cart: Cart; contact: Contact; fulfillment: Fulfillment; quoteId }` | `{ proposalId?; quote?: Quote; missingFields: string[]; approvalId? }` |
| `order.status.read` | `{ orderId }` (same business, and same call for a caller) | `{ orderId; status: OrderStatus; paid: boolean; checkoutLinkSent: boolean }` |
| `order.checkout.prepare` | `{ orderId; approvalId }` | `{ squareOrderId; squarePaymentLinkId; checkoutUrl }` |
| `message.checkout.send` | `{ orderId; approvalId }` | `{ dispatchId?; status: MessageDispatchStatus \| "SKIPPED" }` (`SKIPPED` and no `dispatchId` when `MESSAGE_CHANNEL` is `qr_only`) |
| `calendar.availability.read` | `{ serviceId; date: "YYYY-MM-DD" (business timezone); maxSlots?: number (1 to 5, default 5) }` | `{ slots: AvailabilitySlot[]; timezone }` on a 15 minute grid |
| `booking.propose` | `{ serviceId; startUtc; customer: BookingCustomer }` | `{ proposalId?; approvalId?; missingFields: string[]; slot?: AvailabilitySlot }` |
| `calendar.event.create` | `{ bookingId; approvalId }` | `{ googleEventId; calendarId }` |
| `message.booking.confirm` | `{ bookingId; approvalId }` | `{ dispatchId?; status: MessageDispatchStatus \| "SKIPPED" }` (same `qr_only` rule) |
| `sheets.rows.append` | `{ recordType: "order" \| "booking"; recordId }` | `{ syncJobId }`; the job owns the append |
| `catalog.price.update` | `{ squareItemId; variationId; newPriceMinor: number; currency: "USD"; approvalId }` | `{ variationId; priceMinor: number; squareVersion: number }` |

**Bundles and action types (SPEC 2.3).** `bundleType` names the kind of bundle on an approval. `actionType` names one step.

| `bundleType` | Action types, in order |
|---|---|
| `order_bundle` | `square.checkout.create`, `message.checkout.send`, `local.order.record`, `sheets.order.append` |
| `booking_bundle` | `calendar.event.create`, `message.booking.confirm`, `local.booking.record`, `sheets.booking.append` |
| `fact_edit` | `local.fact.update` |
| `price_edit` (SHOULD) | `square.catalog.price.update`, `local.catalog.sync` |

| Action type | Capability it exercises |
|---|---|
| `square.checkout.create` | `order.checkout.prepare` |
| `message.checkout.send` | `message.checkout.send` |
| `calendar.event.create` | `calendar.event.create` |
| `message.booking.confirm` | `message.booking.confirm` |
| `sheets.order.append`, `sheets.booking.append` | `sheets.rows.append` |
| `square.catalog.price.update` | `catalog.price.update` |
| `local.order.record`, `local.booking.record`, `local.fact.update`, `local.catalog.sync` | none: internal steps that write only our database, inside an approved bundle |

Step rules: `local.order.record` and `local.booking.record` copy the external references onto the order or booking and write its state transition after the external steps. The Sheets step is authorized by the approval, but no `ActionExecution` and no sync job is created for it at approval. The transition into `PAID_VERIFIED` or `BOOKED_VERIFIED` creates its sync job. An order that is never paid has no Sheets row and no pending job. The step never blocks or reverses another step. A message step that fails or has an unknown result does not fail the order or booking, because the dashboard QR code still carries the link. When `MESSAGE_CHANNEL` is `qr_only`, the message step's execution is `SKIPPED` and no `MessageDispatch` is created.

## 3. Core schemas

```ts
type AgentStatus = "draft" | "live" | "paused";
type AgentSpec = {
  id: string; businessId: string;
  version: number;            // matches agent_versions.version
  template: "restaurant_order_taker" | "appointment_booker" | "custom";
  name: string; channel: "phone";
  goal: string;               // one sentence, shown in preview
  knowledgeScopes: ("business_profile" | "catalog" | "hours" | "order_policies" | "services" | "faq")[];
  capabilities: CapabilityId[]; // tools (read, propose) plus the executor bundle (write, external_message)
  writePolicy: "owner_approval_each_action_bundle";
  escalation: "explain_unsupported_or_offer_callback";
  status: AgentStatus;
  guardrailVersion: "v1";
  greeting?: string;          // first line spoken; must disclose it is an AI assistant
};
// Pizza capabilities: catalog.read, business.facts.read, order.quote, order.propose, order.status.read,
//   order.checkout.prepare, message.checkout.send, sheets.rows.append
// Barber capabilities: business.facts.read, calendar.availability.read, booking.propose,
//   calendar.event.create, message.booking.confirm, sheets.rows.append

type FactKind = "hours" | "policy" | "service" | "contact" | "faq" | "menu_item"; // menu_item: upload drafts only, never a price source
type BusinessFact = {
  id: string; businessId: string; kind: FactKind;
  key: string;                // hours: "mon".."sun"; policy: "pickup_window"; service: the svc_ id
  value: unknown;             // hours: { open: "HH:MM", close: "HH:MM" } | { closed: true }; service: ServiceOffering
  sourceType: "square" | "google_calendar" | "owner_chat" | "owner_ui" | "upload" | "seed"; // every file uses "upload"
  sourceRef?: string;         // bld_ or Square object id
  fileId?: string;            // set when sourceType is "upload"; the file type lives on the files row
  status: "draft" | "verified" | "superseded"; // at most one verified per business, kind and key
  confidence: number;         // 0 to 1; 1 for seed and owner edits
  version: number;            // increments on each verified change
  supersedesId?: string; verifiedAt?: string; createdAt: string; updatedAt: string;
};
type FactConflict = {
  id: string;                 // cfl_
  businessId: string; kind: FactKind; key: string;
  required: boolean;          // true for catalog and price conflicts; an open required conflict blocks publish
  candidates: { factId?: string; sourceType: BusinessFact["sourceType"]; sourceRef?: string; value: unknown }[]; // the draft fact and the authority (Square, sourceRef the cat_ id, or the current verified fact)
  state: "open" | "resolved";
  resolvedFactId?: string; resolvedBy?: string; resolvedAt?: string; createdAt: string;
};
type FileRecord = {
  id: string; businessId: string; name: string; // the original file name
  mime: "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | "text/csv"
      | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sizeBytes: number;          // at most 10 MB
  sha256: string;
  extractionState: "PENDING" | "EXTRACTING" | "EXTRACTED" | "FAILED";
  draftFactIds?: string[]; conflictIds?: string[]; // both read from business_facts.file_id and fact_conflicts
  createdAt: string;
};

type CatalogItem = {          // cache of Square (P-10); display prices only, quotes come from Square
  // catalog_items has one row (cat_) per sellable variation; the API and the tools group rows by squareItemId
  squareItemId: string;       // Square ITEM id; Cart.catalogItemId uses this value
  businessId: string; name: string; description?: string; available: boolean; // true if any variation row is available
  variations: { id: string /* Square variation id */; name: string; priceMinor: number; currency: "USD" }[];
  modifierLists: { id: string; name: string; selectionType: "SINGLE" | "MULTIPLE";
                   modifiers: { id: string; name: string; priceMinor: number }[] }[];
  syncedAt: string;
};

type Cart = { lines: { catalogItemId: string; variationId: string; quantity: number /* 1..20 */; modifierIds: string[]; note?: string /* max 140 */ }[] };
type Quote = {
  quoteId: string;            // qte_
  cartHash: string;           // section 4
  subtotalMinor: number; taxMinor: number; totalMinor: number; currency: "USD";
  lines: { variationId: string; name: string; quantity: number; unitPriceMinor: number;
           modifiers: { modifierId: string; name: string; priceMinor: number }[]; lineTotalMinor: number }[];
  quotedAt: string;
  expiresAt: string;          // quotedAt plus 5 minutes
};
type Contact = { name: string; messageRecipient: string /* E.164 */; messageConsent: boolean /* must be true */; consentAt: string };
type Fulfillment = { type: "pickup"; pickupAt: string /* UTC, inside verified hours */ };

type OrderStatus = "AWAITING_OWNER_APPROVAL" | "APPROVED" | "CREATING_CHECKOUT" | "PAYMENT_LINK_READY" | "MESSAGE_SENT"
  | "PAYMENT_PENDING" | "PAID_VERIFIED" | "FULFILLMENT_READY" | "REJECTED" | "APPROVAL_EXPIRED"
  | "UNAVAILABLE" | "PAYMENT_FAILED" | "CANCELLED" | "RECOVERY_REQUIRED";
type Order = {
  id: string; businessId: string; callId: string; status: OrderStatus;
  cart: Cart; cartHash: string; quote: Quote;
  totalMinor: number; currency: "USD";   // copied from quote when the proposal is stored
  contact: Contact; fulfillment: Fulfillment;
  approvalId?: string; squareOrderId?: string; squarePaymentLinkId?: string; checkoutUrl?: string; squarePaymentId?: string;
  createdAt: string; updatedAt: string;
};

type BookingStatus = "AWAITING_OWNER_APPROVAL" | "RECHECKING_SLOT" | "BOOKED_VERIFIED"
  | "SLOT_CONFLICT" | "REJECTED" | "EXPIRED" | "RETRY_REQUIRED";
type BookingCustomer = { name: string; messageRecipient: string; messageConsent: boolean };
type Booking = {
  id: string; businessId: string; callId?: string; status: BookingStatus;
  serviceId: string; serviceName: string; startUtc: string; endUtc: string; timezone: string;
  calendarId: string;         // no-overlap rule is per calendar, over RECHECKING_SLOT and BOOKED_VERIFIED
  customer: BookingCustomer; approvalId?: string; googleEventId?: string;
  createdAt: string; updatedAt: string;
};
type ServiceOffering = { id: string /* svc_ */; businessId: string; name: string; durationMinutes: number; priceMinor: number; currency: "USD"; bufferMinutes?: number };
type AvailabilitySlot = { serviceId: string; startUtc: string; endUtc: string; timezone: string };

type BundleType = "order_bundle" | "booking_bundle" | "fact_edit" | "price_edit";
type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
type ApprovalRequest = {
  id: string; businessId: string;
  actorType: "deployed_agent" | "owner";   // owner for fact_edit and price_edit (P-09)
  bundleType: BundleType;
  actionBundle: string[];      // ordered action types
  subjectId: string;           // ord_, bkg_, fact_ or cat_
  payload: OrderApprovalPayload | BookingApprovalPayload | FactEditApprovalPayload | PriceEditApprovalPayload;
  payloadHash: string;
  state: ApprovalState; expiresAt: string; decidedBy?: string /* usr_ */; decidedAt?: string; createdAt: string;
};
type ApprovalDecision = { decision: "approve" | "reject"; payloadHash: string; reason?: string }; // Idempotency-Key header accepted

type ActionExecution = {
  id: string; businessId: string; approvalId: string;
  actionType: string;          // one step, for example "square.checkout.create"
  stepIndex: number;           // position in actionBundle
  capabilityId?: CapabilityId; // absent for local.* steps
  idempotencyKey: string;      // section 5; unique
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "SKIPPED" | "FAILED" | "NEEDS_REVIEW"; // SKIPPED: message step under qr_only
  attempts: number;            // at most 3
  externalRef?: string;
  errorCode?: ErrorCode;       // usually INTEGRATION_UNAVAILABLE, ITEM_UNAVAILABLE or SLOT_CONFLICT
  lastError?: string;          // sanitized provider message, for example "total_mismatch"
  createdAt: string; updatedAt: string;
};
type MessageDispatchStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | "UNKNOWN";
type MessageDispatch = {
  id: string; businessId: string; executionId: string; subjectId: string;
  channel: "surge" | "android_gateway" | "whatsapp_sandbox";
  recipient: string;           // E.164, stored in full, never in events
  template: "checkout_link" | "booking_confirmed";
  status: MessageDispatchStatus; providerMessageId?: string; idempotencyKey: string; errorCode?: ErrorCode;
  sentAt?: string; deliveredAt?: string; createdAt: string; updatedAt: string;
};

type CallStage = "CALL_STARTED" | "COLLECTING" | "VALIDATING" | "UNAVAILABLE" | "CUSTOMER_CONFIRMED"
  | "INQUIRY" | "SLOT_SEARCH" | "PROPOSAL";
type Call = {
  id: string; businessId: string; agentId: string; agentVersionId: string;
  channel: "phone" | "test_console";       // sim-call uses test_console and is labelled "simulated call"
  stage: CallStage;                         // conversation state; stays CUSTOMER_CONFIRMED once the proposal row exists
  providerCallId?: string;                  // Twilio CallSid; absent for test_console
  callerLast4?: string;
  status: "IN_PROGRESS" | "COMPLETED" | "DROPPED" | "FAILED";
  endReason?: "completed" | "dropped" | "failed";
  startedAt: string; endedAt?: string;
};
type BuilderSession = {
  id: string; businessId: string; status: "active" | "completed" | "abandoned";
  messages: BuilderMessage[];
  draftSpec: Partial<AgentSpec>; missingFields: string[]; agentId?: string; createdAt: string; updatedAt: string;
};
type BuilderMessage = {
  id: string /* bmsg_ */; sessionId: string; role: "owner" | "assistant";
  inputMode: "text" | "voice";
  text: string; specPatch?: Partial<AgentSpec>; evidenceRefs?: string[] /* fact_ or file_ */; createdAt: string;
};
type RealtimeClientSecret = {   // response of POST /api/realtime/client-secret, body { builderSessionId }
  clientSecret: string;         // short-lived key from OpenAI /v1/realtime/client_secrets; never stored
  expiresAt: string; model: "gpt-realtime-2.1"; builderSessionId: string;
};
type IntegrationProvider = "square" | "twilio" | "openai" | "google_calendar" | "google_sheets" | "message_channel";
type IntegrationHealthEntry = {
  state: "connected" | "degraded" | "disconnected";
  lastCheckedAt: string;
  environment?: "sandbox";      // always present for square
  channel?: "surge" | "android_gateway" | "whatsapp_sandbox" | "qr_only"; // message_channel only
  detail?: string;
};
type IntegrationHealth = Record<IntegrationProvider, IntegrationHealthEntry>; // GET /api/integrations/health
type LiveAgent = { phoneNumber: string; businessId: string; agentId: string; agentVersionId: string; updatedAt: string };
```

**Agent run modes (P-18).** Both endpoints take one text turn and return the same shape.

| Mode | Endpoint | Agent version | Toolset | Rows and events |
|---|---|---|---|---|
| test | `POST /api/agents/:id/test` | draft spec | mock | none; approvals are `apv_mock_`; never any write (AC-03) |
| sim-call | `POST /api/agents/:id/sim-call` | published active version | real `read` and `propose` | a `calls` row with `channel: "test_console"`, real approvals, normal events |

```ts
type AgentRunRequest = { testSessionId?: string /* test */; callId?: string /* sim-call */; message: string; end?: boolean };
type AgentRunResponse = {
  testSessionId?: string; callId?: string;   // one of them, matching the mode
  reply: string;
  toolTrace: { tool: ToolName; capabilityId: CapabilityId; effect: "read" | "propose"; input: unknown; output: unknown; mocked: boolean; durationMs: number }[];
  guardrail?: { refused: true; rule: GuardrailRule };
};
type GuardrailRule = "no_fact_changes" | "no_secret_reveal" | "no_approval_bypass" | "no_cross_business" | "unsupported_request";
```

## 4. Approval payloads

The server builds `payload` from stored rows, never from model output. Only these material fields go in, and all of them are hashed.

| bundleType | Payload fields (all required) |
|---|---|
| `order_bundle` | `businessId`, `subjectId`, `agentVersionId`, `cartHash`, `totalMinor`, `currency`, `pickupAt`, `messageRecipient`, `messageChannel`, `actionBundle`, `expiresAt` |
| `booking_bundle` | `businessId`, `subjectId`, `agentVersionId`, `serviceId`, `calendarId`, `startUtc`, `endUtc`, `timezone`, `messageRecipient`, `messageChannel`, `actionBundle`, `expiresAt` |
| `fact_edit` | `businessId`, `subjectId`, `kind`, `key`, `fromVersion`, `before`, `after`, `actionBundle`, `expiresAt` |
| `price_edit` (SHOULD) | `businessId`, `subjectId` (the `cat_` id), `squareItemId`, `variationId`, `fromPriceMinor`, `newPriceMinor`, `currency`, `squareVersion`, `actionBundle`, `expiresAt` |

`messageChannel` is the server's `MESSAGE_CHANNEL` at proposal time. `agentVersionId` always comes from the `calls` row (SPEC 2.9). `callId` is not a material field; the order row holds it. The full quote and contact are shown to the owner from the order row but are not separately hashed (SPEC 2.9). `before` is `null` when a fact is new.

**Hash recipe (SPEC 2.9).** Canonical JSON: keys sorted by code point at every depth, no whitespace, UTF-8, arrays kept in order, absent fields omitted. `payloadHash = "sha256:" + hex(sha256(canonicalJson(payload)))`, lowercase hex. `cartHash` uses the same recipe on the `Cart`, after sorting `modifierIds` inside each line and sorting lines by `variationId`, then joined `modifierIds`, then `note`.

**Rules.**
- An approval is one-use. The only move out of `PENDING` is one conditional update, so a second, different decision gets `APPROVAL_ALREADY_DECIDED`.
- `expiresAt` is `createdAt` plus 10 minutes. A decision after that gets `APPROVAL_EXPIRED`.
- The decision carries `payloadHash`. If it differs from the stored hash, the server returns `PAYLOAD_HASH_MISMATCH`.
- The executor recomputes the hash from current rows before every step. Any change to a material field (cart, total, recipient, channel, slot, calendar, fact value, price) stops the bundle and needs a new approval.

## 5. Idempotency keys

`idempotencyKey = hex(sha256(businessId + ":" + subjectId + ":" + actionType + ":" + approvalId))`, 64 lowercase hex characters (SPEC 2.9). `actionType` is the step, not the bundle. The key is computed once when the `ActionExecution` row is created and never regenerated on retry or timeout.

| Action type | What the key is used for |
|---|---|
| `square.checkout.create` | `idempotency_key` on `CreatePaymentLink`. The simulated fallback (`CreateOrder` plus `CreatePayment`) shortens it to the first 45 characters if spike B-02 confirms that cap |
| `message.checkout.send`, `message.booking.confirm` | Unique `message_dispatches.idempotency_key`, inserted before the provider call. A retry finds the row and sends nothing |
| `calendar.event.create` | The Google event `id` (hex fits Google's base32hex rule). A 409 means the event exists: read it and succeed. `bookingId` also goes in `extendedProperties.private` |
| `sheets.order.append`, `sheets.booking.append` | Computed when the sync job is created (same formula, with the bundle's `approvalId`) and written to the `recordId` column. Before a retry the job reads that column and skips if the key is present |
| `square.catalog.price.update` | `idempotency_key` on Square `UpsertCatalogObject`, sent with the full object and its current `version` |
| `local.order.record`, `local.booking.record`, `local.fact.update`, `local.catalog.sync` | Unique `action_executions.idempotency_key` only |

## 6. State machines

"Server only" means the transition happens only inside the server after it verified the provider's answer (signed webhook plus API read, or a direct API response). No client and no model output can cause it. Every order and booking transition, including stage changes on the call, writes an `order.status_changed` or `booking.status_changed` event.

**Order.** The states `CALL_STARTED` to `CUSTOMER_CONFIRMED` are conversation states. They live in `Call.stage`, not on an order. The branch `UNAVAILABLE` appears in both places: as a call stage while collecting, and as an order status when the checkout step's re-check finds an item gone. The `orders` row is created by `propose_order`, already in `AWAITING_OWNER_APPROVAL`. If the call ends before that, no order exists (AC-18).

| From | Event | To | Notes |
|---|---|---|---|
| `CALL_STARTED` | caller starts an order | `COLLECTING` | stage |
| `COLLECTING` | `quote_order` called | `VALIDATING` | stage |
| `VALIDATING` | quote reports `ITEM_UNAVAILABLE` | `UNAVAILABLE` | stage |
| `UNAVAILABLE` | caller picks another item | `COLLECTING` | stage |
| `VALIDATING` | caller changes the cart | `COLLECTING` | stage |
| `VALIDATING` | caller confirms read-back and consent | `CUSTOMER_CONFIRMED` | stage |
| `CUSTOMER_CONFIRMED` | `propose_order` succeeds | `AWAITING_OWNER_APPROVAL` | order row created |
| `AWAITING_OWNER_APPROVAL` | approval `APPROVED` | `APPROVED` | |
| `AWAITING_OWNER_APPROVAL` | approval `REJECTED` | `REJECTED` | terminal |
| `AWAITING_OWNER_APPROVAL` | approval `EXPIRED` | `APPROVAL_EXPIRED` | terminal |
| `APPROVED` | executor starts `square.checkout.create` | `CREATING_CHECKOUT` | |
| `CREATING_CHECKOUT` | Square returns link and order id | `PAYMENT_LINK_READY` | server only |
| `CREATING_CHECKOUT` | the step's availability re-check finds an item gone (`ITEM_UNAVAILABLE`); no Square call is made | `UNAVAILABLE` | terminal |
| `CREATING_CHECKOUT` | step `FAILED` or `NEEDS_REVIEW` for any other reason | `RECOVERY_REQUIRED` | |
| `RECOVERY_REQUIRED` | reconciliation finds the link | `PAYMENT_LINK_READY` | server only |
| `PAYMENT_LINK_READY` | dispatch reaches `SENT` | `MESSAGE_SENT` | server only |
| `MESSAGE_SENT` | `local.order.record` runs | `PAYMENT_PENDING` | |
| `PAYMENT_LINK_READY` | `local.order.record` runs after `qr_only`, a failed send or an unknown result | `PAYMENT_PENDING` | QR shown |
| `PAYMENT_PENDING` | verified `COMPLETED` payment with matching order id, amount, currency, location | `PAID_VERIFIED` | server only; creates the Sheets sync job |
| `PAYMENT_PENDING` | verified failed or canceled payment | `PAYMENT_FAILED` | server only |
| `PAYMENT_FAILED` | later verified `COMPLETED` payment | `PAID_VERIFIED` | server only; creates the Sheets sync job |
| `PAYMENT_PENDING` | payment amount or order id mismatch | `RECOVERY_REQUIRED` | server only |
| `PAYMENT_PENDING`, `PAYMENT_FAILED`, `RECOVERY_REQUIRED` | owner cancels | `CANCELLED` | terminal |
| `PAID_VERIFIED` | the server queues the paid order for the kitchen, right after verification | `FULFILLMENT_READY` | server only, terminal |

The payment poller checks every 30 seconds for 15 minutes after the link is ready. An order that is never paid gets no Sheets row and no pending job.

**Booking.** `INQUIRY` to `CUSTOMER_CONFIRMED` live in `Call.stage`. The `bookings` row is created by `propose_booking` in `AWAITING_OWNER_APPROVAL`. There is no `APPROVED` state. The expired branch is `EXPIRED` here and `APPROVAL_EXPIRED` on orders, as SPEC 2.4 rules.

| From | Event | To | Notes |
|---|---|---|---|
| `INQUIRY` | `read_calendar_availability` called | `SLOT_SEARCH` | stage |
| `SLOT_SEARCH` | agent offers a slot | `PROPOSAL` | stage |
| `PROPOSAL` | caller wants another time | `SLOT_SEARCH` | stage |
| `PROPOSAL` | caller confirms slot and contact | `CUSTOMER_CONFIRMED` | stage |
| `CUSTOMER_CONFIRMED` | `propose_booking` succeeds | `AWAITING_OWNER_APPROVAL` | booking row created |
| `AWAITING_OWNER_APPROVAL` | approval `APPROVED` | `RECHECKING_SLOT` | holds the local slot lock |
| `AWAITING_OWNER_APPROVAL` | approval `APPROVED`, but `bookings_no_overlap` refuses `RECHECKING_SLOT` | `SLOT_CONFLICT` | terminal; the calendar step is marked `FAILED` and no Google call is made |
| `AWAITING_OWNER_APPROVAL` | approval `REJECTED` | `REJECTED` | terminal |
| `AWAITING_OWNER_APPROVAL` | approval `EXPIRED` | `EXPIRED` | terminal |
| `RECHECKING_SLOT` | event insert returned an id after a clear free/busy read, and `local.booking.record` runs | `BOOKED_VERIFIED` | server only, terminal; creates the Sheets sync job |
| `RECHECKING_SLOT` | fresh free/busy shows the slot busy | `SLOT_CONFLICT` | terminal; up to 3 alternatives offered; a new slot is a new booking and approval |
| `RECHECKING_SLOT` | calendar step `FAILED` (Google error after 3 attempts) or `NEEDS_REVIEW` (unknown insert result) | `RETRY_REQUIRED` | |
| `RETRY_REQUIRED` | owner retries, approval still valid, same key | `RECHECKING_SLOT` | |
| `RETRY_REQUIRED` | reconciliation finds the event by id | `BOOKED_VERIFIED` | server only, terminal; creates the Sheets sync job |

**Approval.** `PENDING` goes to `APPROVED` (owner approves with matching hash before `expiresAt`), `REJECTED` (owner rejects) or `EXPIRED` (`expiresAt` passes, by job or late decision). All three are terminal.

**Execution.** Steps run in bundle order. A step starts when the step before it is `SUCCEEDED`, except that a message step that ends `SKIPPED`, `FAILED` or `NEEDS_REVIEW` still lets `local.*.record` run. Sheets steps have no execution row; their sync job is created on entering `PAID_VERIFIED` or `BOOKED_VERIFIED`. There is no retry state.

| From | Event | To |
|---|---|---|
| `QUEUED` | message step claimed while `MESSAGE_CHANNEL` is `qr_only` | `SKIPPED` (terminal; no dispatch row) |
| `QUEUED` | worker claims the row (`FOR UPDATE SKIP LOCKED`) | `RUNNING` |
| `RUNNING` | provider confirms the result | `SUCCEEDED` (terminal, server only) |
| `RUNNING` | retryable error, `attempts` below 3 | `QUEUED` (`attempts` plus one, with backoff) |
| `RUNNING` | non-retryable error, or third attempt failed | `FAILED` (terminal) |
| `RUNNING` | outcome unknown (timeout after send) | `NEEDS_REVIEW` |
| `NEEDS_REVIEW` | reconciliation finds the external object | `SUCCEEDED` (terminal, server only) |
| `NEEDS_REVIEW` | reconciliation proves nothing happened | `QUEUED` (same key) |
| `NEEDS_REVIEW` | owner abandons the step | `FAILED` (terminal) |

**Sync job.** Created in `PENDING` on entering `PAID_VERIFIED` or `BOOKED_VERIFIED`, carrying the Sheets step's idempotency key. `PENDING` to `RUNNING` when the runner picks it up. `RUNNING` to `DONE` (terminal) when the row is appended or its `recordId` is already present. `RUNNING` to `RETRYING` on an error with attempts below 5. `RETRYING` to `RUNNING` when `nextRetryAt` is reached. `RUNNING` to `FAILED` (terminal) after the fifth attempt.

**Message dispatch.** No dispatch row is created for `qr_only`; the step's execution is `SKIPPED`. No automatic resend from `UNKNOWN`.

| From | Event | To |
|---|---|---|
| `QUEUED` | provider accepts and returns a message id | `SENT` (server only) |
| `QUEUED` | provider rejects | `FAILED` (terminal) |
| `QUEUED` | timeout, result unknown | `UNKNOWN` |
| `UNKNOWN` | provider lookup shows accepted | `SENT` (server only) |
| `UNKNOWN` | lookup shows nothing sent, or owner marks failed | `FAILED` (terminal) |
| `SENT` | verified delivery callback: delivered | `DELIVERED` (terminal, server only) |
| `SENT` | verified delivery callback: failed | `FAILED` (terminal) |

`SENT` is the last state for channels without delivery callbacks (only `whatsapp_sandbox` sends them).

**Fact.** `draft` to `verified` when an approved `fact_edit` runs `local.fact.update`; the old `verified` row becomes `superseded` in the same transaction. `superseded` is terminal. **Fact conflict.** `open` to `resolved` when the owner picks a candidate (or an approved edit carries `resolvesConflictId`); `resolved` is terminal.

**Agent.** No terminal state. `draft` to `live` when the owner publishes a validated spec (new `agv_`). `live` to `live` on a published update (atomic swap; in-flight calls stay on their version). `live` to `paused` when the owner pauses. `paused` to `live` when the owner resumes or publishes.

**Call.** `IN_PROGRESS` goes to `COMPLETED` (`endReason: "completed"`), `DROPPED` (`"dropped"`, the stream closed unexpectedly) or `FAILED` (`"failed"`, setup, model or relay error). All three are terminal.

## 7. Activity events

```ts
type ActivityEvent = { id: string; businessId: string; type: ActivityEventType; correlationId: string;
  actorType: "owner" | "deployed_agent" | "system" | "provider"; occurredAt: string; payload: object };
```

Payloads are redacted. `guardrail.refused` names the rule that fired in `rule`. Phone numbers appear only as `recipientLast4`, `callerLast4` or `phoneNumberLast4`. Card data never appears in any field. Customer names appear as first name only. `correlationId` is the `call_` id for call journeys, the `bld_` id for builder journeys, the `file_` id for extraction and the `apv_` id for owner edits. Screens: OV Overview, LO Live operations (the sidebar item "Activity", SPEC 2.9), AP Approvals, MA My Agents, BK Business Knowledge, IN Integrations.

| Type | Payload | Screens |
|---|---|---|
| `call.started` | `{ callId, agentId, agentVersionId, channel, callerLast4? }` | OV, LO |
| `call.ended` | `{ callId, status, reason: "completed" \| "dropped" \| "failed", durationSec }` | OV, LO |
| `proposal.created` | `{ subjectId, subjectType: "order" \| "booking", callId, totalMinor?, currency?, serviceName?, startUtc? }` | LO |
| `approval.requested` | `{ approvalId, bundleType, subjectId, actionBundle, expiresAt, totalMinor?, recipientLast4? }` | OV, LO, AP |
| `approval.decided` | `{ approvalId, subjectId, decision: "APPROVED" \| "REJECTED", decidedBy }` | LO, AP |
| `approval.expired` | `{ approvalId, subjectId }` | LO, AP |
| `execution.started` | `{ executionId, approvalId, actionType, stepIndex, attempt }` | LO, AP |
| `execution.succeeded` | `{ executionId, actionType, externalRef? }` | LO, AP |
| `execution.failed` | `{ executionId, actionType, errorCode, retryable, nextStatus }` | LO, AP |
| `checkout.created` | `{ orderId, squareOrderId, squarePaymentLinkId, totalMinor, currency, sandbox: true }` | LO |
| `message.sent` | `{ dispatchId, subjectId, channel, template, recipientLast4 }` | LO |
| `message.failed` | `{ dispatchId, subjectId, channel, status: "FAILED" \| "UNKNOWN", errorCode? }` | LO |
| `payment.verified` | `{ orderId, squarePaymentId, amountMinor, currency, sandbox: true }` | OV, LO |
| `payment.failed` | `{ orderId, squarePaymentId?, reason, sandbox: true }` | OV, LO |
| `booking.verified` | `{ bookingId, googleEventId, serviceName, startUtc, timezone }` | OV, LO |
| `booking.slot_conflict` | `{ bookingId, approvalId, startUtc, alternatives: { startUtc, endUtc }[] }` (at most 3) | LO, AP |
| `order.status_changed` | `{ orderId?, callId, from?, to }` (`orderId` absent for stage changes before the proposal) | OV, LO |
| `booking.status_changed` | `{ bookingId?, callId?, from?, to }` (same rule) | OV, LO |
| `sync.queued` | `{ target: "google_sheets" \| "catalog", syncJobId?, recordType?, recordId?, jobId? }`. Sheets events carry `syncJobId`, `recordType` and `recordId`; catalog sync events carry `jobId` | LO |
| `sync.succeeded` | `{ target, syncJobId?, recordType?, recordId?, jobId? }` (same rule) | LO |
| `sync.failed` | `{ target, syncJobId?, recordType?, recordId?, jobId?, attempts, final: boolean }` (same rule) | LO, IN |
| `fact.changed` | `{ factId, kind, key, fromVersion, toVersion, sourceType }` | BK, MA |
| `extraction.completed` | `{ fileId, mime, extractionState: "EXTRACTED" \| "FAILED", draftFactCount, conflictCount }` | BK |
| `agent.published` | `{ agentId, agentVersionId, version, phoneNumberLast4?, rolledBackFrom? }` (`rolledBackFrom` is the previous `agv_` id, on rollback only) | OV, MA |
| `agent.paused` | `{ agentId }` | OV, MA |
| `live_agent.changed` | `{ phoneNumberLast4, agentId, agentVersionId, previousAgentId? }` | OV, MA |
| `guardrail.refused` | `{ callId, rule: GuardrailRule, toolName? }` | LO, MA |
| `webhook.rejected` | `{ provider: "square" \| "twilio", reason: "signature_invalid" \| "malformed" }`. `businessId` is the business that owns the integration the webhook URL belongs to, read from `integrations`. Nothing from the request body is trusted, stored or copied | IN, LO |

## 8. Agent tools

The tools the voice model (`session.tools` in OpenAI Realtime) and the text runner see. The server injects `businessId`, `callId` and `agentVersionId`; no tool accepts them. Prices are minor units; the instructions tell the model to say them as dollars.

```ts
type ToolName = "read_catalog" | "read_business_facts" | "quote_order" | "propose_order"
  | "get_order_status" | "read_calendar_availability" | "propose_booking";
type ToolFailureReason = Extract<ErrorCode, "QUOTE_EXPIRED" | "ITEM_UNAVAILABLE" | "SLOT_CONFLICT"
  | "VALIDATION_FAILED" | "NOT_FOUND" | "CAPABILITY_NOT_ALLOWED" | "INTEGRATION_UNAVAILABLE">;
type ToolResult<T> = ({ ok: true } & T) | { ok: false; reason: ToolFailureReason; message?: string;
  quote?: Quote /* QUOTE_EXPIRED only */; alternatives?: AvailabilitySlot[] /* SLOT_CONFLICT only, at most 3 */ };
type ToolContext = { businessId: string; agentVersionId: string; callId?: string; testSessionId?: string; correlationId: string };
interface ToolHandler {
  readonly toolset: "real" | "mock";
  call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<ToolOutput[N]>>;
}
```

The real toolset (`apps/server/src/tools/real`) calls the capability handlers of section 2 and writes rows and events. The mock toolset (`apps/server/src/tools/mock`) reads the section 9 fixtures, returns `apv_mock_` approvals, never touches the database or a provider and writes no events. `test` uses mock; phone calls and `sim-call` use real. Both pass the same contract tests.

```json
[
  { "type": "function", "name": "read_catalog",
    "description": "Search this shop's menu. Use exact item, size and topping IDs from the result.",
    "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "additionalProperties": false } },
  { "type": "function", "name": "read_business_facts",
    "description": "Read verified opening hours, policies and services. Answer only from this result.",
    "parameters": { "type": "object", "properties": { "kinds": { "type": "array", "items": { "enum": ["hours","policy","service","contact","faq"] } } }, "additionalProperties": false } },
  { "type": "function", "name": "quote_order",
    "description": "Get the exact total and tax for a cart. Read the total back to the caller from this result only.",
    "parameters": { "type": "object", "required": ["cart"], "additionalProperties": false, "properties": { "cart": { "$ref": "#/$defs/Cart" } } } },
  { "type": "function", "name": "propose_order",
    "description": "Send the confirmed order to the owner for approval. Call only after the caller confirmed the read-back of this quote and agreed to receive a payment link.",
    "parameters": { "type": "object", "required": ["cart","contact","fulfillment","quoteId"], "additionalProperties": false,
      "properties": { "cart": { "$ref": "#/$defs/Cart" }, "contact": { "$ref": "#/$defs/Contact" },
                      "fulfillment": { "$ref": "#/$defs/Fulfillment" }, "quoteId": { "type": "string" } } } },
  { "type": "function", "name": "get_order_status",
    "description": "Read the verified status of an order placed on this call.",
    "parameters": { "type": "object", "required": ["orderId"], "additionalProperties": false, "properties": { "orderId": { "type": "string" } } } },
  { "type": "function", "name": "read_calendar_availability",
    "description": "List free appointment slots for one service on one date.",
    "parameters": { "type": "object", "required": ["serviceId","date"], "additionalProperties": false,
      "properties": { "serviceId": { "type": "string" }, "date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }, "maxSlots": { "type": "integer", "minimum": 1, "maximum": 5 } } } },
  { "type": "function", "name": "propose_booking",
    "description": "Send the confirmed appointment to the owner for approval. Call only after the caller confirmed service, time and contact.",
    "parameters": { "type": "object", "required": ["serviceId","startUtc","customer"], "additionalProperties": false,
      "properties": { "serviceId": { "type": "string" }, "startUtc": { "type": "string" }, "customer": { "$ref": "#/$defs/BookingCustomer" } } } }
]
```

`$defs` are the JSON Schema forms of `Cart`, `Contact`, `Fulfillment` and `BookingCustomer`, generated from the Zod schemas. If the Realtime API rejects `$ref`, S-02 inlines them.

| Tool | Result when `ok: true` |
|---|---|
| `read_catalog` | `{ items: { catalogItemId, name, available, variations: { id, name, priceMinor }[], modifierLists: { id, name, selectionType, modifiers: { id, name, priceMinor }[] }[] }[] }` |
| `read_business_facts` | `{ facts: { kind, key, value }[], timezone }` |
| `quote_order` | `{ quote: Quote }`; `reason: "ITEM_UNAVAILABLE"` names the line in `message` |
| `propose_order` | `{ proposalId, quote, missingFields, approvalId }`. `proposalId` is the `ord_` id. If `missingFields` is not empty, `proposalId` and `approvalId` are absent and nothing is stored. A `quoteId` past `expiresAt` or with a different `cartHash` gets `reason: "QUOTE_EXPIRED"` with a fresh `quote` to read back. A pickup time outside verified hours gets `VALIDATION_FAILED` |
| `get_order_status` | `{ orderId, status, paid, checkoutLinkSent }` |
| `read_calendar_availability` | `{ slots: AvailabilitySlot[], timezone }` |
| `propose_booking` | `{ proposalId, approvalId, missingFields, slot }`. `proposalId` is the `bkg_` id; same absent rule; a taken slot gets `reason: "SLOT_CONFLICT"` with up to 3 `alternatives` |

## 9. Fixtures

Task S-03 creates these in `packages/contracts/fixtures/`. Every file validates against the S-02 schemas in a vitest test. Square IDs are placeholders (`SQ_...`); the seed script maps them to the sandbox IDs.

| File | Contents |
|---|---|
| `businesses.json` | `biz_pizza_01` "Demo Pizza Co." and `biz_barber_01` "Demo Barbershop", category, `America/Los_Angeles`, contact |
| `facts.pizza.json` | Verified `hours` for `mon` to `sun`, `policy` `pickup_window` (20 minutes), `special_requests` allowed |
| `catalog.pizza.json` | Two `CatalogItem`s: Margherita (Small 1200, Medium 1600, Large 2000) and Pepperoni (Small 1400, Medium 1800, Large 2200), sharing one MULTIPLE modifier list "Toppings" (Mushrooms 150, Olives 150, Extra cheese 200) |
| `services.barber.json` | Three `ServiceOffering`s: Haircut 30 min 3000, Beard trim 15 min 1500, Haircut and beard 45 min 4000, buffer 5 min |
| `facts.barber.json` | Verified `hours` and the services as `kind: "service"` facts |
| `conflict.pizza.json` | One open required `FactConflict`: an uploaded menu says Large Margherita 2100, Square says 2000 (AC-02) |
| `agents.json` | Two `AgentSpec`s: `restaurant_order_taker` for pizza, `appointment_booker` for barber, both `draft` |
| `quote.pizza.json` | The quote used in the pizza timeline |
| `approvals.json` | One approval per `bundleType`, with `payloadHash` computed by the section 4 recipe in the test |
| `timeline.pizza-order.jsonl` | One `ActivityEvent` per line, `call.started` to `payment.verified`, including every `order.status_changed` |
| `timeline.booking.jsonl` | One `ActivityEvent` per line, `proposal.created` to `booking.verified` |

The mock feed in `apps/web/mocks` replays the two timelines. Short worked examples follow; the fixture files carry every line. Tax is illustrative; Square computes the real value.

```jsonl
{"id":"evt_p01","businessId":"biz_pizza_01","type":"call.started","correlationId":"call_p01","actorType":"provider","occurredAt":"2026-11-14T19:00:00Z","payload":{"callId":"call_p01","agentId":"agt_pizza_01","agentVersionId":"agv_pizza_01_v1","channel":"phone","callerLast4":"0123"}}
{"id":"evt_p02","businessId":"biz_pizza_01","type":"proposal.created","correlationId":"call_p01","actorType":"deployed_agent","occurredAt":"2026-11-14T19:03:10Z","payload":{"subjectId":"ord_p01","subjectType":"order","callId":"call_p01","totalMinor":4731,"currency":"USD"}}
{"id":"evt_p03","businessId":"biz_pizza_01","type":"approval.requested","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:03:10Z","payload":{"approvalId":"apv_p01","bundleType":"order_bundle","subjectId":"ord_p01","actionBundle":["square.checkout.create","message.checkout.send","local.order.record","sheets.order.append"],"expiresAt":"2026-11-14T19:13:10Z","totalMinor":4731,"recipientLast4":"0123"}}
{"id":"evt_p04","businessId":"biz_pizza_01","type":"call.ended","correlationId":"call_p01","actorType":"provider","occurredAt":"2026-11-14T19:03:40Z","payload":{"callId":"call_p01","status":"COMPLETED","reason":"completed","durationSec":220}}
{"id":"evt_p05","businessId":"biz_pizza_01","type":"approval.decided","correlationId":"call_p01","actorType":"owner","occurredAt":"2026-11-14T19:04:05Z","payload":{"approvalId":"apv_p01","subjectId":"ord_p01","decision":"APPROVED","decidedBy":"usr_owner_01"}}
{"id":"evt_p06","businessId":"biz_pizza_01","type":"checkout.created","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:04:07Z","payload":{"orderId":"ord_p01","squareOrderId":"SQ_ORDER_1","squarePaymentLinkId":"SQ_LINK_1","totalMinor":4731,"currency":"USD","sandbox":true}}
{"id":"evt_p07","businessId":"biz_pizza_01","type":"message.sent","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:04:09Z","payload":{"dispatchId":"msg_p01","subjectId":"ord_p01","channel":"surge","template":"checkout_link","recipientLast4":"0123"}}
{"id":"evt_p08","businessId":"biz_pizza_01","type":"payment.verified","correlationId":"call_p01","actorType":"provider","occurredAt":"2026-11-14T19:06:30Z","payload":{"orderId":"ord_p01","squarePaymentId":"SQ_PAY_1","amountMinor":4731,"currency":"USD","sandbox":true}}
{"id":"evt_p09","businessId":"biz_pizza_01","type":"order.status_changed","correlationId":"call_p01","actorType":"system","occurredAt":"2026-11-14T19:06:30Z","payload":{"orderId":"ord_p01","callId":"call_p01","from":"PAYMENT_PENDING","to":"PAID_VERIFIED"}}
```

```jsonl
{"id":"evt_b01","businessId":"biz_barber_01","type":"proposal.created","correlationId":"call_b01","actorType":"deployed_agent","occurredAt":"2026-11-14T20:00:00Z","payload":{"subjectId":"bkg_b01","subjectType":"booking","callId":"call_b01","serviceName":"Haircut","startUtc":"2026-11-15T18:00:00Z"}}
{"id":"evt_b02","businessId":"biz_barber_01","type":"approval.requested","correlationId":"call_b01","actorType":"system","occurredAt":"2026-11-14T20:00:00Z","payload":{"approvalId":"apv_b01","bundleType":"booking_bundle","subjectId":"bkg_b01","actionBundle":["calendar.event.create","message.booking.confirm","local.booking.record","sheets.booking.append"],"expiresAt":"2026-11-14T20:10:00Z","recipientLast4":"0456"}}
{"id":"evt_b03","businessId":"biz_barber_01","type":"approval.decided","correlationId":"call_b01","actorType":"owner","occurredAt":"2026-11-14T20:01:00Z","payload":{"approvalId":"apv_b01","subjectId":"bkg_b01","decision":"APPROVED","decidedBy":"usr_owner_01"}}
{"id":"evt_b04","businessId":"biz_barber_01","type":"execution.started","correlationId":"call_b01","actorType":"system","occurredAt":"2026-11-14T20:01:01Z","payload":{"executionId":"exe_b01","approvalId":"apv_b01","actionType":"calendar.event.create","stepIndex":0,"attempt":1}}
{"id":"evt_b05","businessId":"biz_barber_01","type":"booking.verified","correlationId":"call_b01","actorType":"provider","occurredAt":"2026-11-14T20:01:03Z","payload":{"bookingId":"bkg_b01","googleEventId":"3f9a0c...","serviceName":"Haircut","startUtc":"2026-11-15T18:00:00Z","timezone":"America/Los_Angeles"}}
```

The pizza cart behind these events: one Large Margherita with Mushrooms (2150) and one Large Pepperoni (2200), subtotal 4350, tax 381, total 4731.

## 10. Change rule

Until hour 2 either lead may change this file. After hour 2 the contracts are additive only: new optional fields, new enum values, new event types, new capabilities. Nothing is renamed or removed and no optional field becomes required. Every change is a pull request labelled `contract` that updates this file, the Zod schemas and the fixtures together, and passes typecheck in CI. Saina reviews every `contract` pull request.

## 11. Names added by this doc

**Invented names** (SPEC v1.1 does not define them):
- `approvalMode` values, every `requiredScopes` string, `handlerId` and `timeoutMs`.
- Capability and tool fields: `includeUnavailable`, `paid`, `checkoutLinkSent`, `maxSlots` (default 5), `dispatchId`, `syncJobId`, `recordType`, `newPriceMinor`, `squareVersion`, `squareItemId`, the capability output status `SKIPPED`.
- `AgentSpec.template` value `custom`, knowledge scopes `services` and `faq`, `greeting`.
- `FactConflict` fields (`required`, `candidates`, `resolvedFactId`). `FileRecord` mime list and `conflictIds`. `BuilderMessage.inputMode`, `specPatch`, `evidenceRefs`. `BuilderSession.messages`. `RealtimeClientSecret`.
- `ActionExecution.lastError`. `MessageDispatch.sentAt` and `deliveredAt`. `IntegrationHealthEntry` fields beyond `state` and `lastCheckedAt`, and its `state` values. `CallStage` as a type, including `UNAVAILABLE`.
- `ToolContext`, `ToolFailureReason` as a subset of `ErrorCode`, the `quote` field on `QUOTE_EXPIRED` and the `alternatives` field on `SLOT_CONFLICT`. `AgentRunRequest` and `AgentRunResponse` (shaped after API.md section 3). `GuardrailRule` values beyond API.md's `no_fact_changes`.
- Approval payload fields `fromVersion`, `before`, `after`, and all `price_edit` fields. `ApprovalDecision.reason`.
- Event payload fields in section 7, including `subjectType`, `sandbox`, `nextStatus`, `final`, `alternatives`, `previousAgentId`, `rolledBackFrom`, and the `sync.*` target `catalog` with `jobId`.
- Fixture prices, the Toppings list and `conflict.pizza.json`.

**Still open:**
1. The cap on Square idempotency key length for `CreatePayment` (45 characters assumed) still needs spike B-02.
2. The transitions an owner starts after approval (cancel an order, abandon a `NEEDS_REVIEW` step, retry a `RETRY_REQUIRED` booking, mark an `UNKNOWN` dispatch failed) have no endpoint in API.md. Each needs an endpoint or a ruling that it stays out of this build.
