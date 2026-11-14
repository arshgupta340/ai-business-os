DRAFT

# Demo runbook

**Task:** S-06. **Written:** 2026-11-14. **Describes:** the code on branch `arsh/integration` at commit `18c30a4`.

The integration branch moved three times while this file was being written: 20 commits after `1588eaa`, 21 more after `7486c7e`, and 20 more after `73ac456`. This version was checked against `18c30a4`. If the branch has moved again, check the steps below against the newer code before a rehearsal.

This is a draft script. It is not a record of a demo that happened. No step in it has been rehearsed against the deployed integration server, and every step is marked "Not rehearsed". Where one part of a step was checked against a real service, the step says which part. The complete list of real checks is in `SECURITY_NOTES.md` section 2.

Keep this file marked DRAFT until three full rehearsals have been run and their results written into it (PRD section 17).

Two other files on this branch help with setup. `docs/DEMO-LAPTOP.md` explains how to run the web app on a laptop against the deployed server. `scripts/live/run-demo.ts` drives both demo flows against a running server and the real backend, and prints steps and results without secrets. I did not run it, and I found no recorded result of a run. If it has been run, its results should replace the "Not rehearsed" marks on the steps it covers.

## 1. What must be true before any live segment

These things block the live demo today. Each is a task for a person.

1. Migrations 0005 and 0006 were not applied to the real database when the list of real checks was made. Without 0006 the server on this branch refuses to start. Without 0005 it cannot run an approved order.
2. The integration branch is not deployed. Render serves `main`, which has only the health route and the builder.
3. No phone call has reached the voice worker.
4. No Square sandbox link has been paid, and no webhook has been received.
5. There are no Google credentials. The booking and Sheets segments cannot run, and the pizza agent cannot be published, because publish refuses while Google Sheets is not connected.

Two things about this branch change what the demo can show, even when everything above is done.

- **No message is sent from a call.** The agent does not ask for a phone number. Every order and booking it proposes uses the QR code. The customer pays by scanning the code on the owner's screen. Do not promise a text message.
- **Human fallback is switched off.** A call is never handed to a person on this branch.

If a blocker is still open at demo time, use the fallback written under the step it blocks, and say on stage which part is not live.

## 2. Before the demo

### 2.1 Accounts

**Not rehearsed** as a full checklist. `docs/SETUP-ACCOUNTS.md` has the steps for each account.

| Account | Needed for | State on 2026-11-14 |
|---|---|---|
| Supabase | Database, sign-in, live updates | Verified: migrations 0001 to 0004 applied, seeded, restricted role works |
| OpenAI | Builder model, phone voice model | Verified: realtime probe 11 of 11, one structured-output call, builder interview and test console on the real model |
| Square sandbox | Catalog, quote, payment link, webhook | Verified: catalog seeded, quote matched, link created and read back. Not verified: a paid link, the webhook, a price change |
| Twilio | The phone number and call webhooks | The account sends no SMS from this number (error 30034). A call to the voice worker is not verified |
| Google Cloud service account | Calendar and Sheets | Not created. No credentials yet |
| Render | The server | Verified for `main` only: `/health` returns 200 |
| Vercel | The web app | Not verified for this document |

Bring to the demo: the owner laptop, a caller phone, a second device to pay on, and a phone hotspot in case the venue network blocks long connections.

### 2.2 Variables, by name only

Values live in `.env.local` on the laptop and in the host's variable settings. Never read a value aloud, paste one into a slide, or commit one. Run `npm run check-env` to see which names are set. It never prints a value.

