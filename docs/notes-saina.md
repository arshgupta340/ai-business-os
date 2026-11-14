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
- A new-key `fact_edit` uses a matching draft fact as its subject, with `before: null` and `fromVersion: 0`. Migration 0005 adds this support; until then the server returns `INVALID_STATE`.
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

## B-16 builder service (2026-11-13)

The builder was built before the contracts package (S-02), the mock toolset (S-03), the database (B-06) and auth (B-08) existed. The contracts and mock toolset stand-ins are gone (see "Contracts swap" below). These stand-ins still stand:

- `session/stores.ts`: in-memory stores behind interfaces shaped after docs/DATA-MODEL.md. `session/knowledge.ts` reads the shared fixtures in `@abos/contracts/fixtures`. Both are replaced by database versions passed through the plugin options.
- `auth.ts`: builder routes answer `UNAUTHENTICATED` until a real `BuilderAuth` is passed to the plugin. For local development only, `BUILDER_DEV_AUTH=1` turns on an unverified stand-in that treats any bearer token as the seeded owner. It is refused when `NODE_ENV` is `production`, and it answers only requests whose socket address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). `BUILDER_DEV_AUTH` is not in SPEC 3.3 yet.

### Not verified

- The real OpenAI path has never run. There is no `OPENAI_API_KEY` yet. `OpenAiBuilderModel` and `OpenAiAgentModel` are tested with fake clients only (request shape, strict JSON schema, tool round trip, refusal handling).
- The recorded interviews (pizza, barbershop, one unsupported request) were written by hand. They were not captured from OpenAI.
- No default model ID is set. SPEC 3.2 says to confirm it at build time. Setting `OPENAI_API_KEY` without `OPENAI_BUILDER_MODEL` stops the server on purpose.
- The text runner uses `OPENAI_BUILDER_MODEL`. SPEC 3.3 names no separate model for text runs.

### Choices made where the docs were silent

- Missing-field names follow `kind.key` (the API.md example is `policy.pickup_window`). The others are mine: `policy.special_requests`, `policy.message_consent`, `policy.min_notice` (renamed from `policy.minimum_notice` to match the fixture key `min_notice`, which the shared mock toolset reads), `hours.<day>`, `catalog.items`, `services`, `name`, `goal`.
- Stop-condition codes: `missing_timezone` comes from API.md. `open_conflict` and `missing_message_consent_policy` are mine.
- Owner chat answers are saved as draft facts (`sourceType: "owner_chat"`, `value: { text }`, confidence 0.8). The builder opens a `fact_edit` for each answer, using the draft subject for a new key, and the owner confirms it in chat.
- `proposedChange` is never set yet. The builder cannot create an approval until the approval engine (B-07) exposes a function for it.
- Preview scenarios `happy_path` and `price_injection` come from API.md. `approval_bypass` and the custom template's `happy_path` are mine.
- Test runs pass `agentVersionId: "agv_draft_<agent suffix>"` to the tools. The package's `ToolContextSchema` requires an `agv_` ID, so the old `draft:<agt_id>` marker was dropped. No published version has this ID: those are `agv_` plus random hex.
- `POST /api/builder/sessions` and `POST /api/agents` return 201.
- The mock toolset is the shared one (`apps/server/src/tools/mock`), on the runner's clock. Its values come from the shared fixtures: tax 8.75%, busy calendar blocks only on 2026-11-17, an unknown quote ID answers `NOT_FOUND`, an unknown item or topping answers `ITEM_UNAVAILABLE`.

## B-24 owner voice session (2026-11-13)

`POST /api/realtime/client-secret` mints a short-lived OpenAI Realtime client secret for a signed-in owner. The session it mints has no tools, `tool_choice: "none"`, and does not answer on its own (`create_response: false`), following API.md 3.5 and FLOWS A3. The browser sends each finished transcript to the builder messages endpoint with `inputMode: "voice"`, so speech goes through the same registry check and spec validation as typed chat.

### Choices made where the docs were silent

