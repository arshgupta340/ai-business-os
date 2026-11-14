# AgentPhone: what the vendor's documentation says

Read on 2026-11-14 from AgentPhone's own pages. Nothing here was tested: there is no AgentPhone account or key yet. Every fact carries the page it came from. The OpenAPI file (https://docs.agentphone.ai/openapi.json) was downloaded on 2026-11-14 and searched for the request and response fields named below.

Index of the docs: https://docs.agentphone.ai/llms.txt

## Account, keys and base URL

- Base URL `https://api.agentphone.ai`; every call sends `Authorization: Bearer <API key>`. Source: https://agentphone.ai/skills.md, https://docs.agentphone.ai/openapi.json (`servers`).
- An optional `X-Sub-Account-Id` header scopes a key to a sub-account. Source: https://agentphone.ai/skills.md.
- Phone numbers are E.164. Source: https://agentphone.ai/skills.md.

## Numbers

- `POST /v1/numbers` buys a number; `country` is `US` or `CA` only. Source: https://agentphone.ai/skills.md.
- A number has `id`, `phoneNumber`, `agentId` and `outboundSms`, whose values are `enabled`, `activating` or `registration_required`. Source: https://docs.agentphone.ai/openapi.json (schema `PhoneNumberResponse`, `PhoneNumberResponseOutboundSms`).
- `GET /v1/numbers/{number_id}` reads one number. Source: https://agentphone.ai/skills.md.

## Agents and voice modes

- An agent has `voiceMode` `webhook` (the default) or `hosted`. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- In `hosted` mode AgentPhone's own built-in LLM runs the call from the agent's `systemPrompt` and opens with `beginMessage`; no webhook is needed. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- In `webhook` mode caller speech is transcribed and sent to our webhook, and our server controls every reply. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- An inbound call to a webhook-mode agent with no webhook configured fails. Source: https://agentphone.ai/skills.md.
- `transferNumber` on the agent is required for `action: "transfer"`. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- `interruptionSensitivity` (0.0 to 1.0) tunes barge-in and `enableBackchannel` toggles "uh-huh" sounds. Source: https://docs.agentphone.ai/documentation/guides/calls.md, https://agentphone.ai/skills.md.

## Webhooks

- One webhook per project: `POST /v1/webhooks` with `url`, `contextLimit` (0 to 50, default 10) and `timeout` (5 to 120 seconds, default 30). A per-agent webhook (`POST /v1/agents/{agent_id}/webhook`) replaces the project webhook for that agent. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- `POST /v1/webhooks` "Register or update the webhook URL for this account ... A new secret is generated each time." The response carries `secret`. Source: https://docs.agentphone.ai/openapi.json (`/v1/webhooks` post description, schema `WebhookResponse`), https://docs.agentphone.ai/documentation/guides/webhooks.md.
- Events: `agent.message` (inbound SMS, MMS, iMessage, RCS, WhatsApp and voice; `channel` says which), `agent.call_ended`, `agent.reaction`, `agent.contact_shared`, `number.released`. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- Payload envelope: `event`, `channel`, `timestamp`, `agentId`, `data`, `conversationState`, `recentHistory`. SMS `data` has `messageId`, `conversationId`, `numberId`, `from`, `to`, `message`, `mediaUrl`, `direction`, `receivedAt`. Voice `data` has `callId`, `numberId`, `from`, `to`, `status`, `transcript`, `confidence`, `direction`. `agent.call_ended` `data` adds `startedAt`, `endedAt`, `durationSeconds`, `disconnectionReason`, a `transcript` array, `summary`, `userSentiment`, `callSuccessful`. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- Test deliveries carry `"test": true` at the top level. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.

### Signature

- Headers: `X-Webhook-Signature` (`sha256=<hex>`), `X-Webhook-Timestamp` (Unix time of delivery), `X-Webhook-ID` (unique delivery ID, for idempotency), `X-Webhook-Event`. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- The signature is HMAC-SHA256 with the webhook secret over the timestamp, a period, then the raw request body. Verify against the raw bytes before parsing JSON. Reject a timestamp more than 5 minutes from now. The docs' sample compares `sha256=<hex>` with a constant-time compare. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.

### Retries and dedupe

- Non-voice `agent.message`: answer 2xx within 5 seconds; up to 8 attempts in total (about 15 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, each with 10 percent jitter). Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- Voice `agent.message`: the response is part of the live turn; no retry. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- `agent.call_ended`, `agent.reaction`, `agent.contact_shared`, `number.released`: attempted once, no retries. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- A retried delivery keeps its `X-Webhook-ID`. Record the ID durably after verifying the signature and before acting; in-memory tracking is not enough. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.

## A voice turn (webhook mode)

