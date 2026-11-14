DRAFT

# Demo runbook

**Task:** S-06. **Updated:** 2026-11-14. **Describes:** the code on `main` at commit `4f1bed8`, merged into branch `arsh/S-06-docs`.

This is a draft script. It is not a record of a demo that happened. No rehearsal by a person is recorded for any step in it, so every step is marked "Not rehearsed". Where a script has verified part of a step against real services, the step says which part and where. The complete list of real checks is in `SECURITY_NOTES.md` section 2.

Keep this file marked DRAFT until three full rehearsals have been run by people and their results written into it (PRD section 17).

## 1. What the demo can claim today

A script (`scripts/live/run-demo.ts`) has driven these against real services. The list of real checks names the script for the pizza run. The local checks match its other flows, and this runbook assumes it made them too. No run by a person at the web screens is recorded.

- On the deployed server: a pizza order from a simulated call, the owner's approval, one Square sandbox payment link, a SIMULATED sandbox payment, the verified paid state, and the row in the Orders tab of the demo sheet.
- On a local server against the same real backend: a barbershop booking with a real Google Calendar event and a Bookings row, an opening-hours edit, and the refusals (a second approval, a wrong payload hash, a rejected order).

These have not been verified with any real service. Each one has a fallback in the script below.

| Not verified | What the demo does about it |
|---|---|
| A real phone call through Twilio to the voice worker | Try the call. If it fails, use a simulated call and say "simulated call". |
| Paying on Square's hosted checkout page with a test card | Try it on a second device. If the page will not take the card, use the SIMULATED sandbox payment and say "simulated sandbox payment". |
| The web app against the deployed server | Check it in the preflight. If it does not work, run the scripted flow in a terminal, or show the screens on fixtures and say "fixtures". |
| The booking flow on the deployed server | It passed on a local server. Rehearse it on the deployed server before showing it. |
| Any customer message | None is sent. The demo shows the QR code. |

Three rules for the whole demo.

- **Show the QR code. Never promise a text message.** The agent does not ask for a phone number, and every order and booking it proposes uses the QR code. The customer pays by scanning the code on the owner's screen.
- **Say "sandbox" every time payment is on screen.** No real money moves.
- **Human fallback is switched off.** A call is never handed to a person.

## 2. Before the demo

### 2.1 Accounts

**Not rehearsed** as a full checklist. `docs/SETUP-ACCOUNTS.md` has the steps for each account.

| Account | Needed for | State on 2026-11-14 |
|---|---|---|
| Supabase | Database, sign-in, live updates | Verified: migrations 0001 to 0006 applied, and the restricted role is refused the writes listed in `SECURITY_NOTES.md` section 2. Live updates to the browser are not verified |
| OpenAI | Builder model, phone voice model | Verified: realtime probe 11 of 11 on `gpt-realtime-2.1`, and the builder interview and the test console on the real model |
| Square sandbox | Catalog, quote, payment link, webhook | Verified: quote, one payment link, a SIMULATED payment, two webhook events stored. Not verified: the hosted checkout page, a declined card, a price change |
| Twilio | The phone number and call webhooks | The account is a full account, not a trial. The voice and status webhooks are registered at the Render address. SMS from this number fails with error 30034. A call to the voice worker is not verified |
| Google Cloud service account | Calendar and Sheets | Verified: one Calendar event, one Orders row and one Bookings row. Integration health reports both connected |
| Render | The server | Verified: the full server is deployed from `main` on a paid instance, and the smoke check passed 9 of 9 |
| Vercel | The web app | Not verified. This runbook runs the web app on the laptop |

Bring to the demo: the owner laptop, a caller phone, a second device to pay on, and a phone hotspot in case the venue network blocks long connections.

### 2.2 Variables, by name only

Values live in `.env.local` on the laptop and in the host's variable settings. Never read a value aloud, paste one into a slide, or commit one. Run `npm run check-env` to see which names are set. It never prints a value.