- With no `OPENAI_API_KEY`, the endpoint answers `INTEGRATION_UNAVAILABLE`. It does not return a fake secret, because `RealtimeClientSecret` has no field to mark one as fake. The browser falls back to typed chat.
- `OPENAI_REALTIME_MODEL` must be exactly `gpt-realtime-2.1` (the contract literal). If a key is set and the model is missing or different, voice answers `INTEGRATION_UNAVAILABLE` and the server keeps running.
- The secret expires after 60 seconds. The transcription model is `whisper-1`. SPEC names neither.
- Rate limit: 5 mints per 60 seconds per owner, across both businesses. The error is `RATE_LIMITED` with a `Retry-After` header.
- A minted session that OpenAI reports back with any tools is discarded.

### Not verified

- The real OpenAI path has never run. The request body and the response shape come from the official reference, read on 2026-11-13, and are tested against a fake only.
- Whether the secret must stay valid after the WebRTC connection is set up. The 60 second expiry assumes it does not.
- Whether a browser holding the secret can send `session.update` and add tools. If it can, the server-bound session limits a well-behaved client only. Check this once a key exists.
- The data channel event names the browser will use (U-12) are from the docs and are untested.

## B-29 FAQ-only custom agent (2026-11-13)

A custom agent is any valid subset of registered capabilities (P-13). `CAPABILITY_RULES` in `apps/server/src/builder/registry.ts` is the one table that says which subsets are valid. A capability that breaks a rule is removed from the draft and the reply explains why. The builder never adds a capability to make a set valid.

### The rules and where each comes from

1. `order.quote` needs `catalog.read` (SPEC 2.6: the quote takes catalog item and variation IDs).
2. `order.propose` needs `catalog.read` and `order.quote` (FLOWS B14: a proposal takes a quote ID).
3. `order.propose` opens `order_bundle`, so `order.checkout.prepare`, `message.checkout.send` and `sheets.rows.append` must be in the set (SPEC 2.3).
4. `order.status.read` needs `order.propose`. This rule is mine. It rests on the tool reading the status of an order placed by this agent. Arsh should confirm it or tell me to drop it.
5. `calendar.availability.read` needs `business.facts.read`. Inferred: the tool needs a service ID, and services are business facts (SPEC 2.2).
6. `booking.propose` needs `business.facts.read` and `calendar.availability.read` (FLOWS C5).
7. `booking.propose` opens `booking_bundle`, so `calendar.event.create`, `message.booking.confirm` and `sheets.rows.append` must be in the set (SPEC 2.3).
8. A write or message capability is valid only when the propose capability that opens its bundle is in the set (SPEC 2.2).
9. `catalog.price.update` is never valid in an agent spec. `price_edit` is started by the owner (SPEC 2.3).

### Other choices

- `POST /api/agents`, preview and test refuse a set that breaks a rule with `CAPABILITY_NOT_ALLOWED`.
- Preview scenario names for a custom agent: `happy_path`, `unsupported_order`, `order_injection`. The last two are mine.
- Knowledge scopes for a custom agent follow from its capabilities when the model names none.
- Escalation: the agent explains what it cannot do and suggests the caller speak with the shop. It does not offer a callback, because no capability records one.
- "Ignore your rules and take my order" fires the existing `unsupported_request` guardrail rule. No new rule value was added.
- A refusal now names only what that agent's tools can do. Before this, a FAQ agent would have offered to help with an order.

### Not verified

- The real OpenAI paths (no key). Publish (B-17) and the simulated call (B-31) do not exist yet, so "can be published and answers on a call" is shown only as far as a valid spec that runs in preview and test on the mock toolset.

## B-21 document extraction and conflict detection (2026-11-13)

Routes: `POST /api/businesses/:id/files`, `GET /api/files/:id`, `POST /api/conflicts/:id/resolve`. Everything is in `apps/server/src/builder/extraction`. Storage, facts, conflicts, the catalog reader and the event sink are in-memory stand-ins behind interfaces until the database and Supabase Storage exist.

An open required conflict from an upload reaches the builder interview as the `open_conflict` stop condition, and goes away when the conflict is resolved.

### Choices made where the docs were silent or disagreed

