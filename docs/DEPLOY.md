# Deploying the server

**Task:** B-09. **Owner:** Arsh. This guide is for someone who has never deployed a server. Follow the parts in order.

The server is one always-on Node 24 process (Fastify). It serves the REST API, three webhooks (`/webhooks/square`, `/webhooks/twilio/voice`, `/webhooks/twilio/status`) and a WebSocket at `/ws/phone` that carries live phone audio. So the host must:

- give it one stable public HTTPS address that never changes, because Square signs each webhook over the exact URL you registered;
- keep long-lived WebSocket connections open;
- never put the process to sleep, because a sleeping server drops calls and misses webhooks.

Files for deployment:

| File | What it is |
|---|---|
| `apps/server/deploy/Dockerfile` | The server image. Build context is the repo root. |
| `.dockerignore` (repo root) | Keeps `.env*`, `node_modules`, `.git` and the web app out of the image. Docker reads this file only from the root of the build context, so it lives at the repo root, not in `apps/server/deploy/`. |
| `apps/server/deploy/render.yaml` | Render Blueprint. |
| `apps/server/deploy/railway.ts` | Optional Railway Infrastructure as Code file. The dashboard steps below do not need it. |
| `scripts/check-env.mjs` | `npm run check-env`: shows which variables are set and what each feature still needs. It never prints a value. |

Why the build context is the repo root: the server imports `packages/contracts` and `packages/db` through npm workspaces. A build started from `apps/server` cannot see them.

Why there is no build step: the server runs TypeScript directly through `tsx` (`npm run start -w @abos/server`), and the shared packages export TypeScript source.

## Before you start: check your variables

Run this from anywhere inside the repo. It finds `.env.local` by walking up from your current folder.

```bash
npm run check-env
```

Add `--strict` to make it exit with an error when a MUST feature is blocked:

```bash
npm run check-env -- --strict
```

Sample output (from this repo on 2026-11-13, shortened):

```text
Square (sandbox)
  SQUARE_ENVIRONMENT            ok
  SQUARE_ACCESS_TOKEN           MISSING
...
Public address
  PUBLIC_SERVER_URL             MISSING
  PORT                          ok

What works now
  Database:                   works. All its variables are set.
  Square checkout:            blocked. Missing SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID.
  Phone calls:                blocked. Missing PUBLIC_SERVER_URL.
```

"ok" means the value is set and its shape looks right (for example, `TWILIO_PHONE_NUMBER` is in E.164 form like `+18055550100`). It does not prove that a key works.

## Part 1. A tunnel for today

A tunnel gives your laptop a public HTTPS address, so real phone calls and Square webhooks can reach the server before any host exists.

Start the server first, in its own terminal:

```bash
npm run dev:server
```

### Option A. Cloudflare quick tunnel (no account, but the address changes)

Install `cloudflared` (Windows):

```bash
winget install --id Cloudflare.cloudflared
```

Start the tunnel:

```bash
cloudflared tunnel --url http://localhost:4000
```

It prints an address ending in `trycloudflare.com`. That address changes every time you start the tunnel, and it stops working when you stop `cloudflared`. A new address breaks Square's signed URL, so each restart means updating `PUBLIC_SERVER_URL` and `SQUARE_WEBHOOK_URL`, and re-registering the Square and Twilio webhooks (Part 3). Use it only for a quick test. Cloudflare also limits a quick tunnel to 200 requests in flight and gives no uptime guarantee. Its documentation does not say whether WebSockets work through a quick tunnel; test a phone call before relying on it.

### Option B. ngrok with your account's dev domain (the address stays the same)

Every ngrok account, free included, gets one assigned dev domain (for example `your-assigned-name.ngrok-free.app`). It does not change when you restart the agent. Use this one for Square and Twilio.

1. Sign up at ngrok.com and install the agent (Windows):

```bash
winget install --id ngrok.ngrok
```

2. Copy your authtoken from the ngrok dashboard and save it once:

```bash
ngrok config add-authtoken <your-authtoken>
```

3. Start the tunnel. On the free plan, `ngrok http` uses your dev domain automatically:

```bash
ngrok http 4000
```

