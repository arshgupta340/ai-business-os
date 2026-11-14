# Spike B-03: phone voice

A real phone call to the Twilio number is answered by the OpenAI Realtime speech-to-speech model. Twilio sends the call audio over a Media Stream to this Node server, which relays it to OpenAI and back. The model speaks first, can call one test tool, stops talking when the caller interrupts, and the server logs how long the first audio takes.

This folder is its own npm project. It is not part of the root workspaces. Nothing here writes audio or transcripts to disk.

## Approach

Raw WebSockets with the `ws` package, following Twilio's official sample `twilio-samples/speech-assistant-openai-realtime-api-node`. I did not use the Agents SDK `TwilioRealtimeTransportLayer`. I could not confirm from its docs that it supports `gpt-realtime-2.1`, and the raw relay gives direct control over the stream token check, the mark queue and the timing logs, which are the things this spike has to measure. The real server in `apps/server/src/voice/` can switch later if that looks simpler.

## Files

| File | What it does |
|---|---|
| `src/constants.ts` | Every OpenAI and Twilio event name and audio format string, in one block. Fix a wrong name here. |
| `src/env.ts` | Finds `.env.local` by walking up from the current folder, checks every variable, exits naming the missing one. |
| `src/server.ts` | Fastify server: `GET /health`, `POST /webhooks/twilio/voice`, and the `/ws/phone` WebSocket. |
| `src/relay.ts` | One call: Twilio Media Stream to OpenAI Realtime and back, barge-in, tool calls, timing. |
| `src/logic.ts` | Pure logic: TwiML builder, stream token store, mark queue and truncate offset, timing. |
| `src/tools.ts` | The tool table (`get_test_fact`) and the system prompt. |
| `test/logic.test.ts` | Unit tests for the pure logic. |

## Steps

1. Install Node 24. In this folder run:

   ```bash
   npm install
   npx tsc --noEmit
   npx vitest run
   ```

2. Pick a tunnel with a fixed address, so the Twilio webhook never has to change. Two options:
   - ngrok: sign up, then in the ngrok dashboard claim your free static domain (it looks like `your-name.ngrok-free.app`).
   - Cloudflare Tunnel: a named tunnel on a domain you own.

3. Add these lines to `.env.local` in the repo root (`C:\Users\arshg\AI HACK CALPOLY\.env.local`). The server finds it by walking up from this folder. Never commit this file.

   | Variable | Value |
   |---|---|
   | `OPENAI_API_KEY` | Your OpenAI API key |
   | `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` |
   | `TWILIO_ACCOUNT_SID` | From the Twilio console home page. Starts with `AC`. |
   | `TWILIO_AUTH_TOKEN` | From the Twilio console home page, next to the Account SID |
   | `TWILIO_PHONE_NUMBER` | The Twilio number, for example `+18055550123` |
   | `PUBLIC_SERVER_URL` | The tunnel address from step 2 with `https://`, for example `https://your-name.ngrok-free.app`. No trailing path. |
   | `PORT` | Optional. Defaults to `4020`. |

   `PUBLIC_SERVER_URL` must match the webhook address you put in Twilio exactly, because the Twilio signature is checked against it.

4. Start the server in this folder:

   ```bash
   npm start
   ```

   It prints the webhook address and the Media Stream address. If a variable is missing it stops and names it.

5. Start the tunnel in a second terminal, pointed at the same port:

   ```bash
   ngrok http --url=your-name.ngrok-free.app 4020
   ```

   Check it from a browser: `https://your-name.ngrok-free.app/health` should show `{"ok":true,...}`.

6. Set the number's voice webhook in the Twilio console:
   1. Open console.twilio.com.
   2. Go to Phone Numbers, then Manage, then Active numbers.
   3. Click your number.
   4. On the Configure tab, find Voice Configuration.
   5. Set "A call comes in" to Webhook.
   6. Set the URL to `<PUBLIC_SERVER_URL>/webhooks/twilio/voice`, for example `https://your-name.ngrok-free.app/webhooks/twilio/voice`.
   7. Set the method to HTTP POST.
   8. Click Save configuration.

7. Call the number from your phone. On a trial account, the phone you call from must be a verified caller ID in the Twilio console (Phone Numbers, then Manage, then Verified Caller IDs).

8. Watch the server terminal. Each call ends with a `SUMMARY` line. Copy it into the results table below.