| Where | Variables |
|---|---|
| Server host | `DATABASE_URL` (the restricted `abos_app` login), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `OPENAI_BUILDER_MODEL`, `OPENAI_REALTIME_MODEL`, `SQUARE_ENVIRONMENT` (always `sandbox`), `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `MESSAGE_CHANNEL`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEET_ID`, `PUBLIC_SERVER_URL`, `PORT`, `WEB_ORIGIN`, `NODE_ENV` |
| Laptop only, never on the host | `DATABASE_ADMIN_URL` (the owner connection), `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD` |
| Web app | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MOCK` |

Notes that follow from the code on this branch:

- **Set `MESSAGE_CHANNEL` to `qr_only`.** No message is sent from a call whatever the value. Any other channel has no health check, reads as disconnected, and stops a publish.
- Do not set `BUILDER_DEV_AUTH` on the host.
- The Square signature is checked over `PUBLIC_SERVER_URL` plus `/webhooks/square`. `SQUARE_WEBHOOK_URL` must describe the same address so `npm run check-env` agrees.
- The phone path needs all four of `PUBLIC_SERVER_URL`, `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY` and `DATABASE_URL`. If any one is missing, the phone path is off and the voice webhook answers 503.

### 2.3 Database and seed

1. **Not rehearsed.** Apply migrations 0005 and 0006 from the laptop. Do this before the integration branch is deployed, because the server checks its database role at startup with a routine that 0006 adds.

   ```bash
   npm run migrate -w @abos/db
   ```

   The runner reads `DATABASE_URL`. For this one command that variable must hold the owner connection, not the `abos_app` login. The runner skips files it has recorded in `public.schema_migrations`. I do not know whether 0001 to 0004 were applied with this runner. Look at that table first. If it is empty or missing, do not run the command, because it would try to apply 0001 again. Ask the lead how the first four were applied. If an earlier version of 0005 was applied, the runner stops, because the file changed. Ask the lead before doing anything else.

   If it fails: stop. Do not paste SQL by hand in a hurry. Without both migrations the integration server cannot run. The demo then has only what `main` serves on Render: the builder. Say so.

2. **Not rehearsed** for this document. The real database is already seeded (one owner, two businesses, 33 facts, two agents with published versions, 6 catalog items). Seed again only after a reset or on a new database.

   ```bash
   npm run seed
   ```

   To include the demo price conflict for the builder segment:

   ```bash
   npm run seed -- --with-demo-conflict
   ```

   The seed needs `DATABASE_ADMIN_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

3. **Not rehearsed** for this document. The Square sandbox catalog is already seeded (13 objects). This command writes to the Square sandbox and does not go through the approval engine. Run it only when the lead has decided the catalog must be rewritten.

   ```bash
   npm run seed:square
   ```

### 2.4 The public address

The server's public address is `https://abos-server.onrender.com`. Today it serves `main`.

1. **Not rehearsed.** Get the integration code onto that service. The lead decides how: merge `arsh/integration` into `main`, or point the Render service at the branch. Render replaces the instance on every deploy and closes open phone connections, so do not deploy during a call.
2. **Not rehearsed.** Set every server variable in section 2.2 in Render's Environment page. Set `PUBLIC_SERVER_URL` to the address above with no trailing slash, and `NODE_ENV` to `production`.
3. **Not rehearsed.** Set `WEB_ORIGIN` to the web app's address, or the browser will be refused by CORS.

Fallback if Render cannot be used: run the server on the laptop with `npm run dev:server` behind an ngrok dev domain (`docs/DEPLOY.md` part 1), set `PUBLIC_SERVER_URL` to that address, and register the webhooks again. Not rehearsed.

### 2.5 Webhook registration

Do this once the integration server answers at the public address. Do it again only if the address changes. `PUBLIC_SERVER_URL` in `.env.local` must hold the public address first.

1. **Not rehearsed.** Look at what the command would change. This reads both accounts and changes nothing.

   ```bash
   npm run register-webhooks
   ```

2. **Not rehearsed.** Make the changes.

   ```bash
   npm run register-webhooks -- --apply
   ```

   It points the Twilio number's voice URL and status callback at the server, creates or updates the Square sandbox webhook subscription for `payment.created` and `payment.updated`, and writes `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` into `.env.local`. It prints the Twilio values from before the change, so they can be put back by hand.

3. **Not rehearsed.** Copy `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` from `.env.local` into Render's Environment page and redeploy. The command cannot do this.

The command is tested with fakes only. `docs/DEPLOY.md` says its Square calls were not run against a real account. If it fails, do the same steps by hand in the Square Developer Console and the Twilio Console, as `docs/DEPLOY.md` part 3 describes.