- A conflict is `required: true` for a menu price or a service price that differs. It is `false` for hours, policies and other differences. The API.md 3.1 example shows a `pickup_window` conflict with `required: true`, which disagrees. Arsh should rule on it.
- `sha256` on a file is stored as `sha256:<hex>` (DATA-MODEL check). The API.md example shows bare hex.
- `GET /api/files/:id` returns the FileRecord itself, as the package's `getFile` response says. It returned `{ file }` before. The upload response stays `{ file }`.
- Uploading the same bytes twice for one business returns the existing record and does not extract again. A file that failed before is run again.
- The declared MIME type must be one of the six listed. `application/vnd.ms-excel` for a CSV, which some Windows browsers send, is refused.
- A menu item that is not in the catalog opens no conflict. A second disagreeing draft for a key that already has an open conflict opens no new one.
- Fact keys: `item:variation` slugs for menu items, the matching `svc_` ID for a service, snake_case slugs for policies and FAQ, and `phone`, `email` or `address` for contact.
- Resolving a conflict writes `fact.changed` with the `cfl_` ID as `correlationId` and `actorType: "owner"`. `extraction.completed` uses the `file_` ID and `actorType: "system"`.
- A failed extraction stores a fixed safe reason on the server record. It is not in the API response because `FileRecord` has no field for it.
- Extraction uses `OPENAI_BUILDER_MODEL`. SPEC names no separate model.
- Caps I chose: 60 MB uncompressed for a spreadsheet archive, 5 sheets, 1000 rows, 30 cells per row, 200 characters per cell, 200 facts per file.

### Not verified

- The real OpenAI path has never run. The request shapes for file and image input come from the official docs and are tested against a fake client.
- The recorded outputs were written by hand. A document is recognized by a marker phrase, so an unknown document extracts to zero facts until there is a key.
- New dependency `exceljs` pulls in `uuid@8`, which `npm audit` flags as moderate. The advisory is about a caller-supplied buffer, which exceljs does not use.

## B-17 publish, pause and versions, and B-27 rollback (2026-11-13)

Routes: `POST /api/agents/:id/publish`, `POST /api/agents/:id/pause`, `GET /api/agents/:id/versions`, `POST /api/agents/:id/rollback`. Everything is in `apps/server/src/builder/publish`. The version store, the live-agent pointer, the event sink and the catalog sync are in-memory or do-nothing stand-ins behind interfaces, passed through `options.publish`, until the database and the Square adapter are wired in.

A published version is a deep frozen copy of the spec. No code path updates or deletes one. One publish runs at a time per agent (an in-memory lock, so it holds for one server process only).

### Choices made where the docs were silent

