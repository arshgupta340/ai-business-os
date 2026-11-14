# Backend changes to the builder (2026-11-14)

Made by the backend side, at the project owner's request, while the UI lead was away. Small changes only, in the builder's existing structure. Branch `arsh/builder-hookup-2`.

## File by file

- `index.ts`
  - An `onRoute` hook at the top of the plugin sets route config `{ auth: 'builder' }` on every route the plugin registers (sessions, agents, publish, extraction, voice), unless a route declares its own. The server's default-deny guard (`auth/verify.ts`) then leaves these routes to the builder's own `BuilderAuth`.
  - New optional plugin option `proposeFactFromChat`, passed to `BuilderSessionService`.
- `route-auth.test.ts` (new): registers the plugin on a bare Fastify, inventories every route and fails if one lacks `auth: 'builder'`.
- `session/service.ts`
  - New exported types `ProposeFactFromChat` and `ProposeFactFromChatInput`. The input is the shape of `compose/builder.ts` `ProposeFactFromChat` plus `fromVersion` and `before` (0 and null for a new key, else the verified fact's version and value). The composition's function still fits (a type test checks it).
  - When the option is present: every chat answer saved as a draft calls it, and the turn sets `proposedChange` to the first approval returned. An answer that changes a verified fact is also saved as a draft and proposed (once per key per session; an answer that repeats the verified text proposes nothing).
  - A failed call keeps the draft, and the reply adds a sentence saying the answer still needs confirmation.
  - When the option is absent, behavior is unchanged.
- `session/service.test.ts`: tests for present, absent, new key, existing key, a repeated value, and failure.
- `session/requirements.ts`: new `publishStopConditions(spec, context)`. It uses verified facts only and the existing codes `missing_timezone` and `missing_message_consent_policy`, plus a new code `missing_price` (the builder sees only the catalog's item count, so it fires when the spec needs a catalog and the catalog is empty). The interview's `stopConditions` is unchanged.
- `publish/integrations.ts` (new): the `IntegrationHealthReader` port and the map from capability to provider (`square`, `message_channel`, `google_calendar`, `google_sheets`). Only `disconnected` stops a publish; `degraded` does not.
- `publish/index.ts`: new optional `PublishOptions.integrations`, passed to the service.
- `publish/service.ts`
  - Publish now checks, after the catalog sync and the conflict store: an open required conflict in the knowledge (CONFLICT_UNRESOLVED), missing facts (VALIDATION_FAILED, `details.issues` has one `{ path, code, message }` per stop condition code), then integrations (INTEGRATION_UNAVAILABLE with `details.provider` and `details.providers`). Unconfirmed chat drafts never stop a publish.
  - Rollback of a paused agent moves only the active version; the agent stays paused. The number still follows if this agent already answers it. Rollback with `makeLive: true` on a paused agent is INVALID_STATE, as `PUT /api/live-agent` refuses an agent that is not live.
- `publish/routes.test.ts`: tests for each stop condition. The old test "a paused agent goes live again on rollback" was replaced by two tests for the new ruling.

## Options the server composition must pass

All are optional; each has an in-memory or do-nothing default.

| Option | Interface |
|---|---|
| `sessions` | `BuilderSessionStore` (session/stores.ts) |
| `agents` | `AgentDraftStore` (session/stores.ts) |
| `draftFacts` | `DraftFactStore` (session/stores.ts) |
| `knowledge` | `BusinessKnowledge` (session/knowledge.ts) |
| `liveAgent` | `LiveAgentReader` (agents.ts) |
| `proposeFactFromChat` | `ProposeFactFromChat` (session/service.ts), new |
| `publish.versions` | `AgentVersionStore` (publish/stores.ts) |
| `publish.liveAgents` | `LiveAgentStore` (publish/stores.ts) |
| `publish.events` | `PublishEventSink` (publish/stores.ts) |
| `publish.syncCatalog` | `CatalogSync` (publish/catalog-sync.ts) |
| `publish.integrations` | `IntegrationHealthReader` (publish/integrations.ts), new |
| `extraction.files` | `FileStore` (extraction/stores.ts) |
| `extraction.facts` | `UploadFactStore` (extraction/stores.ts) |
| `extraction.conflicts` | `ConflictStore` (extraction/stores.ts) |
| `extraction.catalog` | `CatalogReader` (extraction/stores.ts) |
| `extraction.events` | `ActivityEventSink` (extraction/stores.ts) |
| `extraction.extractor` | `DocumentExtractor` (extraction/model.ts) |

No store was constructed internally without an option, so no new store option was needed. The publish lock (`KeyedLock`) is in-process by design and is not an option.

## Open points for review

- `policy/engine.ts` `proposeFactEdit` refuses a key with no verified fact (NOT_FOUND). Until it accepts a new key, a new-key chat answer reaches the failure path: the draft is kept and the reply says confirmation is pending.
- The composition does not pass `proposeFactFromChat` or `publish.integrations` yet (that is `compose/`, outside this change). A reader over the health monitor fits as `{ read: () => health.read({ refresh: false }) }`.
- A turn reports only the first approval when one turn saves several drafts. The others are created but not shown.
- Not checked at publish: an ambiguous product mapping (no data for it in the builder). Unsupported tools are checked by spec validation, owner confirm by the route.