| Where | Variables |
|---|---|
| Server host | `DATABASE_URL` (the restricted `abos_app` login), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `OPENAI_BUILDER_MODEL`, `OPENAI_REALTIME_MODEL`, `SQUARE_ENVIRONMENT` (always `sandbox`), `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `MESSAGE_CHANNEL`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEET_ID`, `PUBLIC_SERVER_URL`, `PORT`, `WEB_ORIGIN`, `NODE_ENV` |
| Laptop only, never on the host | `DATABASE_ADMIN_URL` (the owner connection), `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` |
| Web app | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MOCK` |

Notes that follow from the code on `main`:

- **Keep `MESSAGE_CHANNEL` set to `qr_only`.** No message is sent from a call whatever the value. Any other channel has no health check and reads as disconnected, and so does an unset `MESSAGE_CHANNEL`. Either one stops the publish of an agent with a message capability, and both seeded agents have one. Do not set it to `agentphone`: the server on `main` does not accept that value and will not start.
- Do not set `BUILDER_DEV_AUTH` on the host.
- The Square signature is checked over `PUBLIC_SERVER_URL` plus `/webhooks/square`. `SQUARE_WEBHOOK_URL` must describe the same address so `npm run check-env` agrees.
- The phone path needs all four of `PUBLIC_SERVER_URL`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY` and `DATABASE_URL`. If any one is missing, the phone path is off and the voice webhook answers 503.
- `OPENAI_API_KEY` needs `OPENAI_BUILDER_MODEL` beside it. With the key set and the model missing, the server does not start.
- The server accepts `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `SQUARE_WEBHOOK_URL` but its code does not use them. The seed, `npm run check-env` and the live script read them on the laptop.
- `npm run check-env` does not report on `WEB_ORIGIN`, `NODE_ENV`, `SEED_OWNER_EMAIL` or `SEED_OWNER_PASSWORD`. Check those by hand.

### 2.3 Database and seed

The real database has migrations 0001 to 0006. There is nothing to apply before the demo.

1. **Not rehearsed.** Seed again only after a reset or on a new database. The live runs used the seeded owner, both seeded businesses and both seeded agents, so the seed is in place today.

   ```bash
   npm run seed
   ```

   To include the demo price conflict for the builder segment:

   ```bash
   npm run seed -- --with-demo-conflict
   ```

   The seed needs `DATABASE_ADMIN_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. It reads `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` for the owner login. It writes the live agent row only when `TWILIO_PHONE_NUMBER` is set on the laptop.

   The same command then seeds the Square sandbox catalog (step 2). When `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID` are both unset it skips that step and prints a line saying so. When either is set it refuses before writing anything unless `SQUARE_ENVIRONMENT` is `sandbox` and both are set.

2. **Not rehearsed.** `npm run seed` runs this step too when the Square keys are set. The command below runs only this step. It writes the demo catalog to the Square sandbox and does not go through the approval engine. It sends no upsert when the catalog already matches the menu. The catalog is already there: the live run quoted from it. Run the seed with the Square keys set only when the lead has decided the catalog may be rewritten. It needs `SQUARE_ENVIRONMENT` set to `sandbox`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` and `DATABASE_ADMIN_URL`, and it also rewrites the pizza rows of our `catalog_items` cache.

   ```bash
   npm run seed:square
   ```

### 2.4 The public address

The server's public address is `https://abos-server.onrender.com`. It serves the full server from `main`.

1. **Not rehearsed.** Do not deploy during the demo. Render replaces the instance on every deploy and closes open phone connections. The Blueprint in `apps/server/deploy/render.yaml` asks Render to deploy on every commit. I did not check whether the live service uses that setting, so agree that nobody merges to `main` while the demo runs.
2. **Not rehearsed.** Check `WEB_ORIGIN` in Render's Environment page. It must equal the address the web app is served from, or the browser is refused by CORS. With the web app on the laptop that address is `http://localhost:3000`. I did not check the value set on Render.

Fallback if Render cannot be used: run the server on the laptop with `npm run dev:server` behind an ngrok dev domain (`docs/DEPLOY.md` part 1), set `PUBLIC_SERVER_URL` to that address, and register the webhooks again (section 2.5). Not rehearsed. A phone call or a webhook through a tunnel is not verified.

### 2.5 Webhook registration

The Twilio voice and status webhooks, and a Square sandbox subscription for `payment.created` and `payment.updated`, are registered at the Render address. There is nothing to do unless the address changes.

If the address changes, `PUBLIC_SERVER_URL` in `.env.local` must hold the new address first.

1. **Not rehearsed.** Look at what the command would change. This reads both accounts and changes nothing.

   ```bash
   npm run register-webhooks
   ```

