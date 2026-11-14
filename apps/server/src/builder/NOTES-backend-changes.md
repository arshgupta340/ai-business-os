# Backend changes to the builder (2026-11-14)

Made by the backend side, at the project owner's request, while the UI lead was away. Small changes only, in the builder's existing structure. Branch `arsh/builder-hookup-2`. Two commits: the first change (07389a0) and fixes for the review of it in `.review/builder-hookup-2-codex.md`.

## File by file

- `index.ts`
  - An `onRoute` hook at the top of the plugin sets route config `{ auth: 'builder' }` on every route the plugin registers (sessions, agents, publish, extraction, voice), unless a route declares its own. The server's default-deny guard (`auth/verify.ts`) then leaves these routes to the builder's own `BuilderAuth`.
  - New optional plugin option `proposeFactFromChat`, passed to `BuilderSessionService`.
- `route-auth.test.ts` (new): registers the plugin on a bare Fastify, lists every route and fails if one lacks `auth: 'builder'`.
- `session/fact-values.ts` (new): turns a chat answer into the value its readers expect, or refuses it with a hint. Hours become `{ open, close }` or `{ closed: true }` (HoursValueSchema; a time needs am or pm, or 24-hour form with minutes). `min_notice` and `pickup_window` become `{ minutes, text }`. `special_requests` becomes `{ allowed, text }` from a clear yes or no. `message_consent` becomes `{ required: true, wording }`. Also `sameFactMeaning` (repeat or correction) and `readableFactValue`.
- `session/service.ts`
  - `ProposeFactFromChatInput` is the composition's input plus `subjectId`, `fromVersion` and `before`. New key: the subject is the draft fact row, whose value equals `value`, with `fromVersion: 0` and `before: null`. Existing key: the subject is the verified fact, with its version and value.
  - With the option present: an answer is typed first. One the builder cannot read is not saved, and the reply asks again. A new answer, a change to a verified fact, or a correction of an earlier draft is saved as a draft and proposed. An exact repeat (same meaning) is not saved again.
  - Each turn proposes the latest draft of each field that has no open approval. That covers a new draft, a draft whose earlier proposal failed (retried on the next turn), and a repeated answer whose approval is older than the 10 minute expiry. A draft replaced by a correction is never proposed.
  - The approval IDs are recorded on the stored assistant message of the turn (field `proposals`), so they survive a restart. The field is removed from every message the API returns.
  - Order in a turn: drafts, then the session write (owner message and reply), then the proposals, then a second session write with the approval IDs. A failed proposal keeps the draft, marks nothing, and the reply says it will try again.
  - Turns of one session run one at a time in this process (a per-session lock). Before the session write, the stored session is read again, and the turn is refused (INVALID_STATE) if another process changed it.
  - Without the option, behavior is as before: only a missing field takes an answer, kept as `{ text }`.
- `session/requirements.ts`: `publishStopConditions(spec, context)` takes a validated spec and uses verified facts only: `missing_timezone`, `missing_message_consent_policy` and `empty_catalog`. The interview's `stopConditions` is unchanged.
- `publish/integrations.ts` (new): the `IntegrationHealthReader` port. A phone agent needs `twilio` and `openai`. A `restaurant_order_taker` needs `square`, an `appointment_booker` needs `google_calendar`, and capabilities add `message_channel`, `google_sheets`, `square` and `google_calendar`. When a reader is passed, a required provider that is `disconnected` or missing from its result stops the publish; `degraded` does not.
- `publish/index.ts`: new optional `PublishOptions.integrations`.
- `publish/service.ts`
  - Publish order: catalog sync, conflict store, spec validation of the draft, an open required conflict in the knowledge (CONFLICT_UNRESOLVED), missing facts (VALIDATION_FAILED, `details.issues` has one `{ path, code, message }` per code), integrations (INTEGRATION_UNAVAILABLE with `details.provider` and `details.providers`). A malformed stored draft is VALIDATION_FAILED or CAPABILITY_NOT_ALLOWED, never a 500.
  - Rollback of a paused agent moves only the active version; the agent stays paused. The number still follows if this agent already answers it. Rollback with `makeLive: true` on a paused agent is INVALID_STATE.
- Tests: `session/chat-proposals.test.ts` and `session/fact-values.test.ts` (new), `session/service.test.ts`, `publish/routes.test.ts`. The old test "a paused agent goes live again on rollback" was replaced by two tests for the new ruling. The describe "calls keep their pinned version" was renamed: it shows version immutability only, and no call is run.

## FLOWS stop conditions at publish

| # | Condition | Checked |
|---|---|---|
| 1 | Mandatory price missing | Only as `empty_catalog`. The builder cannot see which products need a price. |
| 2 | Ambiguous product mapping | No. The builder has no data for it. |
| 3 | No time zone | Yes, `missing_timezone` |
| 4 | Required integration unreachable | Yes, when `publish.integrations` is passed |
| 5 | Contradicting policies, open conflict | Open required conflicts: CONFLICT_UNRESOLVED. Contradicting policies with no conflict row: no. |
| 6 | Consent policy missing | Yes, `missing_message_consent_policy`, verified facts only |
| 7 | Unsupported tool | Yes, spec validation |
| 8 | Owner has not confirmed | Yes, `confirm: true` in the route |

