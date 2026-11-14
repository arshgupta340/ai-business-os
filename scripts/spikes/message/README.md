# Spike B-04: message channel

This folder answers one question: which channel can send a customer a Square checkout link that arrives intact on a real phone?

SPEC decision D-08 sets the order. Try the channels in this order and stop at the first one that works:

1. `surge`: Surge's shared demo number. Real SMS, no registration, 25 messages for the whole account.
2. `android_gateway`: an Android phone the team owns sends SMS from its own SIM card. Two apps can do this: textbee and SMSGate.
3. `whatsapp_sandbox`: Twilio's WhatsApp sandbox. Each phone must join it first.

The dashboard QR code (`qr_only`) is always the backup. With `qr_only` nothing is sent.

Nothing here has been run against a real provider yet. The code was checked with unit tests and dry runs only.

## 1. One-time setup

You need Node 24.

```bash
cd scripts/spikes/message
npm install
npm test
```

All tests should pass. This folder is its own small project. It is not part of the root workspaces.

### Where the keys go

Put keys in the file `.env.local` at the root of the main checkout (`C:\Users\arshg\AI HACK CALPOLY\.env.local`). The tool looks for `.env.local` in the current folder and then in each parent folder, so it finds that file from here and from any worktree inside the checkout. The first line of every run tells you which file it loaded.

Never commit `.env.local`. Never paste a key into an issue, a pull request or a chat.

You can also pass a value for one run with `--env NAME=value`. A value passed this way wins over `.env.local`.

### Every variable

| Variable | Channel | Required | What it is |
|---|---|---|---|
| `MESSAGE_CHANNEL` | all | yes, unless you pass `--channel` | `surge`, `android_gateway`, `whatsapp_sandbox` or `qr_only` |
| `MESSAGE_TIMEOUT_MS` | all | no, default 15000 | How long to wait for the provider before the result is `UNKNOWN` |
| `SURGE_API_KEY` | surge | yes | Surge dashboard, left sidebar, API Keys |
| `SURGE_ACCOUNT_ID` | surge | yes | Surge dashboard, top of the page, starts with `acct_` |
| `SURGE_LINK_SHORTENING` | surge | no, default `disabled` | `disabled`, `enabled` or `omit` (leave the setting out) |
| `SURGE_BASE_URL` | surge | no, default `https://api.surge.app` | Only change this if Surge tells you to |
| `ANDROID_GATEWAY_KIND` | android_gateway | yes | `textbee` or `smsgate` |
| `ANDROID_GATEWAY_URL` | android_gateway | yes for SMSGate, no for textbee | SMSGate local: `http://<phone IP>:8080`. SMSGate cloud: `https://api.sms-gate.app/3rdparty/v1`. textbee default: `https://api.textbee.dev/api/v1` |
| `ANDROID_GATEWAY_API_KEY` | android_gateway, textbee | yes | textbee dashboard, API key |
| `ANDROID_GATEWAY_DEVICE_ID` | android_gateway | no | Which phone to send from. textbee: the device ID in the dashboard. SMSGate: the device ID, if you have more than one phone |
| `ANDROID_GATEWAY_USERNAME` | android_gateway, smsgate | yes | SMSGate app, Local Server or Cloud Server section |
| `ANDROID_GATEWAY_PASSWORD` | android_gateway, smsgate | yes | SMSGate app, same section |
| `TWILIO_ACCOUNT_SID` | whatsapp_sandbox | yes | Twilio Console home page, starts with `AC` |
| `TWILIO_AUTH_TOKEN` | whatsapp_sandbox | yes | Twilio Console home page, next to the Account SID |
| `TWILIO_WHATSAPP_FROM` | whatsapp_sandbox | yes | `whatsapp:+14155238886`, the sandbox number |

If a variable is missing, the tool stops, names the missing variable and says where to find it. It never prints a key.

### The command

```bash
npm run send -- --channel <channel> --to +15551234567 --url "https://<square sandbox link>"
```

- `--to` is the team phone in E.164 form: a plus sign, the country code, then the number, with no spaces or dashes. A US number looks like `+18055551234`.
- `--url` is the Square sandbox checkout link. Put it in double quotes.
- `--dry-run` prints the exact request (address, headers with keys hidden, body) and sends nothing. Run it first every time.
- `--key <text>` sets the idempotency key yourself. Without it, the key is made from the channel, the number and the link, so running the same command twice gives the same key and the second run is refused.