2. **Not rehearsed.** Make the changes.

   ```bash
   npm run register-webhooks -- --apply
   ```

   It points the Twilio number's voice URL and status callback at the server, creates or updates the Square sandbox webhook subscription, and writes `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` into `.env.local`. It prints the Twilio values from before the change, so they can be put back by hand. The Twilio change runs first and has no sandbox check. The Square change refuses unless `SQUARE_ENVIRONMENT` is `sandbox`.

3. **Not rehearsed.** Copy `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` from `.env.local` into Render's Environment page and redeploy. The command cannot do this.

The command is tested with fakes. The list of real checks does not say whether the current registration was made with it or in the provider consoles. If it fails, do the same steps by hand in the Square Developer Console and the Twilio Console, as `docs/DEPLOY.md` part 3 describes.

If a signed request is refused with 401 or 403, the address the provider signed is not the address the server is configured with. Fix `PUBLIC_SERVER_URL`. Never turn the signature check off.

### 2.6 The web app on the laptop

**Not rehearsed.** The web app run against the deployed server is not verified.

`docs/DEMO-LAPTOP.md` has the steps: copy `apps/web/.env.example` to `apps/web/.env.local`, set `NEXT_PUBLIC_API_URL` to the server address, set the two Supabase values, set `NEXT_PUBLIC_MOCK` to `0`, and start it on port 3000.

```bash
npm run dev -w @abos/web
```

That guide also lists what the screen shows after sign-in when the business list fails to load, and what each of those states means. It says the first run against the deployed server should be treated as a test.

### 2.7 Preflight, 30 minutes before

1. **Not rehearsed** by a person. Verified by the smoke check: the deployed server's health route answers.

   ```bash
   curl "https://abos-server.onrender.com/health?refresh=1"
   ```

   The answer must show `"squareEnvironment":"sandbox"` and `"database":"ok"`. Read the `database` field: the route answers 200 even when the database is unreachable.

2. **Not rehearsed.** Run the integration health check from the laptop. It signs in as the seeded owner and asks the server for a fresh check of every provider.

   ```bash
   npx tsx scripts/live/run-demo.ts health --base https://abos-server.onrender.com
   ```

   The result line lists each provider's state. Every provider must say connected. The word PASS on that line means only that Square reports sandbox, so read the states. Verified on 2026-11-14: integration health on the deployed server reported all six connected. I do not know whether this command or another client was used for that check.

3. **Not rehearsed.** In the Render shell, check the host's variables.

   ```bash
   npm run check-env -- --for host
   ```

   It exits with an error if `DATABASE_ADMIN_URL` is set on the host.

4. **Not rehearsed.** Sign in to the web app as the seeded owner. The business selector must list both businesses with no error banner. Walk the sidebar once: Overview, Build an Agent, My Agents, Activity, Approvals, Business Knowledge, Integrations, Settings. On Integrations, check that every provider says connected and Square says sandbox. If the screens do not load, decide now whether the demo uses the scripted flow (section 6) or fixtures.
5. **Not rehearsed.** Place one short test call to the Twilio number. The Render log must show `POST /webhooks/twilio/voice`. If the call does not connect, plan to use the simulated call.
6. **Not rehearsed.** Make one test order, and on a second device see whether Square's hosted page for its payment link accepts the test card. If it does not, plan to use the SIMULATED payment.
7. **Not rehearsed.** Put one busy event in the demo Google calendar at a time you will ask for in the booking segment.

## 3. Demo script: the pizza order

The screen names, buttons and state labels quoted below are read from the web code (`apps/web/components/shell/nav.ts`, `apps/web/lib/status.ts` and the screen components). No check of them in a browser against the deployed server is recorded.