## Options the server composition must pass

All are optional; each has an in-memory or do-nothing default.

| Option | Interface |
|---|---|
| `sessions` | `BuilderSessionStore` (session/stores.ts) |
| `agents` | `AgentDraftStore` (session/stores.ts) |
| `draftFacts` | `DraftFactStore` (session/stores.ts) |
| `knowledge` | `BusinessKnowledge` (session/knowledge.ts) |
| `liveAgent` | `LiveAgentReader` (agents.ts) |
| `proposeFactFromChat` | `ProposeFactFromChat` (session/service.ts) |
| `publish.versions` | `AgentVersionStore` (publish/stores.ts) |
| `publish.liveAgents` | `LiveAgentStore` (publish/stores.ts) |
| `publish.events` | `PublishEventSink` (publish/stores.ts) |
| `publish.syncCatalog` | `CatalogSync` (publish/catalog-sync.ts) |
| `publish.integrations` | `IntegrationHealthReader` (publish/integrations.ts) |
| `extraction.files` | `FileStore` (extraction/stores.ts) |
| `extraction.facts` | `UploadFactStore` (extraction/stores.ts) |
| `extraction.conflicts` | `ConflictStore` (extraction/stores.ts) |
| `extraction.catalog` | `CatalogReader` (extraction/stores.ts) |
| `extraction.events` | `ActivityEventSink` (extraction/stores.ts) |
| `extraction.extractor` | `DocumentExtractor` (extraction/model.ts) |

No store was constructed internally without an option. The publish lock and the session turn lock are in-process by design and are not options.

`ProposeFactFromChat` input gained `subjectId` (required) in the review fixes. The composition's current function still fits, because it ignores the fields it does not read. To create a new-key approval it must forward `subjectId`, `fromVersion` and `before` to the engine. `publish.integrations` fits as `{ read: () => health.read({ refresh: false }) }`.

## What remains

- New-key proposals depend on the engine accepting a draft subject with `fromVersion: 0` (being changed on the integration branch). This was not run against Postgres here. The composition's function is checked only by type.
- A crash, or a failed session write, after an approval is opened but before its ID is recorded, means the next turn proposes the same subject again. The engine receives the same `subjectId`, but the builder cannot stop a second approval. Avoiding that needs the engine to return the open approval for a subject, or a transaction across the session write and the proposal, which the session store does not offer.
- The per-session lock holds for one process only. Across processes the re-read before the write is a check, not an atomic compare and swap.
- When a turn's write fails, the owner's message for that turn is lost; its drafts are kept and proposed later.
- After an approval is approved, rejected or expires, the builder learns of it only from the verified facts (approved) or the 10 minute clock (repeat after expiry). A rejected approval is not re-proposed unless the owner corrects the answer.
- A turn reports only the first approval when several drafts are proposed in one turn.
- Opening hours that cross midnight, and lengths like "an hour and a half", are refused rather than guessed.
- The SPEC 2.9 rows for the paused-rollback and publish rulings are not in this checkout's SPEC.

## Changes after Saina's review

- `session/requirements.ts`: one `stopConditions(spec, context)` for the turn and publish, on verified facts only. Every required fact left missing (hours, pickup window, special requests, notice, services) is now `{ code: 'missing_required_fact', path: <field> }`; name and goal stay with spec validation. `publishStopConditions` is the same list without `open_conflict`.
- `publish/service.ts`: each `missing_required_fact` issue has the field as `path` and a sentence from `missingFactMessage`. The other three codes keep `path` equal to the code.
- `session/service.ts`: a turn opens at most one approval; the other drafts are proposed on later turns.
- `session/service.ts`: the turn's `stopConditions` is the shared list (what publish would refuse on, plus `open_conflict`). `missingFields` and `progress` still count chat drafts.
- `publish/service.ts`: rollback of a paused agent no longer touches the live agent pointer or writes `live_agent.changed`. The next publish moves the pointer.
- `session/service.ts`: a failed proposal logs its error code only. `INVALID_STATE` and `NOT_FOUND` are recorded as refused: the reply says the change could not be sent for confirmation, and it is retried only if the owner repeats or corrects it. Other errors keep the retry.
- `session/service.ts`: if the write that records approval IDs fails, the turn still returns `proposedChange`, and the records are kept in the process and written with the next turn. A restart before that still allows a duplicate.
- `session/fact-values.ts`: a length with a second bare number ("15 to 20 minutes", "between 1 and 2 hours") is refused with the minutes hint.
- `publish/integrations.ts`: comment fixed. A required provider left out of the health result is taken as down.
- `route-auth.test.ts` now calls every registered route with no token and expects 401 `UNAUTHENTICATED`. `GET /api/builder/ping` is the one listed exception. It should be removed, but two server tests outside this folder (`apps/server/test/app.test.ts` and `apps/server/test/adversarial/access.test.ts`) call it, so the route and those tests have to go in one pull request.
- `session/service.ts`: `VALIDATION_FAILED` and `CAPABILITY_NOT_ALLOWED` from the engine are treated as refused, like `INVALID_STATE` and `NOT_FOUND`, so the chat does not promise a retry that cannot work.
- `publish/service.ts`: rollback also checks open required conflicts from the business knowledge (the database), like publish.
- `index.ts`: the session service gets `app.log` for those error codes.
