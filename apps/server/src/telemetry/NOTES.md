# Telemetry: where each metric is recorded

Samples live in server memory (one bounded buffer per business and metric). A restart clears them. Modules take a `TelemetryPort` by injection, default `noopTelemetry`, and import nothing else from this directory. Record a duration only after the timed thing really completed. Use `timeUnlessFailed` (recorder) or call `fail` when it did not, so a failure is counted and not timed.

Some of the files below do not exist yet. The paths are where the owning tasks are expected to put the code; adjust them when those files land.

| Metric | Recorded by | Start | Stop (record) |
|---|---|---|---|
| `call_answer_latency` | Twilio voice webhook, `apps/server/src/webhooks/twilio-voice.ts` | the request arrives at `POST /webhooks/twilio/voice` | the TwiML response is sent (after the `calls` row and `call.started` are written). Do not record for the paused-agent `<Say>` path. |
| `first_audio` | phone socket, `apps/server/src/voice/phone-socket.ts` (`/ws/phone`) | the Twilio `start` event is bound to its call | the first agent `media` frame is sent to Twilio. Not when the Realtime response is requested. If the socket closes first, call `fail`. |
| `tool_latency` | the real toolset behind `ToolHandler`, `apps/server/src/tools/real/` | a deployed agent tool call is dispatched after the policy check | the tool returns `{ ok: true }`. A `{ ok: false }` result or a throw is a failure. A guardrail refusal runs no tool and records nothing. |
| `approval_time` | derived, no explicit call | `approval.requested` | the matching `approval.decided` (by `approvalId`). Expired approvals are not counted. The route derives it from activity events when an event source is wired, and replaces any explicit samples, so do not also record it. |
| `webhook_delay` | Square webhook, `apps/server/src/webhooks/square.ts` | the provider event time (`created_at` in the Square event body) | the signature is verified and the event is stored in `webhook_events`. Record only for verified, non-duplicate events; a rejected signature records nothing. Twilio status callbacks carry a `Timestamp` param and may record the same way. |

## Why only `approval_time` is derived

No activity event carries a provider event time, a server receipt time, an answer time, a first-audio time or a tool call's end. `checkout.created` to `payment.verified` is the customer's time to pay, not a webhook delay, so it is not reported under that name. `derive.ts` lists these gaps in `DERIVATION_GAPS`.

## Wiring (for the lead, in `app.ts`)

Create one recorder with `createTelemetry({ now: Date.now })`, pass it as the port to the modules above, and register `telemetryPlugin` with that recorder, the server's owner check as `guard`, and an `eventSource` that reads `activity_events` for the business.