If a signed request is refused with 401 or 403, the address the provider signed is not the address the server is configured with. Fix `PUBLIC_SERVER_URL`. Never turn the signature check off.

### 2.6 Preflight, 30 minutes before

1. **Not rehearsed** on the integration server. Verified on `main`: `/health` returns 200.

   ```bash
   curl "https://abos-server.onrender.com/health?refresh=1"
   ```

   The answer must show `"squareEnvironment":"sandbox"` and `"database":"ok"`.

2. **Not rehearsed.** In the Render shell, check the host's variables.

   ```bash
   npm run check-env -- --for host
   ```

   It exits with an error if `DATABASE_ADMIN_URL` is set on the host.

3. **Not rehearsed** on the integration server. Sign in to the web app as the seeded owner and open Integrations. Ask for a fresh check (the route is `GET /api/integrations/health?businessId=biz_pizza_01&refresh=1`). Every provider the demo needs must say connected, and Square must say sandbox. Google Sheets says connected only when the sheet has tabs named `Orders` and `Bookings`. A provider that is not configured names the missing variable.
4. **Not rehearsed.** Place one short test call. The Render log must show `POST /webhooks/twilio/voice`.
5. **Not rehearsed.** Put one busy event in the demo Google calendar at a time you will ask for in the booking segment.

## 3. Demo script: the pizza order

Say "sandbox" every time payment is on screen. Do not say "text message": no message is sent on this branch.

The screen labels quoted in the tables below come from `docs/FLOWS.md` section 3.5. I did not check them in a browser, so the wording on screen may differ.