| Step | What to do | What should happen | If it fails |
|---|---|---|---|
| P1 | **Not rehearsed.** Sign in as the seeded owner and select Demo Pizza Co. (`biz_pizza_01`). | The Overview screen loads under the banner "Sandbox. Payments are test data. No real money moves." | Verified by script on the deployed server: sign-in and the businesses route work. The web screen is not verified. If the web app cannot reach the server, start it with `NEXT_PUBLIC_MOCK=1` and say the screens are running on fixtures. |
| P2 | **Not rehearsed.** Open Build an Agent and say or type: "I run a pizza shop and want an AI that takes pickup orders." Answer the questions. | The builder asks for what is missing and fills the spec panel. An answer that changes a fact opens a confirmation. One confirmation opens per turn. | If the microphone fails, type. Verified: the builder interview ran on the real model. Browser voice is not verified. |
| P3 | **Not rehearsed.** On Business Knowledge, upload the demo menu. Resolve the price conflict by keeping the Square price. | A conflict appears and clears. Keeping the current value needs no approval, because nothing external is written. | Skip the upload and say so. Uploads and the conflicts found in them are kept in server memory and are lost on a restart. The seeded demo conflict (section 2.3) is stored in the database and can be resolved the same way. That path is tested with fakes and was merged after the live checks. |
| P4 | **Not rehearsed.** Open My Agents, the pizza agent, then "Preview and test". In the card "Talk to the agent", choose "Test with mock tools" and run one turn. | Tool traces are marked mock. Nothing is written. | Verified: the test console ran on the real model. |
| P5 | **Not rehearsed.** Click Publish and confirm. | A new version is written and the agent card shows live. | Publish checks the providers itself and refuses when one the agent needs is not connected. Publish, pause and rollback are tested with fakes. None is verified on the deployed server. If publish fails, say so, and say the phone is answered by the seeded published version of `agt_pizza_01`. |
| P6 | **Not rehearsed.** On My Agents, check the pizza agent shows "Answers the phone number". If not, open the agent and switch the number to it on its phone number card (`agt_pizza_01`). | `PUT /api/live-agent` writes the database and a `live_agent.changed` event. | Verified by script: the live agent route answers on the deployed server. The switch itself is not verified. If it fails, stop the phone segment and use the simulated call in P7. |
| P7 | **Not rehearsed.** The second person calls the Twilio number. | The agent says it is an AI assistant for Demo Pizza Co. | A real call is not verified. If the call does not connect, or there is no audio within a few seconds, hang up and use the simulated call: My Agents, the pizza agent, "Preview and test", then "Simulated call" in the card "Talk to the agent". The choice is offered only while the agent is live with an active version. It uses the same real read and propose tools and the same approval. Verified by script on the deployed server: a simulated call on the real model. Say "this is a simulated call". |
| P8 | **Not rehearsed.** The caller orders one large Margherita pizza for pickup and asks the total. | The agent reads a total that came from Square CalculateOrder. | Verified by script on the deployed server, for this exact order: one large Margherita. Other orders are not verified live. If the agent says it cannot price the order, Square is not reachable. Stop here. Do not show a made-up total. |
| P9 | **Not rehearsed.** The caller gives a name and a pickup time inside opening hours. | The agent does not ask for a phone number and promises no message. The customer is told to ask at the counter for the payment link. | If the agent promises a message, note it as a defect. Nothing will be sent. |
| P10 | **Not rehearsed.** The caller confirms the order. | The order appears on Approvals with its items and total, and Approve and Reject buttons. The approval expires 10 minutes after it was created. The agent says the order is not placed until the shop approves and the customer pays. | Verified by script: the proposal and its pending approval. The card on screen is not verified. If no card appears, open Activity and read the trace. Do not insert a row by hand. |
| P11 | **Not rehearsed.** The owner reads the request and clicks Approve, within 90 seconds of the caller confirming. | The approval becomes approved and the steps start. If the caller is still on the line, the agent says the shop approved the order, that the payment link is at the counter, and that nothing is paid yet. The caller then hangs up. | Verified by script: the approval returned in under a second. If the owner takes longer than 90 seconds, the agent says goodbye and the call ends. The owner can still approve after that. If the request expired, the order is closed and nothing was sent. Place a new order. A double click is safe: verified on a local server, a second approval makes no second link. |
| P12 | **Not rehearsed.** Open Activity (the page is titled "Live operations") and select the call. | The order moves through "Creating checkout" to "Not paid yet (sandbox)". The "Checkout link" panel shows the QR code with the caption "Sandbox test payment only". The Approvals screen has no QR code. | Verified by script on the deployed server: one Square sandbox payment link, and the order reached `PAYMENT_PENDING`. The QR code on screen is not verified. If an item has become unavailable in our catalog since the quote, the step fails before Square is called and the order closes as unavailable: place a new order. If the order shows "Needs your review", leave it and place a new one. No web screen has a button for the recovery routes. Never approve again to force a second link. |
| P13 | **Not rehearsed.** Look at the message step. | The step shows "Skipped". Nothing is sent. | Nothing to fall back to. The customer scans the QR code on the owner's screen. |
| P14 | **Not rehearsed.** Hold the QR code up to the second device's camera and pay with the Square sandbox test card `4111 1111 1111 1111`, CVV `111`, any future expiry. | Square's sandbox page accepts the payment. | Not verified: paying on Square's hosted checkout page. If the page will not take the card, use the SIMULATED payment in section 6 with this order's ID, and say "this is a simulated sandbox payment, with no card form and no real money". Verified by script on the deployed server: the SIMULATED payment completes. |
| P15 | **Not rehearsed.** Wait. | The order turns "Paid (sandbox), verified" and then "Paid (sandbox), ready to make". The QR code panel goes away. | Verified by script with the SIMULATED payment: about 4 seconds from payment to one receipt, `PAID_VERIFIED` and `FULFILLMENT_READY`. If the webhook does not arrive, the poll reads Square every 30 seconds for 15 minutes after the link was ready. If the order stays unpaid, leave it unpaid on screen. Never mark it paid by hand. The database would refuse it anyway. |
| P16 | **Not rehearsed.** Open the demo sheet. | One row for the order on the `Orders` tab. On Activity the step "Report to Google Sheets" shows "Report written". | Verified by script: the row was read back from the Orders tab. If the row is missing, the report retries up to 5 times and the order stays paid. Say the report is pending. |