The message text is the `checkout_link` wording from `docs/FLOWS.md` step B21:

> Demo Pizza Co.: pay for your pickup order here: {url}. Sandbox test payment.

Every real send adds one line to `sends.log.jsonl` in this folder: the time, the channel, the last four digits of the phone, the status and the provider's message ID. Git ignores this file. Do not delete it during the spike: it is what stops a repeat send and what counts Surge messages.

### What the result means

| Status | Meaning | What to do |
|---|---|---|
| `SENT` | The provider accepted the message. It is not proof that the phone got it. | Check the phone. |
| `FAILED` | The provider refused it. Nothing went out. The error code says why. | Fix the cause, then send again with a new `--key`. |
| `UNKNOWN` | A timeout, a network error, a server error or an answer the tool could not read. The message may or may not have gone out. | Check the phone before doing anything else. Do not resend with the same key. If nothing arrived after a few minutes, send again with a new `--key` and note it in the results. |

The tool never retries on its own. This is the project rule: an unknown send goes to review and is not blindly resent.

## 2. Channel 1: Surge

1. Go to surge.app and create an account. A new account gets a shared demo number. No registration is needed.
2. In the dashboard, open API Keys in the left sidebar and create a key. Put it in `SURGE_API_KEY`.
3. Copy the account ID from the top of the dashboard (it starts with `acct_`). Put it in `SURGE_ACCOUNT_ID`.
4. Do not send test messages from the Surge dashboard. The demo number allows 25 outbound messages for the whole account, and the tool can only count the ones it sent itself.
5. Dry run, then send:

```bash
npm run send -- --channel surge --to +1XXXXXXXXXX --url "https://..." --dry-run
npm run send -- --channel surge --to +1XXXXXXXXXX --url "https://..."
```

Before each Surge send the tool prints how many of the 25 messages the log shows as used. It refuses at 25. When Surge itself says the cap is reached, the result is `FAILED` with error code `demo_message_limit`.

The tool sends `settings.link_shortening: "disabled"` so Surge does not rewrite the Square link. If Surge rejects that setting, run again with `--env SURGE_LINK_SHORTENING=omit` and a new `--key`, and write it down.

## 3. Channel 2: Android phone as the sender

You need an Android phone with a working SIM card that can send normal texts, and a plan that allows them. The texts come from that phone's own number.

### Which app to try first

Try **textbee first**, then SMSGate in cloud mode.

Why textbee first: it works through textbee's cloud, so the server can reach the phone from anywhere, including a hosted server on demo day, with no network setup. It has a dashboard that shows the device and its ID, and an official Node package (`@textbee/sdk`) if B-14 wants one later.

SMSGate is the fallback. Its local mode needs the computer and the phone on the same Wi-Fi network, which a hosted server will not be, and campus Wi-Fi often blocks devices from talking to each other. Its cloud mode avoids that, so use cloud mode unless you only want a quick test from a laptop next to the phone.

### Phone settings for either app

- Keep the phone charged, on, with signal, and with the app open during the test.
- Keep the screen on and unlocked during the test. It may work locked, but that has not been tested here, so remove the variable.
- In Android settings, turn off battery optimization for the app, so Android does not stop it in the background.
- Installing an app from outside the Play Store needs you to allow "Install unknown apps" for your browser. Turn it back off afterwards.
- The app will ask for permission to send and read SMS, and probably to post notifications and to use the phone state. Grant them. Without the SMS permission it cannot send. The exact list was not checked.

### 3a. textbee

1. Go to textbee.dev, create an account and verify the email address. textbee says an unverified email blocks sending.
2. In the dashboard, follow the link to download and install the textbee Android app on the phone.
3. Open the app and link it to your account as the dashboard shows (the dashboard gives a QR code or key for this). Grant the permissions.
4. In the dashboard, check that the device shows as online and enabled. Copy its device ID into `ANDROID_GATEWAY_DEVICE_ID`.
5. Create an API key in the dashboard. Put it in `ANDROID_GATEWAY_API_KEY`.
6. Set `ANDROID_GATEWAY_KIND=textbee`. Leave `ANDROID_GATEWAY_URL` unset.
7. Dry run, then send:

