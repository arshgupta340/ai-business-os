# Hour-Zero Account Setup

**Owner:** Arsh. **Task:** B-01. **Why first:** every integration spike waits on these keys.

These steps need a person. Signups, email and phone verification, card entry and copying secret keys are done by Arsh, not by a Claude session. A Claude session can tell you which screen to open and can check afterwards that a key works.

## Rules for secrets

- Put values in `.env.local` at the repo root and in the host's secret settings. Never commit them. `.gitignore` already excludes `.env*` except `.env.example`.
- Never paste a secret into a GitHub issue, a pull request, a commit message or a doc.
- Saina needs only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `NEXT_PUBLIC_API_URL`. Send them to her directly, not through the repo.
- `SQUARE_ENVIRONMENT` must be `sandbox`. The server refuses to start otherwise.

## Order of work

Do 1 to 4 first. They unblock spikes B-02 and B-03, which are the go or no-go gate.

### 1. Supabase (free tier)
- Create a project.
- Copy: project URL, anon key, service role key, and the database connection string. Use the session connection, not the transaction pooler, because the job queue needs it.
- Create the one owner user in Auth.
- Variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, and the two `NEXT_PUBLIC_SUPABASE_*` copies.

### 2. OpenAI API
- Create an API key and add prepaid credit.
- Confirm on the models page that the key can use the Realtime API, and note the exact current model IDs for the realtime voice model and for the text model used by the builder.
- Variables: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_BUILDER_MODEL`.
- Cost note: a per-minute price for Realtime audio could not be confirmed from the docs. Watch usage after the first few test calls and set a spending limit.

### 3. Square developer account (free)
- Create a developer account and a sandbox application.
- Copy the sandbox access token.
- Find the sandbox location ID (the ListLocations call, or the sandbox seller dashboard).
- Webhook subscription comes later, once the server has a public URL (task B-09): subscribe to payment events, then copy the signature key. The notification URL you register must be exactly the URL the server receives on.
- Variables: `SQUARE_ENVIRONMENT=sandbox`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, later `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL`.

### 4. Twilio
- Create an account and get one US phone number with voice.
- Decision P-17: upgrade the account (about 20 US dollars) so callers do not hear the trial announcement and unverified phones can call. If you stay on trial, verify every phone that will call in the demo.
- Variables: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.

### 4b. AgentPhone (D-12, optional, to compare with Twilio)
Everything below follows AgentPhone's own documentation (`docs/notes-agentphone.md`); none of it has been tried yet.
1. Sign up at agentphone.ai. The API key is expected to start with `sk_live_` (not confirmed in the vendor's documentation) and is shown once: put it in `.env.local` as `AGENTPHONE_API_KEY` straight away.
2. Buy one US number in the dashboard (or `POST /v1/numbers` with `country: "US"`). About 3 dollars a month; new accounts get 5 dollars of credit. Put its ID (`num_...`) in `AGENTPHONE_NUMBER_ID` and the number in E.164 form in `AGENTPHONE_PHONE_NUMBER`.
3. Create an agent and attach the number. Set its voice mode to **webhook**, not hosted: in hosted mode AgentPhone's own model answers and our tools and approvals are skipped. Leave any per-agent webhook empty, because it would override the project webhook.
4. Set the project webhook to `<PUBLIC_SERVER_URL>/webhooks/agentphone`: run `npm run register-webhooks -- --agentphone-only` (dry run), then add `--apply`. AgentPhone makes a new secret every time the webhook is set; the script writes it to `.env.local` as `AGENTPHONE_WEBHOOK_SECRET` without printing it. Copy it to the host.
5. Texting (optional, `MESSAGE_CHANNEL=agentphone`): outbound SMS to US numbers needs A2P 10DLC registration, which AgentPhone files for you but you fill in: business details, use case, sample messages, the opt-in flow and a public image of it. Sole proprietor (no EIN) or standard brand costs 25 dollars, high volume 70. There is no stated review time, so do not plan the demo on it. Calls and inbound texts work before approval. Health shows the number's `outboundSms` state.
6. Optional, the MCP server for Claude Code (from https://docs.agentphone.ai/mcp.md): `claude mcp add --transport http agentphone https://mcp.agentphone.ai/mcp` and sign in in the browser. For a local client, the docs run `npx -y agentphone-mcp` with `AGENTPHONE_API_KEY` in that client's own config. Never paste the key into a file in this repo. Its tools can buy numbers and send messages, so use it for setup only, never for a customer message.
- Variables: `TELEPHONY_PROVIDER`, `AGENTPHONE_API_KEY`, `AGENTPHONE_WEBHOOK_SECRET`, `AGENTPHONE_NUMBER_ID`, `AGENTPHONE_PHONE_NUMBER`.

### 5. Message channel (spike B-04)
Try in this order and stop at the first that delivers a Square sandbox link to a team phone.
1. **Surge:** create an account, send one test message containing a Square sandbox link from the shared demo number. The cap is 25 outbound messages for the whole account, so do not spend them on tests that do not need a real send.
2. **Android phone as sender:** only if one of you has an Android phone with a US SIM. Install textbee or SMSGate, and send a test from the server over HTTP.
3. **Twilio WhatsApp sandbox:** each demo phone texts the join code to the sandbox number once. The window lasts 24 hours, so rejoin on demo day.
4. **QR only:** nothing to set up. The dashboard always shows the QR code.
- Variables: `MESSAGE_CHANNEL` and that channel's keys.

### 6. Google Cloud (needed for the barbershop agent and the Sheets mirror, both MUST)
- Create a project. Enable the Calendar API and the Sheets API.
- Create a service account and download its JSON key.
- Create a demo calendar and a demo sheet. Share both with the service account's email address, with edit rights.
- Variables: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEET_ID`.

### 7. Hosting
- **Server:** Railway or Render. One always-on Node service. Live by hour 6 (task B-09). Its URL becomes `PUBLIC_SERVER_URL` and the webhook target for Square and Twilio.
- **Web:** Vercel, connected to the repo, root `apps/web`. Saina can own this.
- **Local voice debugging:** a tunnel with a reserved domain, so the address does not change between runs.

## Done when

- [ ] `.env.local` holds every variable in `.env.example` that the MUST tier needs.
- [ ] One Square sandbox API call succeeds with the token.
- [ ] One call to the Twilio number reaches a test webhook.
- [ ] One OpenAI API call succeeds with the key.
- [ ] Saina has the three public values she needs.
- [ ] Nothing secret is in git: `git status` shows no `.env` file staged.

## Things to have physically at the demo

- A phone to place the call.
- A second device to open the checkout link and pay with the Square test card `4111 1111 1111 1111`, CVV `111`, any future expiry.
- A phone hotspot in case the venue network blocks something.