## 4. Demo script: the barbershop booking

This segment passed by script on a local server against the real backend. It is not verified on the deployed server. Rehearse it there before showing it. If it fails on the day, show the booking agent in the mock test console, say "this is the mock preview", and skip steps K3 to K8.

| Step | What to do | What should happen | If it fails |
|---|---|---|---|
| K1 | **Not rehearsed.** Select Demo Barbershop (`biz_barber_01`). Show the same builder with the appointment template. | The spec panel shows the booking tools. | Type instead of speaking. |
| K2 | **Not rehearsed.** Open the barbershop agent under My Agents and switch the phone number to it (`agt_barber_01`). | The agent shows "Answers the phone number". | If the switch fails, use the simulated call for `agt_barber_01` and label it. |
| K3 | **Not rehearsed.** Call the same number. Ask what services there are. | The agent says it is an AI assistant for Demo Barbershop and lists only seeded services. | Simulated call, as in P7. |
| K4 | **Not rehearsed.** Ask for the time you blocked in the calendar in the preflight. | The agent says the slot is taken and offers up to three other times. No event is created. | Not verified against Google Calendar: the scripted booking asked for a free time. If the agent offers the blocked time, stop the segment and note it. |
| K5 | **Not rehearsed.** Pick a free time and give a name. Confirm. | A booking approval card appears with the service, the local time and time zone, and the customer. The agent does not ask for a number. | If the proposal is refused, pick another time on a quarter hour inside opening hours. |
| K6 | **Not rehearsed.** The owner approves. | The booking shows "Checking the calendar", then "Booked, verified". | Verified by script on a local server: a haircut booking reached `BOOKED_VERIFIED`. If the slot was taken since the proposal, the booking shows "Slot taken" and no event is created. Propose again. If the booking shows "Needs your review", leave it and book another time. The recovery route cannot resolve a Calendar step today. |
| K7 | **Not rehearsed.** Open Google Calendar. | Exactly one event, with no guests invited. | Verified by script on a local server: the event was read back at the approved time. If there are two events, stop and record it. That would be a defect. |
| K8 | **Not rehearsed.** Check the `Bookings` tab of the sheet. | One row. The confirmation message step is skipped. | Verified by script on a local server: the row. A pending sheet row does not undo the booking. Say the report is pending. |

## 5. Optional segments

Use these only if they have been rehearsed.

| Step | What to do | What should happen | If it fails |
|---|---|---|---|
| H1 | **Not rehearsed.** Change the Saturday closing time, in Settings or by telling the builder. | A confirmation shows before and after, with "Confirm change" and "Discard change". | Use the Settings screen if the chat path does not open a confirmation. |
| H2 | **Not rehearsed.** Confirm. | The fact has a new version and the change log shows it. | Verified by script on a local server, through the API: a Saturday hours fact moved to a new version. If the value changed in between, the confirmation is refused. Propose again. |
| H3 | **Not rehearsed.** Ask about Saturday hours on a new call or a new simulated call. | The agent gives the new time. A call that was already in progress keeps the old one. | Not verified live. Use a simulated call. |
| C1 | **Not rehearsed.** Change one item's price on the Prices screen, then confirm the approval. | Square's price for the location changes and the catalog cache is refreshed. | No Square price write has run against the real sandbox. Leave this segment out unless a rehearsal has proved it. |