For a local check without Twilio, `SPIKE_SKIP_TWILIO_SIGNATURE=1 npm start` skips the signature check and prints a warning on every request. Never use it with the tunnel open to the internet for longer than a test.

## What to say on the call

1. Pick up and say nothing. Listen for the first line: it should say you are speaking with an AI assistant for Demo Pizza Co. and that this is a test.
2. Ask "What is today's special?" The server log should show `TOOL get_test_fact ok=true`, and the model should say the margherita special.
3. Ask something that gets a longer answer, for example "Tell me about your pizzas." While it is talking, say "Wait, stop." The log should show `BARGE-IN`, and the model's voice should stop almost at once.
4. Hang up. Read the `SUMMARY` line.

## Questions this spike answers

| Question | How to tell | Result |
|---|---|---|
| Does the call connect and the model speak first? | You hear the AI disclosure without saying anything. | |
| Does the tool call work? | `TOOL get_test_fact ok=true` in the log, and the model says the special. | |
| Does barge-in stop speech within about half a second? | The voice stops soon after you start talking. `BARGE-IN` in the log. | |
| Time to first audio | `connect to first audio` and the per-turn numbers in `SUMMARY`. | |
| Does a trial account play an announcement or block unverified callers? | Listen for a trial message before the AI. Try calling from an unverified phone. | |
| Does the model ID in `OPENAI_REALTIME_MODEL` work? | `session.updated` appears in the log with no `OpenAI error`. | |

## Go or no-go

Go if the first three rows pass and time to first audio is under about 2.5 seconds. Otherwise no-go: record what failed, and use the simulated call path (SPEC P-18) as the fallback while it is fixed.

## Not verified without keys

These came from the docs or the Twilio sample, but nothing here has run against a real call. All the wire names are in `src/constants.ts`.

1. The WebSocket URL `wss://api.openai.com/v1/realtime?model=<model>` with only an `Authorization: Bearer` header (no `OpenAI-Beta` header) works for `gpt-realtime-2.1`. A run with a dummy key reached OpenAI and got back `invalid_api_key`, so the URL and the header name are accepted, but the model was not tested.
2. The `session.update` shape: `session.type: "realtime"`, `output_modalities: ["audio"]`, `audio.input.format` and `audio.output.format` set to `{ "type": "audio/pcmu" }`, `audio.input.turn_detection: { "type": "server_vad" }`, `audio.output.voice: "alloy"`, `tools`, `tool_choice: "auto"`. The Twilio sample uses this shape with `gpt-realtime`, not `gpt-realtime-2.1`.
3. That `alloy` is an available voice for `gpt-realtime-2.1`.
4. That `response.create` with no prior user input makes the model speak first. The docs say `response.create` starts a response but do not say it works before any input.
5. That `response.output_audio.delta` carries `item_id` and a base64 `delta`, and that the model's audio is a single content part (`content_index: 0` in the truncate).
6. That function calls arrive as items of type `function_call` with `name`, `arguments` and `call_id` in `response.done`, and that a result sent as `conversation.item.create` with `function_call_output`, then `response.create`, makes the model speak it.
7. The truncate offset. The server sends Twilio a mark after every audio chunk and treats an echoed mark as "played up to here". Twilio's docs say a mark comes back when the audio before it has played, and that marks for dropped audio come back after a `clear`. The code ignores marks it no longer expects after a `clear`. Whether the offset lands close to the word the caller heard is not tested.
8. That OpenAI's server VAD cancels the response on its own when the caller interrupts, so the server only needs to `clear` Twilio and truncate.
9. That Twilio's `media.timestamp` and other numeric fields arrive as strings. The code does not use them.
10. The `X-Twilio-Signature` check uses `twilio.validateRequest` against `PUBLIC_SERVER_URL` plus the path and the form fields. A test with a locally computed signature passed, but not with a real Twilio request. If the tunnel rewrites the host or the protocol, the check fails.
11. The Twilio console menu names in step 6.
12. Trial account behavior: an announcement before the call connects, and calls only from verified numbers (SPEC 4 marks this as a spike).
13. Caller audio that arrives before OpenAI confirms the session is dropped, and its count is in `SUMMARY`. If the count is high, the model may miss the caller's first words.
14. A repeated webhook for the same `CallSid` mints a second token. The real server dedupes on `provider_call_id` (FLOWS section 4).