```bash
npm run send -- --channel android_gateway --to +1XXXXXXXXXX --url "https://..." --dry-run
npm run send -- --channel android_gateway --to +1XXXXXXXXXX --url "https://..."
```

### 3b. SMSGate (capcom6/android-sms-gateway)

1. Install the SMSGate app ("SMS Gateway for Android") on the phone from the link on docs.sms-gate.app or from the GitHub releases page of github.com/capcom6/android-sms-gateway.
2. Open the app and grant the permissions.
3. Pick a mode:
   - **Cloud mode (recommended).** Turn on Cloud Server in the app. The app shows a username and password once the service starts. Set `ANDROID_GATEWAY_URL=https://api.sms-gate.app/3rdparty/v1`.
   - **Local mode.** Turn on Local Server in the app. The app shows the phone's local address, a username and a password. Set `ANDROID_GATEWAY_URL=http://<phone IP>:8080`. Your computer must be on the same Wi-Fi network as the phone.
4. Put the username in `ANDROID_GATEWAY_USERNAME` and the password in `ANDROID_GATEWAY_PASSWORD`.
5. Set `ANDROID_GATEWAY_KIND=smsgate`.
6. Run the same dry run and send commands as for textbee.

The tool sends the first 36 characters of the idempotency key as SMSGate's message `id`. If SMSGate already has a message with that id, it answers 409 and the tool reports `UNKNOWN` with code `duplicate_id`, because the earlier message probably went out.

## 4. Channel 3: Twilio WhatsApp sandbox

This is WhatsApp, not SMS. Each demo phone needs WhatsApp installed.

1. Sign in to Twilio. Twilio says the sandbox is not in the new Console, so switch to the legacy Console and open Messaging, then Try it out, then Send a WhatsApp message.
2. Activate the sandbox. The page shows the sandbox number `+1 415 523 8886` and your join phrase, which looks like `join <two words>`.
3. **On each demo phone:** open WhatsApp and send the exact join phrase to +1 415 523 8886 (or scan the QR code on that page and send the message it fills in). Wait for the reply that says you joined.
4. Copy the Account SID and Auth Token from the Twilio Console home page into `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
5. Set `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886`.
6. Pass `--to` as the plain number, for example `+18055551234`. The tool adds the `whatsapp:` prefix.
7. Dry run, then send:

```bash
npm run send -- --channel whatsapp_sandbox --to +1XXXXXXXXXX --url "https://..." --dry-run
npm run send -- --channel whatsapp_sandbox --to +1XXXXXXXXXX --url "https://..."
```

**The sandbox does not last.** Twilio says the sandbox session ends three days after a phone joins. Separately, free-form messages are only allowed within 24 hours of the phone's last message to the sandbox. On demo day, have every demo phone send the join phrase again before the demo starts, then run one test send.

If a phone has not joined, Twilio refuses the send and the tool reports `FAILED` with a `twilio_` error code.

## 5. Test procedure

Do this for each channel in order, and stop at the first one that passes.

1. Get a real Square sandbox checkout link from the Square spike (B-02). It looks like a `square.link` address. Use a fresh one.
2. Have the team phone in your hand with the screen on.
3. Run the dry run. Check that the link in the printed body matches the Square link exactly.
4. Run the real send. Note the time the command finished.
5. On the phone, wait for the message. Note how many seconds it took to arrive. Wait at least 2 minutes before calling it not delivered.
6. Check that the link in the message is exactly the Square link: same letters, nothing cut off, no extra characters.
7. Check whether the phone shows the link as tappable. Watch the end of the link: the template puts a full stop right after it. If the phone includes that full stop in the link, the link breaks. Write it down, because the template in `docs/FLOWS.md` would need a change.
8. Tap the link. Check that the Square sandbox checkout page opens and shows the right order.
9. Fill in one row of the results table below.

## 6. Results

| Channel | Delivered (yes or no) | Seconds to arrive | Link intact | Link tappable | Notes |
|---|---|---|---|---|---|
| `surge` | | | | | |
| `android_gateway` (textbee) | | | | | |
| `android_gateway` (SMSGate) | | | | | |
| `whatsapp_sandbox` | | | | | |

## 7. Decision rule

From SPEC D-08: the first channel, in the order above, that delivers the Square link intact to a team phone becomes `MESSAGE_CHANNEL`. If none works, `MESSAGE_CHANNEL` is `qr_only` and the dashboard QR code carries the link. Record the winner when B-04 closes (GAPS G-01 says this is where it gets recorded).

## 8. Not verified without keys

Everything below comes from the providers' documents read on 2026-11-13, or is an assumption. None of it has been tested with a real account.

**Surge**
- Endpoint `POST https://api.surge.app/accounts/{account_id}/messages`, `Authorization: Bearer <key>`, body `{ to, body }`, 201 with `id` and `status`, errors as `{ error: { type, message } }`, demo cap 403 `demo_message_limit` (from docs.surge.app). Not tested.
- That `settings.link_shortening: "disabled"` is accepted on the demo number and stops Surge from rewriting the link.
- That `metadata` is accepted on the demo number.
- Whether a Square link passes carrier filtering from the shared demo number (SPEC section 4 already marks this as a spike question).
- That a message sent from the Surge dashboard counts toward the same 25. The tool's counter only sees messages in `sends.log.jsonl`.
- Surge documents no idempotency key. Only the local log prevents a repeat.