## 6. The scripted flow, as a fallback

`scripts/live/run-demo.ts` drives the server over HTTP as the seeded owner and prints each step and its result. It prints no secret. It needs `.env.local` on the laptop with the Supabase values, `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`, `DATABASE_URL`, the Square sandbox values and the Google values.

This is the one end-to-end path that is verified against real services. It is still **not rehearsed** by a person as a stage segment. If it is shown, say that a script is driving the server, that the call is a simulated call, and that the payment is a simulated sandbox payment.

1. **Not rehearsed** on stage. Verified on the deployed server on 2026-11-14. A pizza order from a simulated call through to paid, with a SIMULATED sandbox payment:

   ```bash
   npx tsx scripts/live/run-demo.ts pizza,pay --base https://abos-server.onrender.com
   ```

2. **Not rehearsed.** Only the SIMULATED payment, for an order made at the web screens (step P14). The order must already have its payment link.

   ```bash
   npx tsx scripts/live/run-demo.ts pay --order <order id> --base https://abos-server.onrender.com
   ```

   The `pay` flow writes to the Square sandbox directly: it opens the Square order with UpdateOrder and pays it with Square's sandbox test nonce. It stands in for the customer. It refuses to run unless `SQUARE_ENVIRONMENT` is `sandbox`. I have not run it with `--order`. That option is in the script and was not part of the verified run.

3. **Not rehearsed.** Not verified on the deployed server. The booking, the hours edit and the refusals passed on a local server:

   ```bash
   npx tsx scripts/live/run-demo.ts booking,hours,negative --base https://abos-server.onrender.com
   ```

   The `negative` flow re-approves a pizza order from the same run or from `--order`. Without one of those, that one check reports a failure.

## 7. Reset between runs

1. **Not rehearsed.** Wait for the call to end. Write down the order, approval and booking IDs of the run, and anything that ended in "Needs your review".
2. **Not rehearsed.** From the laptop, with `DATABASE_ADMIN_URL` set in `.env.local`:

   ```bash
   npm run reset -- --yes
   ```

   To bring back the demo price conflict:

   ```bash
   npm run reset -- --yes --with-demo-conflict
   ```

   The command refuses to run without `--yes` or unless `SQUARE_ENVIRONMENT` is set to `sandbox`. It empties calls, orders, bookings, approvals, executions, dispatches, sync jobs, webhook events, activity events, conflicts, builder sessions, the live agent row, agents and agent versions. It deletes facts that were not seeded and all file rows. It then writes the seeded businesses, agents, versions and facts again. It writes the live agent row again only when `TWILIO_PHONE_NUMBER` is set on the laptop, and that row points at the pizza agent. It prints row counts before and after. It leaves users, the catalog cache and `payment_receipts` as they were. Old receipts stay, which is harmless for a new order with a new payment.

3. **Not rehearsed.** Restart the server on Render. This clears what the server keeps in memory: quotes, stream tokens, uploads, telemetry and the decision replay cache.
4. **Not rehearsed.** Clean up outside our database by hand. The reset does not touch Square sandbox orders and links, Google Calendar events, or Sheets rows. Delete the demo calendar event and put the busy event back. Do not reuse an old payment link.
5. **Not rehearsed.** Run the preflight in section 2.7 again, including the fresh integration check. Check the live agent, because the reset rewrites that row and points it at the pizza agent.

## 8. What to say

Use the claim in SPEC section 7 only when the run has earned it: "A business owner can build, publish and monitor agents by conversation. A real phone call ends in a Square sandbox checkout that completes after the owner approves it." Today the second sentence has not been earned: no real phone call has been verified, and the only completed checkout was paid by a simulated sandbox payment.

- Do not say the payment is real money.
- Do not say the link went by text message. It did not. Say the customer scans a code.
- If a simulated call replaced the phone, say "simulated call".
- If the script made the payment, say "simulated sandbox payment".
- If the screens ran on fixtures, say "fixtures".
- If the phone was answered by a seeded version and not by the one just published, say so.
- If a step stopped before the provider confirmed it, say where it stopped.
- There is no backup video. If one is recorded later, label it with its date and say it is a recording.