The dashboard shows your dev domain under Domains. Free plan limits: 20,000 HTTP requests and 1 GB out per month. The free plan shows a warning page in front of browser HTML traffic only; ngrok says it does not affect programmatic clients, but its documentation does not say so for webhooks or WebSockets specifically, so test one call.

### Set the address

Put the tunnel address in `.env.local` at the repo root, with no trailing slash:

```text
PUBLIC_SERVER_URL=https://your-assigned-name.ngrok-free.app
SQUARE_WEBHOOK_URL=https://your-assigned-name.ngrok-free.app/webhooks/square
```

Restart the server so it reads the new values, then register the address (Part 3). When the hosted server exists, change both values to the host address and register again.

## Part 2. A host with a stable address

Pick one host. Do not use a free plan on either: Render's free plan sleeps, and a sleeping server drops calls.

### Variables to set on the host

Set these by name in the host's variable settings. Values come from your `.env.local`, which was filled from `docs/SETUP-ACCOUNTS.md`.

| Variable | Where the value comes from |
|---|---|
| `DATABASE_URL` | Supabase, Connect, session pooler string, with the user changed to the restricted `abos_app` login (D-10). Port 5432, not 6543. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase, Project Settings, API |
| `OPENAI_API_KEY`, `OPENAI_BUILDER_MODEL`, `OPENAI_REALTIME_MODEL` | OpenAI platform, API keys and the models page |
| `SQUARE_ENVIRONMENT` | Always the literal `sandbox` |
| `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` | Square Developer Console, your app, Sandbox tab |
| `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | Part 3, after the address exists |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Twilio Console, Account Info, and Phone Numbers |
| `TELEPHONY_PROVIDER` | `twilio` (the default when unset) or `agentphone` (D-12). See "Switching the telephony provider" below. |
| `AGENTPHONE_API_KEY`, `AGENTPHONE_WEBHOOK_SECRET`, `AGENTPHONE_NUMBER_ID`, `AGENTPHONE_PHONE_NUMBER` | AgentPhone dashboard and `npm run register-webhooks -- --agentphone-only --apply` (docs/SETUP-ACCOUNTS.md 4b) |
| `AGENTPHONE_TURN_ENGINE`, `AGENTPHONE_GREETING`, `AGENTPHONE_GREETING_MODE` | Optional. Defaults: `realtime`, the built-in greeting, `first_reply` (docs/notes-agentphone.md, "The turn engine") |
| `MESSAGE_CHANNEL` and that channel's keys | Spike B-04 result. `qr_only` needs no keys. `surge` needs `SURGE_API_KEY`. `android_gateway` needs `ANDROID_GATEWAY_URL` and `ANDROID_GATEWAY_API_KEY`. `whatsapp_sandbox` needs `TWILIO_WHATSAPP_FROM`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `GOOGLE_SHEET_ID` | Google Cloud service account key, the demo calendar and the demo sheet |
| `PUBLIC_SERVER_URL` | The host's own address, after the first deploy |
| `PORT` | `4000` |

**Never set `DATABASE_ADMIN_URL` on the host.** It is the owner connection, for migrations and the reset script only (D-10). Run migrations from your laptop.

### Railway, step by step

Checked against Railway's documentation on 2026-11-13. Railway's older `railway.json` file is deprecated: new services cannot use it, and it stops working on 2026-12-01. So these steps use the dashboard.

1. Sign in at railway.com with GitHub. Choose New Project, then Deploy from GitHub repo, then `ai-business-os`.
2. Open the new service. In Settings, leave Root Directory empty, so the repo root is the build context.
3. In Variables, add `RAILWAY_DOCKERFILE_PATH` with the value `/apps/server/deploy/Dockerfile`. This tells Railway to build with our Dockerfile instead of detecting a `Dockerfile` at the root.
4. Still in Variables, add every variable in the table above. Railway's Variables tab has a Raw Editor that takes lines in `.env` form, so you can paste the host variables at once (not confirmed in Railway's docs here; add them one by one if it is not there). Leave out `DATABASE_ADMIN_URL` and all `NEXT_PUBLIC_*` lines.
5. In Settings, Deploy: set the start command to `npm run start -w @abos/server` (the Dockerfile already uses it, so this is optional), and set the healthcheck path to `/health`.
6. In Settings, check that Serverless is off. Serverless (formerly App Sleeping) puts an idle service to sleep. Railway's documentation does not say whether it is on by default, so look.
7. In Settings, Networking, Public Networking, choose Generate Domain. If it asks for a port, enter `4000`. You get an address ending in `up.railway.app`, with HTTPS already on.
8. Set `PUBLIC_SERVER_URL` to that address (no trailing slash) in Variables. Railway redeploys when variables change; if it does not, choose Deploy.
9. Optional: under Settings, Watch Paths, add `/apps/server/**` and `/packages/**`, so web-only commits do not redeploy the server.

Railway WebSockets: its specs page says WebSockets over HTTP/1.1 are supported and can stay open indefinitely, even while idle.

If you prefer settings in code: `apps/server/deploy/railway.ts` is a Railway Infrastructure as Code file. Copy it to `.railway/railway.ts`, run `npm install railway`, then `railway config plan` and `railway config apply`. It has not been tested with a real plan run.

### Render, step by step

Checked against Render's documentation on 2026-11-13.

1. Sign in at render.com with GitHub.
2. Choose New, then Blueprint, pick `ai-business-os`, and set Blueprint Path to `apps/server/deploy/render.yaml`. (Render looks for `render.yaml` at the repo root by default.) Render then prompts for each variable marked `sync: false`. Paste the values from your `.env.local`. Leave `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` and `PUBLIC_SERVER_URL` empty for now.

   If you would rather not use the Blueprint: New, Web Service, pick the repo, Language Docker, Root Directory empty, Dockerfile Path `./apps/server/deploy/Dockerfile`, Docker Build Context Directory `.`, then add the variables by hand.

3. Plan: the Blueprint sets `0.5c-512mb`, the smallest paid plan ID in Render's Blueprint spec. Do not pick Free. A free service spins down after 15 minutes without traffic and takes about a minute to wake. Any paid plan stays up. Render's own pricing page was not checked for the price; third-party pages list the smallest paid web service at about 7 US dollars a month.
4. Health check: the Blueprint sets `healthCheckPath: /health`. In the manual path, set Health Check Path to `/health` under Advanced. Render routes traffic to a new deploy only after it passes.
5. Deploy. The address is shown at the top of the service page and ends in `onrender.com`.
6. In Environment, set `PUBLIC_SERVER_URL` to that address (no trailing slash), then Save, rebuild and deploy. Render prompts for `sync: false` values only when the Blueprint is first created, so any variable you add later goes in this Environment page.

Render WebSockets: Render says it sets no maximum duration for a WebSocket connection, but connections close when an instance is replaced, which happens on every deploy. Do not deploy during a live call.

## Part 3. Register the address

Do this once the address exists, and again only if the address changes. Below, `<PUBLIC_SERVER_URL>` means your address, for example `https://abos-server.onrender.com`.

### Square Developer Console

1. Open developer.squareup.com, your application, and switch to Sandbox.
2. Open Webhooks, Subscriptions, and choose Add subscription.
3. Notification URL: `<PUBLIC_SERVER_URL>/webhooks/square`.
4. Events: `payment.created` and `payment.updated`.
5. Save. Open the subscription and copy its Signature Key.
6. On the host (and in `.env.local` if the laptop also receives webhooks):

```text
SQUARE_WEBHOOK_SIGNATURE_KEY=<the signature key>
SQUARE_WEBHOOK_URL=<PUBLIC_SERVER_URL>/webhooks/square
```

`SQUARE_WEBHOOK_URL` must be exactly the URL you registered, character for character. Square signs over that URL plus the body, so a missing `s` in `https` or a trailing slash makes every signature check fail. `npm run check-env` checks that it equals `PUBLIC_SERVER_URL` plus `/webhooks/square`.

7. Redeploy so the server reads the new values.

### Twilio Console

1. Open console.twilio.com, Phone Numbers, Manage, Active numbers, and click your number.
2. Under Voice Configuration, "A call comes in": Webhook, URL `<PUBLIC_SERVER_URL>/webhooks/twilio/voice`, method `HTTP POST`.
3. "Call status changes": URL `<PUBLIC_SERVER_URL>/webhooks/twilio/status`, method `HTTP POST`.
4. Save configuration.

The phone audio WebSocket (`wss://<host>/ws/phone`) is not registered in the console. The voice webhook's TwiML tells Twilio where to connect, and the server should build that address from `PUBLIC_SERVER_URL`.

## Part 4. Verify

1. The server answers:

```bash
curl <PUBLIC_SERVER_URL>/health
```

A healthy answer looks like this (the time differs):

```json
{"ok":true,"service":"abos-server","squareEnvironment":"sandbox","time":"2026-11-13T19:00:00.000Z"}
```

2. The host's variables are complete and the owner connection is absent. Run it in the host's shell (Railway: `railway ssh` from the Railway CLI; Render: the service's Shell tab). Neither shell was checked against the hosts' docs for this guide:

```bash
npm run check-env -- --for host
```

It checks only what the deployed server needs and exits with an error if `DATABASE_ADMIN_URL` is set in the host environment. On your laptop, the same command reads `.env.local` and reports `DATABASE_ADMIN_URL` as "only in .env.local", which is fine.

3. The integrations report:

```bash
curl "<PUBLIC_SERVER_URL>/api/integrations/health?businessId=<business id>&refresh=1"
```

Healthy means every entry has `"state": "connected"` and Square says `"environment": "sandbox"` (docs/API.md section 3.11):

```json
{ "square": { "state": "connected", "environment": "sandbox", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "twilio": { "state": "connected", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "openai": { "state": "connected", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "google_calendar": { "state": "connected", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "google_sheets": { "state": "connected", "lastCheckedAt": "2026-11-13T19:00:00Z" },
  "message_channel": { "state": "connected", "channel": "qr_only", "lastCheckedAt": "2026-11-13T19:00:00Z" } }
```

As of 2026-11-13 this route is not built yet and returns 404. Until it lands, `/health` and a real test call are the checks.

4. Call the Twilio number from a phone. The call should reach the server (the host's logs show `POST /webhooks/twilio/voice`).

## Part 5. The web app on Vercel

1. On vercel.com, New Project, import `ai-business-os`.
2. Set Root Directory to `apps/web`. Vercel detects Next.js.
3. Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL` (set to `PUBLIC_SERVER_URL`) and `NEXT_PUBLIC_MOCK` (`0` for the live backend, `1` for fixtures).
4. Deploy. Saina owns this; the web app needs no other server variable.
5. If the browser blocks API calls, the server must allow the Vercel address as a CORS origin (see "What must change in the server" below).

## What can go wrong

- **The server sleeps.** A Render free service spins down after 15 minutes idle and takes about a minute to wake; Railway's Serverless setting does the same. Calls drop and webhooks are missed. Use a paid plan and keep Serverless off.
- **The tunnel address changed.** A Cloudflare quick tunnel gets a new address on every start. Square signatures then fail and Twilio calls go nowhere. Use the ngrok dev domain or the host, and re-register (Part 3) after any change.
- **A proxy blocks the WebSocket.** The phone audio needs `wss://` to `/ws/phone`. Some venue and campus networks, corporate proxies and VPNs block or cut long-lived connections. On a hosted server this is rarely a problem, because Twilio connects to the host directly. With a tunnel, the laptop's own network carries the audio, so a blocking network breaks calls. Use a phone hotspot, or the hosted server.
- **TLS to the database.** Connect to Supabase with TLS and keep certificate checks on. If the server logs a certificate error such as "self-signed certificate in certificate chain", download the CA certificate from Supabase's database settings and give it to the Postgres driver. Do not turn verification off. This was not tested here.
- **The owner connection is on the host by mistake.** If `DATABASE_ADMIN_URL` is set on the host, one wrong line of code or a swapped value connects the server as the table owner, which can bypass the D-10 guards. `npm run check-env -- --for host` fails when it is set. Remove it from the host's variables.
- **`SQUARE_ENVIRONMENT` is not `sandbox`.** The server refuses to start (AC-19). The deploy shows as failed and `/health` never answers.
- **The first deploy fails to build.** The Dockerfile was not built on the machine that wrote it (Docker was not installed). Its install and start steps were run by hand outside Docker and the server answered `/health`. On the first deploy, read the build log for `npm ci` errors and confirm the start log shows the server listening on port 4000.

## What must change in the server for deployment to work

These are application code changes, not part of B-09. They are listed so the owning task picks them up.

- **Twilio signature check uses the public URL.** Behind a host's proxy the request arrives as `http://` on an internal host, so `twilio.validateRequest` must use `PUBLIC_SERVER_URL` plus the path, not the request's own host and protocol.
- **Graceful shutdown.** `apps/server/src/index.ts` has no `SIGTERM` handler. Hosts send `SIGTERM` before replacing an instance (Render allows 30 seconds). The server should call `app.close()` so in-flight webhooks finish.
- **CORS** for the Vercel address, if the web app calls the server from the browser.
- **`/api/integrations/health`** is not built yet.

## Switching the telephony provider (D-12)

`TELEPHONY_PROVIDER` picks who answers calls. Only one answers at a time, and the server never falls back from one to the other.

- **`twilio` (default).** Unchanged: `/webhooks/twilio/voice` and `/ws/phone` answer calls through the Realtime relay. `/webhooks/agentphone` answers 503 and reads nothing.
- **`agentphone`.** `/webhooks/agentphone` answers each caller turn with our agent and the same read and propose tools. With `AGENTPHONE_TURN_ENGINE=realtime` (the default) each call gets one OpenAI Realtime session in text mode, which needs `OPENAI_API_KEY`; with `builder` each turn runs the sim-call runner, which also needs `OPENAI_BUILDER_MODEL` (docs/notes-agentphone.md, "The turn engine"). `/webhooks/twilio/voice` answers 503. If an AgentPhone variable is missing, `/webhooks/agentphone` also answers 503, and the phone-line entry in integration health says `telephony provider agentphone: missing ...`. While `AGENTPHONE_WEBHOOK_SECRET` is empty the route answers 503 and reads nothing.

Before either AgentPhone setting (`TELEPHONY_PROVIDER=agentphone` or `MESSAGE_CHANNEL=agentphone`) is turned on, apply migration `0007_agentphone_channel.sql`. Run `npm run migrate -w @abos/db` with `DATABASE_URL` set to the owner (admin) database connection, not the runtime role's connection. Migration 0007 lets the database accept the `agentphone` value: it widens the channel check on message dispatches and the source check on webhook events, and lets an order or booking approval name `agentphone` as its message channel. If it is skipped, every AgentPhone webhook insert fails a check constraint. With `MESSAGE_CHANNEL=agentphone`, every `propose_order` and `propose_booking` also fails, so Twilio calls break too.

### Switch the phone line to AgentPhone on Render, in order

1. Apply migration 0007 as described above. Do this first.
2. Attach the live agent to the AgentPhone number. The `live_agent` table has one row per number, and a call resolves the agent from the row for the number it dialed. Today the only row is for the Twilio number. Run this once in the Supabase SQL editor, with both numbers in E.164 form. It copies the Twilio row, so the AgentPhone number answers with the same agent and the same published version, and it is safe to run again:
   ```sql
   insert into public.live_agent (phone_number, business_id, agent_id, agent_version_id)
   select '<AGENTPHONE_PHONE_NUMBER>', business_id, agent_id, agent_version_id
   from public.live_agent where phone_number = '<TWILIO_PHONE_NUMBER>'
   on conflict (phone_number) do update set business_id = excluded.business_id, agent_id = excluded.agent_id,
     agent_version_id = excluded.agent_version_id, updated_at = now();
   ```
   Other ways to get the same row: publish the pizza agent again from the dashboard after step 4 (publish binds the live agent to the selected provider's number), or run `npm run seed` with `TELEPHONY_PROVIDER=agentphone` and `AGENTPHONE_PHONE_NUMBER` set, which upserts the seeded pizza agent on both numbers. No migration is needed.
3. In Render, Environment, set: `AGENTPHONE_API_KEY`, `AGENTPHONE_NUMBER_ID`, `AGENTPHONE_PHONE_NUMBER`. Leave `AGENTPHONE_TURN_ENGINE` unset (it means `realtime`) and leave `AGENTPHONE_GREETING_MODE` unset (it means `first_reply`: the server speaks the greeting). `OPENAI_API_KEY` must already be set. Optional: `AGENTPHONE_GREETING` (it must contain "AI assistant").
4. Register from a laptop whose `.env.local` has `AGENTPHONE_API_KEY`, `AGENTPHONE_NUMBER_ID` and `PUBLIC_SERVER_URL` (the Render address): first `npm run register-webhooks -- --agentphone-only` to see the changes, then the same with `--apply`. It sets the project webhook to `<PUBLIC_SERVER_URL>/webhooks/agentphone` with a 10 second timeout, then sets the agent to `voiceMode` `webhook`, the short greeting as `beginMessage`, `interruptionSensitivity` 0.3 (`AGENTPHONE_INTERRUPTION_SENSITIVITY` overrides it) and `enableBackchannel` off. Setting the webhook rotates its signing secret.
5. In Render set `AGENTPHONE_WEBHOOK_SECRET` to the secret for that webhook: the one the script wrote to `.env.local`, or, if it printed that AgentPhone returned none, the one in the AgentPhone dashboard. Then set `TELEPHONY_PROVIDER=agentphone` and save, which redeploys.
6. Check `GET /api/integrations/health?refresh=1`: the phone-line entry should say `agentphone number readable`. The server log shows `agentphone: voice turn engine` with `engine: realtime`.
7. Call the AgentPhone number. Expect the greeting with the AI disclosure, then answers within about a second. After you say yes to the read-back you hear the closing line and the call ends; the order is in the dashboard as a pending approval.

To switch back to Twilio: in Render set `TELEPHONY_PROVIDER=twilio` (or remove it) and save. The Twilio row in `live_agent` was never changed, and the Twilio console settings were never touched, so nothing needs re-registering. To keep AgentPhone but use the old turn runner, set `AGENTPHONE_TURN_ENGINE=builder` (it needs `OPENAI_BUILDER_MODEL`).

Texting is separate: apply migration 0007 first (see above), then `MESSAGE_CHANNEL=agentphone` sends the approved checkout or booking message through AgentPhone with either telephony provider, once AgentPhone's 10DLC registration is approved. Its delivery status is read from AgentPhone's message history every minute; there is no receipt webhook. Integration health shows the message channel as connected only when AgentPhone reports outbound SMS `enabled` on the number; until then publish refuses an agent that sends messages.

## Registering the webhooks with one command

Once `PUBLIC_SERVER_URL` in `.env.local` holds the public address (tunnel or host), one command does the Square and Twilio steps of Part 3 for you. First look at what it would change. This is a dry run: it reads both accounts and changes nothing.

```bash
npm run register-webhooks
```

Then make the changes:

```bash
npm run register-webhooks -- --apply
```

What `--apply` changes:

- **Twilio.** On the number in `TWILIO_PHONE_NUMBER`, the voice URL becomes `<PUBLIC_SERVER_URL>/webhooks/twilio/voice` (POST) and the status callback becomes `<PUBLIC_SERVER_URL>/webhooks/twilio/status` (POST). Nothing else on the number changes.
- **Square sandbox.** If a subscription already points at `<PUBLIC_SERVER_URL>/webhooks/square`, its events are set to `payment.created` and `payment.updated` and it is enabled. Otherwise it creates one named "AI Business OS sandbox" with those events. It refuses to run unless `SQUARE_ENVIRONMENT` is `sandbox`.
- **`.env.local`.** It writes `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL`, replacing those two lines and leaving every other line as it was. The signature key is never printed.

Other options: `--twilio-only`, `--square-only`, `--agentphone-only` (D-12; only AgentPhone: the project webhook and the agent's voice settings, see above; `--business "Name"` sets the business name in the greeting), and `--base <url>` to use an address other than `PUBLIC_SERVER_URL`. The address must be `https`, must not be localhost and must have no path.

**Undo the Twilio change.** The output shows each value before and after, and after `--apply` it prints the previous voice URL and status callback. To go back, enter those values on the number in the Twilio Console (Phone Numbers, Manage, Active numbers).

**Then add the two Square values on the host.** Copy `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_URL` from `.env.local` into the host's environment settings and redeploy. The command cannot set them on the host for you.

The Square subscription calls follow the installed SDK and were not run against a real account when this was written. If the command says Square did not return the signature key, copy it from the Developer Console (Sandbox, Webhooks, Subscriptions) as in Part 3.