- Flow: the platform answers, streams audio, transcribes, detects end of turn, then POSTs `agent.message` with `channel: "voice"` and the transcript; our reply is spoken; the caller can barge in at any time. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- Our answer must be a JSON object. A string, number or array is ignored and the caller hears silence. An empty body produces no speech. Source: https://docs.agentphone.ai/documentation/guides/webhooks.md.
- Fields: `text` (to speak), `hangup` (true ends the call after speaking), `action` (`"transfer"` or `"hangup"`), `digits`, `send_message` (an SMS to the caller during the call), `interim` (NDJSON only). Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- Streaming: `Content-Type: application/x-ndjson`, one JSON object per line; `"interim": true` chunks are spoken while the turn stays open and the first chunk without it closes the turn. Send an interim chunk before slow work. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- Timeout: 30 seconds by default, 5 to 120 per webhook. On timeout the request is cancelled and the caller hears silence for that turn. Source: https://docs.agentphone.ai/documentation/guides/calls.md.
- Ending a call: from the webhook, `hangup: true` or `action: "hangup"`. `POST /v1/calls/{id}/end` also exists and answers 409 unless the call is in progress. Source: https://docs.agentphone.ai/documentation/guides/calls.md, https://agentphone.ai/skills.md.
- Live transcript: `GET /v1/calls/{call_id}/transcript/stream` (server-sent events `connected`, `turn`, `ended`). Source: https://docs.agentphone.ai/documentation/guides/calls.md.

## Texting

- `POST /v1/messages` with `to_number`, `body`, and one sender selector (`from_number`, `number_id` or `agent_id`). The platform picks the transport for the sending number. Source: https://docs.agentphone.ai/documentation/guides/messages.md.
- The response has `id`, `status` (`"sent"` in the example), `channel`, `from_number`, `to_number`, `conversation_id`. A success means accepted, not delivered. Source: https://docs.agentphone.ai/documentation/guides/messages.md, https://docs.agentphone.ai/openapi.json (schema `SendMessageResponse`).
- Idempotency: "The API doesn't support customer-supplied idempotency keys." A timeout, dropped connection or 5xx on `POST /v1/messages` may already have sent; treat it as unknown and never resend automatically. A 409 `DELIVERY_UNCONFIRMED` may already have sent. Source: https://docs.agentphone.ai/documentation/reference/error-handling.md. The OpenAPI file has no idempotency header on `/v1/messages`.
- The TypeScript SDK retries 408, 429 and 5xx twice by default, including sends; the docs say to set `maxRetries: 0` for sends. Source: https://docs.agentphone.ai/documentation/reference/error-handling.md, https://docs.agentphone.ai/documentation/sdks/typescript.md.
- Delivery status: there is no delivery-receipt webhook. Message history carries `status` (`sent`, `delivered`, `failed`, inbound `received`), `failureReason`, `errorCode`, `deliveredAt`. Poll `GET /v1/conversations/{conversation_id}/messages`, or `GET /v1/numbers/{number_id}/messages` (cursor paging with `limit`, `before`, `after`, `cursor`). Source: https://docs.agentphone.ai/documentation/guides/messages.md, https://docs.agentphone.ai/documentation/guides/webhooks.md, https://docs.agentphone.ai/openapi.json (schemas `MessageInConversation`, `MessageListResponse`, `MessageResponse`).
- Error body: `{"error": {"message", "code", "type", "details"}, "request_id"}`, or a plain `{"detail": "..."}` for 401, 403, throttles, 402 and number 409s. 400, 401, 402, 403, 404 and 422 are not retryable; 5xx is retryable for reads only. Source: https://docs.agentphone.ai/documentation/reference/error-handling.md.

## A2P 10DLC

- Outbound SMS to US numbers requires SMS registration (a carrier requirement). Inbound works without it. Source: https://docs.agentphone.ai/documentation/guides/messages.md, https://docs.agentphone.ai/sms-registration.md.
- The customer submits business and contact details, the use case, sample messages, the consent flow and a public image of the opt-in. Registration types: `sole_proprietor` (no EIN), `standard_brand`, `high_volume`. AgentPhone runs the process through `POST /v1/register` and `GET /v1/register/status`. Source: https://docs.agentphone.ai/sms-registration.md.
- One-time fees from the balance: 25 dollars for sole proprietor or standard brand, 70 dollars for high volume. No fixed review time; "submitting the form is not approval". Source: https://docs.agentphone.ai/sms-registration.md.
- Throughput and daily caps are set by carriers from the campaign, not by AgentPhone, and usually do not show as API errors. Source: https://docs.agentphone.ai/documentation/reference/messaging-rate-limits.md.

## Rate limits and pricing

- Per-minute limits include: create number 20, create call 120, create agent 30, update agent 20, set webhook 10, test webhook 10. Source: https://agentphone.ai/skills.md.
- Prices on the pricing page: 3 dollars per US or Canadian number per month; voice 13 cents per minute over webhook, 22 cents per minute hosted, billed per second; SMS 2 cents per segment inbound or outbound; MMS 3 cents; no plans or minimums; new accounts get 5 dollars of credit. Source: https://agentphone.ai/pricing.

## SDK and MCP server