| Step | What to do | What should happen | If it fails |
|---|---|---|---|
| P1 | **Not rehearsed.** Sign in as the seeded owner and select Demo Pizza Co. (`biz_pizza_01`). | The Overview screen loads with the sandbox label. | Verified on an earlier head: sign-in and the businesses route returned 200. If the web app cannot reach the server, start it with `NEXT_PUBLIC_MOCK=1` and say the screens are running on fixtures. |
| P2 | **Not rehearsed.** Open Build an Agent and say or type: "I run a pizza shop and want an AI that takes pickup orders." Answer the questions. | The builder asks for what is missing and fills the spec panel. An answer that changes a fact opens a confirmation. | If the microphone fails, type. Typed chat on the real model was run from the UI lead's machine. Browser voice is not verified. |
| P3 | **Not rehearsed.** Upload the demo menu. Resolve the price conflict by keeping the Square price. | A conflict banner appears and clears. | Skip the upload and say so. On this branch uploads are kept in server memory and are lost on a restart. |
| P4 | **Not rehearsed.** Open the preview and run one turn in the test console. | Tool traces are marked mock. Nothing is written. | None needed. The test console on the real model was run from the UI lead's machine. |
| P5 | **Not rehearsed.** Click Publish and confirm. | A new version is written and the agent card shows live. | Publish checks the providers itself. It answers "a provider this agent needs is not reachable" when Twilio, OpenAI, Square, Google Sheets or the message channel is not connected. If Google has no credentials, publish cannot work: say so, and say the phone is answered by the seeded published version of `agt_pizza_01`. Publish, pause and rollback are tested with fakes. None has run on the deployed server. |
| P6 | **Not rehearsed.** Check the top bar says the pizza agent answers the phone. If not, switch the live agent to `agt_pizza_01`. | `PUT /api/live-agent` writes the database and a `live_agent.changed` event. | If the switch fails, stop the phone segment and use the simulated call in P7. |
| P7 | **Not rehearsed.** The second person calls the Twilio number. | The agent says it is an AI assistant for Demo Pizza Co. | If the call does not connect, or there is no audio within a few seconds, hang up and use the simulated call, which is the route `POST /api/agents/agt_pizza_01/sim-call?businessId=biz_pizza_01`. It uses the same real read and propose tools and the same approval. The web code mentions simulated calls on the agent screens. I did not check which screen starts one, so find it before the demo. Say "this is a simulated call". |
| P8 | **Not rehearsed.** The caller orders two large pepperoni pizzas, one with a modifier, and asks the total. | The agent reads a total that came from Square CalculateOrder. | Verified in a spike: a Square sandbox quote matched catalog prices. If the agent says it cannot price the order, Square is not reachable. Stop here. Do not show a made-up total. |
| P9 | **Not rehearsed.** The caller gives a name and a pickup time inside opening hours. | The agent does not ask for a phone number. It says the payment link will be shown at the counter. | If the agent promises a message, note it as a defect. Nothing will be sent. |
| P10 | **Not rehearsed.** The caller confirms the order. | An approval card appears on Approvals with items, total, the QR code route, steps and a 10 minute countdown. The agent says the order is not placed until the shop approves and the customer pays. | If no card appears, open Activity and read the trace. Do not insert a row by hand. |
| P11 | **Not rehearsed.** The owner reads the card and clicks Approve. | The approval becomes approved and the step list starts. If the caller is still on the line, the agent says the shop approved the order. | If the card expired, the order is closed and nothing was sent. Place a new order. A double click is safe. The agent does not hang up on its own goodbye. The caller hangs up. |
| P12 | **Not rehearsed.** Watch step 1, "Creating checkout". | The order shows a link and a QR code on Live operations. | Verified in a spike: a payment link was created on the Square sandbox and read back with the right total. Through the executor it is not verified. If an item in the order has become unavailable in our catalog since the quote, the step fails before Square is called and the order closes as unavailable: place a new order. If the step ends in "Needs your review", the owner can resolve it with `POST /api/executions/:id/resolve` and action `retry`. The server reads Square. If the link exists, the order continues with that same link. If Square cannot say, the request is refused. `POST /api/orders/:id/cancel` cancels an order that has no Square link. An order that already has a link cannot be cancelled by that route, so leave it and place a new order. I did not check whether the web app has buttons for these two routes. Never approve again to force a second link. |
| P13 | **Not rehearsed.** Watch step 2, the message. | The step is skipped. Nothing is sent. | Nothing to fall back to. The customer scans the QR code on the owner's screen. |
| P14 | **Not rehearsed.** On the second device, scan the code and pay with the Square sandbox test card `4111 1111 1111 1111`, CVV `111`, any future expiry. | Square's sandbox page accepts the payment. | Not verified: no sandbox link has been paid. SPEC section 4 warns that links may not be payable in sandbox. The fallback in the SPEC (CreateOrder plus CreatePayment) is not built. If the page will not take the card, stop at "Link sent, not paid (sandbox)" and say that is as far as the live demo goes. |
| P15 | **Not rehearsed.** Wait. | Within about 30 seconds the order turns "Paid (sandbox), verified" and then "Ready to make". | If the webhook does not arrive, the poll reads Square every 30 seconds for 15 minutes after the link was ready. The poll runs even when the webhook is not registered. If the order stays unpaid, leave it unpaid on screen. Never mark it paid by hand. The database would refuse it anyway. |
| P16 | **Not rehearsed.** Open the demo sheet. | One row for the order on the `Orders` tab, and a "Reported to Sheets" tick. | Needs Google credentials, which do not exist yet. Without them the screen shows the report as pending and then failed after 5 tries. The order stays paid. Say the report is pending. |

## 4. Demo script: the barbershop booking

This whole segment needs Google credentials and a shared demo calendar. Without them `read_calendar_availability` answers that it is unavailable and no booking can be proposed. In that case show the booking agent in the mock test console, say "this is the mock preview", and skip steps K3 to K8.