**textbee**
- Endpoint `POST https://api.textbee.dev/api/v1/gateway/send-sms`, header `x-api-key`, body `{ recipients, message, deviceId }`, 200 with `data.success` and `data.smsBatchId` (from textbee.dev docs). Older guides and a third-party listing show a device path `/gateway/devices/{id}/send-sms`; textbee's current reference lists only `/gateway/send-sms`, so that is what the code uses.
- How the app is installed and linked (APK from the dashboard, QR code or key). The exact steps were not checked.
- textbee documents no idempotency field. Only the local log prevents a repeat.
- `SENT` for textbee means the batch was accepted for the phone. It does not mean the phone sent it.

**SMSGate**
- Local path `/message` on port 8080 comes from the local-server guide. The OpenAPI file lists `/messages`. If local mode answers 404, change `SMSGATE_LOCAL_PATH` in `android-gateway.ts` to `/messages`.
- Cloud endpoint `https://api.sms-gate.app/3rdparty/v1/messages`, Basic auth, body `{ id, textMessage: { text }, phoneNumbers }`, 202 with `id` and `state`, 409 on a repeated id (from the OpenAPI file). Not tested.
- That a 36-character slice of the key is accepted as `id`. The OpenAPI file gives only a maximum length of 36.
- `SENT` for SMSGate means the message was queued (`state` Pending). It does not mean the phone sent it.
- The permission list the app asks for.

**Twilio WhatsApp sandbox**
- Basic auth with Account SID and Auth Token on the Messages endpoint. Twilio's general request page says this works; the WhatsApp samples use an API key instead.
- The error body shape `{ code, message, more_info, status }`. The code reads `code` if it is there and falls back to `http_<status>`.
- Whether a trial account adds text to WhatsApp sandbox messages.
- Where the sandbox page sits in the legacy Console today.
- Twilio documents no idempotency parameter for creating a message. Only the local log prevents a repeat.

**All channels**
- The timeout default of 15 seconds is a guess. A slow provider will show `UNKNOWN` even if the message went out.
- A 5xx is treated as `UNKNOWN`, not `FAILED`, because a server error does not prove nothing was sent. For SMSGate's 503 ("Queue limits exceeded; ensure device is online") this is cautious.
- Delivery receipts (`DELIVERED`) are out of scope for this spike. `send()` never returns `DELIVERED`.
- That the full stop right after the link in the FLOWS.md template does not break the link on the phone. Step 7 of the test checks this.

## 9. Files

| File | What it does |
|---|---|
| `adapter.ts` | The `MessageAdapter` interface, statuses and E.164 check. B-14 can lift it as is. |
| `http.ts` | Runs one HTTP request with a timeout and maps the answer to `SENT`, `FAILED` or `UNKNOWN`. Hides keys for printing. |
| `surge.ts`, `android-gateway.ts`, `whatsapp-sandbox.ts` | One adapter per channel. Each file starts with the doc pages that confirmed its request. |
| `channels.ts` | Picks the adapter and holds the message wording. |
| `env.ts` | Finds `.env.local`, loads it and reports missing variables. |
| `send-log.ts` | The send log, the repeat-key guard and the Surge counter. |
| `send.ts` | The command line tool. |
| `test/` | Unit tests with `fetch` mocked. |