- npm package `agentphone`; the docs name version 1.0.25, and the npm registry's latest on 2026-11-14 is 1.0.26. Client `new AgentPhoneClient({ token, maxRetries })`. The docs list no `messages.send` method and no webhook signature helper. Source: https://docs.agentphone.ai/documentation/sdks/typescript.md, https://registry.npmjs.org/agentphone/latest.
- MCP server: npm package `agentphone-mcp` (0.8.0 on the registry on 2026-11-14), run with `npx -y agentphone-mcp` and env `AGENTPHONE_API_KEY` (and optional `AGENTPHONE_BASE_URL`). For Claude Code the docs give the hosted server: `claude mcp add --transport http agentphone https://mcp.agentphone.ai/mcp`, with browser sign-in or an `Authorization: Bearer` header. It has 28 tools, including `send_message`, `make_call`, `buy_number` and `set_webhook`. Source: https://docs.agentphone.ai/mcp.md, https://registry.npmjs.org/agentphone-mcp/latest.

## The owner's notes checked against the docs

| Note | What the docs say |
|---|---|
| One REST API for US and Canada numbers with voice and SMS | Confirmed (numbers are `US` or `CA`; calls and messages share one API). |
| A single webhook for incoming calls and texts | Confirmed: one project webhook, one `agent.message` event for both, `channel` tells them apart. |
| A hosted voice mode with real-time transcription | Partly wrong for our use. "Hosted" means AgentPhone's own LLM runs the call from a system prompt, so our read and propose tools and the approval flow would not be in the loop. Real-time transcription to our server is the `webhook` voice mode. This build uses `webhook` mode. |
| Python and npm SDKs | Confirmed (`agentphone` on PyPI and npm). The npm SDK has no send-message method in its docs and no signature helper, so this build calls the REST API with `fetch`. |
| An MCP server, `npx agentphone-mcp` | Confirmed. The docs give Claude Code the hosted MCP URL; `npx -y agentphone-mcp` is documented for local MCP clients. |
| It handles A2P 10DLC registration itself | Partly. AgentPhone runs the registration, but the owner still submits the business, use case, samples and opt-in proof, pays 25 or 70 dollars, and waits for carrier review with no stated time. Until approved, outbound SMS to US numbers is blocked. So switching to AgentPhone does not by itself make texting work today. |
| `AGENTPHONE_API_KEY` and `AGENTPHONE_WEBHOOK_SECRET` | `AGENTPHONE_API_KEY` is the name the MCP server uses. The webhook secret is returned by `POST /v1/webhooks` and changes every time the webhook is set. We also need the number's ID and its E.164 number (`AGENTPHONE_NUMBER_ID`, `AGENTPHONE_PHONE_NUMBER`). |

## Not confirmed in the docs

- Whether the `timestamp` field inside the JSON body equals `X-Webhook-Timestamp`. We use the header only.
- Whether a retried delivery carries a new `X-Webhook-Timestamp` (and so a new signature) or the original one. The server accepts either: it dedupes on the delivery ID and on the signed content.
- The format of the webhook secret. The example response in the webhooks guide shows `"secret": "whsec_abc123..."`; no page states the prefix as a rule. Read again on 2026-11-14.
- Whether `from` is present on a call from a withheld number. The server treats a missing or odd `from` as withheld.
- The character set of `X-Webhook-ID` and of call and message IDs. The examples look like `del_pqr901`, `call_abc123`, `msg_abc123`; the server accepts letters, digits and `. _ : -` and refuses anything else (401 or 400, with the cause in the server log).
- The exact list envelope of `GET /v1/numbers/{number_id}/messages` (`data`, `hasMore`, `nextCursor`), taken from the OpenAPI file.
- The `status` values on `agent.call_ended`. The example shows `completed`; the server maps `failed` to failed and everything else to dropped.
- What `GET /v1/webhooks` answers when no webhook is set. The webhooks guide says it "Returns `null`"; the registration script accepts that and a 404.
- The API key format. `docs/SETUP-ACCOUNTS.md` says `sk_live_`; no page read for these notes states it.
- Whether `X-Webhook-ID` is unique per event or per delivery attempt across retries for every event type (the docs say a retried delivery keeps it).
- Whether a voice `agent.message` is sent for the very start of a call (before the caller speaks), and whether the agent's `beginMessage` is spoken in webhook mode. We do not depend on either.
- What happens if our NDJSON stream closes without a final chunk.
- Whether AgentPhone sends a webhook for outbound message delivery status. The docs say no receipt event exists; we poll.
- How long message history keeps a sent message, so how long polling for a receipt can work.
- Whether an owner can push speech into a live call without a caller turn. No documented API does it in webhook mode, so an owner decision is spoken at the caller's next turn.
- The exact HTTP status for sending from an unregistered 10DLC number. The skills file says 403; the messages guide does not document it.
- Whether `POST /v1/webhooks` with the same URL keeps the old secret valid for a grace period. The docs say a new secret is generated each time.
- Whether AgentPhone supports toll-free numbers or toll-free verification.
- How `from` and `to` look on a call from a withheld or international number.