- Publish does not refuse merely because unconfirmed chat drafts exist. It refuses when a fact the agent requires is not verified.
- Publishing a live agent with an unchanged draft writes a new version. API.md covers only the paused case, where no new version is written.
- Pause is allowed only from `live` and does not change which agent answers the number (API.md: "The `live_agent` row does not change").
- Rollback points the active version at the earlier one and writes no version row. A paused agent stays paused, and the draft spec is not changed.
- `makeLive` defaults to false. If the agent already answers the number, the number follows its new version even with `makeLive: false`.
- Publish runs the catalog sync on every call, then the conflict check, then spec validation, in the order API.md lists them. The other stop conditions in FLOWS (missing price, missing time zone, an integration down) are not checked at publish yet. SPEC 2.9 has a proposed ruling that publish checks all of them.
- The publish and rollback responses always include `phoneNumber` (the package's `PublishResponse` requires it). `agent.isLiveAgent` says whether this agent answers it. Pause returns the agent summary itself (the package's `pauseAgent` response is `Agent`).
- Rollback honors `makeLive` (it is in the package's `RollbackBodySchema`): true moves the number to the agent, as on publish.
- Events use the `agt_` ID as `correlationId` and `actorType: "owner"`.
- With no `TWILIO_PHONE_NUMBER`, the in-memory pointer uses the fixture `DEMO_PHONE_NUMBER` (the API.md 3.6 example).

### Not verified

- No database, no real Square sync, no real live-agent table or route.

## Contracts swap (2026-11-14)

The builder now imports every schema and type from `@abos/contracts` and uses the shared mock toolset. `pending-contracts.ts`, `extraction/types.ts`, `fixtures.ts` and `runner/mock-toolset.ts` are deleted.

### What changed

- Registry: the rows, the tool map (`TOOL_CAPABILITY`), `toolsForCapabilities` and the bundle steps (`capabilitiesForBundle`) come from the package. `CAPABILITY_RULES`, `validateCapabilitySet`, `fitCapabilitySet` and `splitRequestedCapabilities` stay in `registry.ts`. The load-time check is `assertToolsReadOrPropose` and still stops the server if a tool maps to a write or external_message capability.
- Tools: input schemas, descriptions and function definitions (`TOOL_INPUT_SCHEMAS`, `toolDefinitionsFor`) and `MOCK_APPROVAL_PREFIX` come from the package. Every runner guard stays.
- Mock toolset: `runner/session-toolset.ts` routes each call to `createMockToolsetRegistry().forSession(ctx.testSessionId, ctx.businessId)`, on the runner's clock, and `reset(key)` resets that session. It refuses a call with no `testSessionId` or a context that fails `ToolContextSchema`.
- Routes parse params, queries and bodies with the `ENDPOINTS` schemas, then apply the builder's own limits (message text 4000 characters, test message 2000, preview at most 10 scenarios of 60 characters, pause body strict). Every response is checked against the endpoint's response schema before it is sent (`respond.ts`); a mismatch answers `INTERNAL`.
- `inputMode` is now required on `POST /api/builder/sessions/:id/messages` (the package's `BuilderMessageBodySchema`). It defaulted to `text` before.
- The spec is checked with the package's `AgentSpecSchema` plus the builder's limits on top (`spec.ts`: name at most 80, goal 1 to 300, greeting at most 300, at least one capability). Unknown keys in a spec are now dropped instead of refused.
- Events: both sinks are typed with the package's `ActivityEvent`. Every event goes through `assertContractEvent` (`events.ts`) before it reaches a sink. Every event the builder writes passed the check, including `fact.changed` on conflict resolve and `agent.published` with `rolledBackFrom`, so no payload changed.
- Recorded data uses the shared fixtures: service IDs `svc_haircut`, `svc_beard_trim`, `svc_haircut_beard`, the modifier `SQ_MOD_MUSHROOMS`, the fixture opening hours, the `cat_marg_lg` style catalog row IDs and the fixture fact IDs. The recorded hours sheet and menu were moved to the fixture hours, so the hours sheet still opens one Friday conflict only.
- The barbershop scripts look from tomorrow up to six days on for the first open day, because the shop is closed on Sunday and Monday in the fixtures. On the fixture clock (Saturday) the first open day is Tuesday 2026-11-17, where the fixture busy blocks and booked haircut leave 11:30 as the first slot.
- The shared fixtures already hold the pizza `message_consent` policy and the barbershop `min_notice` and `message_consent` policies. The recorded interviews therefore find nothing missing. The tests that show the asking path remove those facts from the knowledge reader. The recorded replies no longer say how many things are left; the builder adds the question for each missing field.
- Replies are plain text. The agent and builder instructions say no Markdown, and `runner/plain-text.ts` strips emphasis, list markers, headings, quotes and links from every agent reply and from the builder model's reply.

### Choices made where the docs were silent

- `POST /api/agents` with `{ spec }` does not require `id`, `businessId`, `version` and `status`, which the server sets. The package's `CreateAgentBodySchema` requires them. An unknown capability still answers `CAPABILITY_NOT_ALLOWED` (API.md 3.4), so the registry check runs before the schema.
- `stopConditions` items carry `conflictIds` with `open_conflict`, and preview examples carry `guardrail` when one fired. Neither field is in the contract; both pass the contract schemas, which do not refuse extra fields.

### Not verified

- The shared mock toolset registry has no way to delete a session, only to reset it. Each test session and each preview scenario leaves one small instance in memory until the server restarts.

## Web after the day's merges (2026-11-14)

What reached `main` today on the web side and in the builder, and what is still not verified. `docs/notes-web-real-mode.md` has the endpoint table and the status of each real-mode mismatch. `docs/DEMO-LAPTOP.md` has the steps to run the web app against a server.

### What changed

- #101: the voice retry countdown reads the time left from the voice session's own clock (`retryInMs()` in `apps/web/app/(dashboard)/build/voice/voiceSession.ts`). It also added `docs/DEMO-LAPTOP.md` and `docs/notes-web-real-mode.md`.
- #102: the web mock seeds from the shared demo world. `apps/web/mocks/seed.ts` calls `materializeFixtures(now)` from `@abos/contracts/fixtures`. The copies under `apps/web/mocks/fixtures` are deleted.
- #107 (U-10): every UI state can be reached in mock mode. New shared pieces: `ProviderHealthNotice` (`apps/web/components`), `actorName` (`apps/web/lib/format.ts`), and the mock controls `simulateEmptyBusiness`, `simulateRequestFailure`, `clearRequestFailures` and `simulateSheetsDisconnected`. The controls are also on `window.__abosMock` in mock mode.
- #109: real-mode handling. The business selector never shows a business the server did not return (`apps/web/lib/session/business-list.ts`, `BusinessListGate.tsx`, `ApiBusinessProvider.tsx`). Publish and rollback errors are plain sentences. A failed background refresh keeps the last data and shows `RefreshFailedNotice`. Conflict resolution falls back to the facts list when the server asks for it. A missing price route reads as "The price editor is not available on this server".
- #106: the builder review fixes from #96 (commit `851200a`). It was merged into the integration branch and reached `main` inside #97. Publish refuses when a required fact is not verified (`missing_required_fact`), a chat turn opens one approval, the turn and publish share one stop condition list, and a rollback of a paused agent does not move the phone number.
- #97: the integration branch. `main` now registers all 42 contract endpoints, including the price route and the order cancel and execution resolve routes.
- #110: the server resolves "keep the current value" on a database conflict itself. The web fallback from #109 for that case should no longer be reached against `main`. This comes from reading `apps/server/src/app.ts`, not from a run.

### Earlier notes on this page that no longer hold

The sections above stay as they were written. These statements in them were true on their date and are not true on `main` now:

- "U-01, Assumptions, Connection health": the top bar now reads `GET /api/integrations/health` (`apps/web/components/shell/ConnectionHealth.tsx`).
- "U-02": `pending-contracts.ts` and `api-shapes.ts` are gone. The web app imports from `@abos/contracts` (#91).
- "B-16": `proposedChange` is now set when a turn creates a `fact_edit` approval through `proposeFactFromChat` (`apps/server/src/builder/session/service.ts`). With a database, the composed server passes database stores and a real `BuilderAuth` to the builder (`apps/server/src/compose/index.ts`).
- "B-17 and B-27, Not verified": with a database, publish uses the database version store and the Square catalog sync, and the database live-agent store when `TWILIO_PHONE_NUMBER` is set (`apps/server/src/compose/index.ts`, `builder-publish.ts`). Uploaded files and their conflicts are still held in memory by the builder (comment in `apps/server/src/compose/index.ts`).

### Not verified

- **The web app against the real server with a real sign-in.** No Supabase sign-in was done from the web app, and no call was made from it to the deployed server. Every real-mode statement in these notes comes from reading the code and from tests that use the mock or hand-built error objects. Which commit the deployed server runs was not checked.
- **Voice with a real microphone (U-12, issue #50, still open).** The voice code is tested against fakes only. Nobody has spoken to the builder in a browser and heard it answer. The items under "B-24, Not verified" still stand.
- **The outside owner test (U-11, issue #49, still open).** No small-business owner outside the team has tried the builder yet.
- Supabase Realtime delivery to `useActivityFeed` on a real project.
- The price editor, conflict resolution, publish and rollback from the web app against a real server. Their error texts were written from the server code and the contract.
- The Playwright tests run in mock mode only. They do not cover real mode.