| Step | What to do | What should happen | If it fails |
|---|---|---|---|
| K1 | **Not rehearsed.** Select Demo Barbershop (`biz_barber_01`). Show the same builder with the appointment template. | The spec panel shows the booking tools. | Type instead of speaking. |
| K2 | **Not rehearsed.** Switch the live agent to `agt_barber_01`. | The top bar names the barbershop agent. | If the switch fails, use the simulated call for `agt_barber_01` and label it. |
| K3 | **Not rehearsed.** Call the same number. Ask what services there are. | The agent says it is an AI assistant for Demo Barbershop and lists only seeded services. | Simulated call, as in P7. |
| K4 | **Not rehearsed.** Ask for the time you blocked in the calendar in 2.6 step 5. | The agent says the slot is taken and offers up to three other times. No event is created. | If it offers the blocked time, stop the segment and note it. Google Calendar is not verified. |
| K5 | **Not rehearsed.** Pick a free time and give a name. Confirm. | A booking approval card appears with the service, the local time and time zone, and the customer. The agent does not ask for a number. | If the proposal is refused, pick another time on a quarter hour inside opening hours. |
| K6 | **Not rehearsed.** The owner approves. | The booking shows "Checking the calendar", then "Booked" with a Google event ID. | If the slot was taken since the proposal, the card turns red and no event is created. Propose again. If the booking ends in "Needs your review", use the resolve route as in P12. |
| K7 | **Not rehearsed.** Open Google Calendar. | Exactly one event, with no guests invited. | If there are two events, stop and record it. That would be a defect. |
| K8 | **Not rehearsed.** Check the `Bookings` tab of the sheet. | One row. The confirmation message step is skipped. | A pending sheet row does not undo the booking. Say the report is pending. |

## 5. Optional segments

Use these only if they have been rehearsed.

| Step | What to do | What should happen | If it fails |
|---|---|---|---|
| H1 | **Not rehearsed.** Change the Friday closing time, in Settings or by telling the builder. | A confirm dialog shows before and after. | Use the Settings screen if the chat path does not open a confirmation. |
| H2 | **Not rehearsed.** Confirm. | The fact has a new version and the change log shows it. | If the value changed in between, the confirmation is refused. Propose again. |
| H3 | **Not rehearsed.** Ask about Friday hours on a new call or a new simulated call. | The agent gives the new time. A call that was already in progress keeps the old one. | Use a simulated call. |
| C1 | **Not rehearsed.** Change one item's price through `POST /api/businesses/:id/catalog/prices/propose`, then confirm the approval. | Square's price for the location changes and the catalog cache is refreshed. | No Square price write has run against the real sandbox. Leave this segment out unless a rehearsal has proved it. |

## 6. Reset between runs

1. **Not rehearsed.** Wait for the call to end. Write down the order, approval and booking IDs of the run, and anything that ended in "Needs your review".
2. **Not rehearsed.** From the laptop, with `DATABASE_ADMIN_URL` set in `.env.local`:

   ```bash
   npm run reset -- --yes
   ```

   To bring back the demo price conflict:

   ```bash
   npm run reset -- --yes --with-demo-conflict
   ```

   The command refuses to run without `--yes` or when `SQUARE_ENVIRONMENT` is not `sandbox`. It empties calls, orders, bookings, approvals, executions, dispatches, sync jobs, webhook events, activity events, conflicts, builder sessions, the live agent row, agents and agent versions. It deletes facts that were not seeded and all file rows. It then writes the seeded agents, versions, facts and live agent row again. It prints row counts before and after. It does not empty `payment_receipts`, the table migration 0005 adds. Old receipts stay, which is harmless for a new order with a new payment.

3. **Not rehearsed.** Restart the server on Render. This clears what the server keeps in memory: quotes, stream tokens, uploads, telemetry and the decision replay cache.
4. **Not rehearsed.** Clean up outside our database by hand. The reset does not touch Square sandbox orders and links, Google Calendar events, or Sheets rows. Delete the demo calendar event and put the busy event back. Do not reuse an old payment link.
5. **Not rehearsed.** Run the preflight in section 2.6 again, including the fresh integration check. Check the live agent, because the reset rewrites that row.

## 7. What to say

Use the claim in SPEC section 7 only when the run has earned it: "A business owner can build, publish and monitor agents by conversation. A real phone call ends in a Square sandbox checkout that completes after the owner approves it."

- Do not say the payment is real money.
- Do not say the link went by text message. It did not. Say the customer scans a code.
- If a simulated call replaced the phone, say "simulated call".
- If the screens ran on fixtures, say "fixtures".
- If the phone was answered by a seeded version and not by the one just published, say so.
- If a step stopped before the provider confirmed it, say where it stopped.
- There is no backup video. If one is recorded later, label it with its date and say it is a recording.
