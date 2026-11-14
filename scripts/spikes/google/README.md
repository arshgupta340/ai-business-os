# Spike B-05: Google Calendar and Sheets with one service account

This folder proves that one Google service account can read free/busy, create and delete a calendar event without duplicates, and append a reporting row without duplicates. It follows proposal P-15 in `docs/SPEC.md`: one service account, with the demo calendar and the demo sheet shared to it.

It is its own npm project. It is not part of the root workspaces. Nothing here runs in the app.

## What you need

- Node 24 or newer.
- A Google account. Use a personal Gmail account if you can. A school or work account may block service account keys (see "Not verified without keys").

## Set up, step by step

1. **Create a Google Cloud project.** Go to https://console.cloud.google.com. Click the project picker at the top of the page, then **New project**. Name it, for example `ai-business-os-demo`, and click **Create**. Make sure the new project is selected in the project picker before you go on.

2. **Turn on the two APIs.** In the left menu open **APIs & Services**, then **Library**. Search for **Google Calendar API**, open it and click **Enable**. Go back to the Library, search for **Google Sheets API**, open it and click **Enable**.

3. **Create a service account.** In the left menu open **IAM & Admin**, then **Service Accounts**. Click **Create service account**. Give it a name such as `spike-bot` and click **Create and continue**. Skip the optional role and user access steps: the account needs no project roles, because it gets access by being shared on the calendar and the sheet. Click **Done**.

4. **Create and download a JSON key.** On the Service Accounts page, click the account you just made. Open the **Keys** tab. Click **Add key**, then **Create new key**, choose **JSON**, and click **Create**. A `.json` file downloads. This file is a password. Keep it out of chat, issues and commits. Move it somewhere outside the repo, for example `C:\Users\<you>\keys\spike-bot-service-account.json`.

5. **Copy the service account's email address.** It is shown on the Service Accounts page and in the key file as `client_email`. It looks like `spike-bot@ai-business-os-demo.iam.gserviceaccount.com`. You will share the calendar and the sheet with this address. After step 9 you can also print it with `npm run whoami`.

6. **Create the demo calendar and share it.**
   1. Open https://calendar.google.com with your own account.
   2. In the left column, next to **Other calendars**, click **+**, then **Create new calendar**. Name it `Demo Barbershop` and click **Create calendar**.
   3. In the left column under **My calendars**, hover over `Demo Barbershop`, click the three dots, then **Settings and sharing**.
   4. Scroll to **Share with specific people or groups**. Click **Add people and groups**, paste the service account's email, set the permission to **Make changes to events**, and click **Send**.
   5. On the same settings page, scroll to **Integrate calendar**. Copy the **Calendar ID**. It ends in `@group.calendar.google.com`. This is `GOOGLE_CALENDAR_ID`.

7. **Create the demo sheet and share it.**
   1. Open https://sheets.new to create a blank spreadsheet. Name it `Demo reporting`.
   2. Click the **Share** button at the top right. Paste the service account's email, set the role to **Editor**, untick **Notify people**, and click **Share** (Google may ask you to confirm sharing outside your organization; confirm it).
   3. Copy the sheet ID from the address bar. In `https://docs.google.com/spreadsheets/d/1AbC...xyz/edit#gid=0` the ID is the part between `/d/` and `/edit`. This is `GOOGLE_SHEET_ID`.
   4. Leave the first tab empty. The spike writes a header row there if the tab is empty.

8. **Install the spike's packages.** In this folder run:

   ```
   cd scripts/spikes/google
   npm install
   ```

9. **Set the three variables.** Put them in `.env.local` at the main checkout root (`C:\Users\arshg\AI HACK CALPOLY\.env.local`). The scripts look for `.env.local` in the current folder and then in every folder above it, so the root file is found from here and from any worktree. `.env.local` is in `.gitignore`. Never commit it.

   `GOOGLE_SERVICE_ACCOUNT_JSON` takes either a path to the key file or the key file's JSON text. A path is simpler:

   ```
   GOOGLE_SERVICE_ACCOUNT_JSON=C:/Users/<you>/keys/spike-bot-service-account.json
   GOOGLE_CALENDAR_ID=abc123@group.calendar.google.com
   GOOGLE_SHEET_ID=1AbC...xyz
   ```

   To paste the JSON instead (this is what a host's secret store will hold), wrap it in **single quotes**. Do not use double quotes: the first `"` inside the JSON would end the value, and the scripts will tell you so.

   ```
   GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"..."}'
   ```

   A relative path is read from the folder that holds `.env.local`. Escaped `\n` in `private_key` are turned into real line breaks. A variable that is already set in your shell wins over the file.

10. **Check the key.** Run `npm run whoami`. It prints the service account's email and asks Google for an access token. The key is never printed.

11. **Run the whole check.** Run `npm run roundtrip`. It prints one PASS or FAIL line per step and ends with `ALL PASS` or the number that failed. Copy the output into the results table below.

If a variable is missing, every script stops at once and names the variable, for example:

```
Config error: Missing environment variable: GOOGLE_SHEET_ID. Loaded C:\Users\arshg\AI HACK CALPOLY\.env.local, but it does not set them.
```

## Commands

| Command | What it does |
|---|---|
| `npm run whoami` | Prints the service account email and checks that Google accepts the key. |
| `npm run freebusy` | Prints the busy blocks on the demo calendar for the next 7 days, in `America/Los_Angeles`. |
| `npm run slots` | Prints up to 5 free start times for the demo service, using live free/busy. |
| `npm run slots -- --offline` | Same, with no keys and an empty calendar. |
| `npm run create-event` | Books the first free slot for booking ID `bkg_spike_manual`. Options: `--booking`, `--start` (ISO time), `--minutes`. |
| `npm run delete-event` | Deletes the event for `bkg_spike_manual`. Option: `--booking`. |
| `npm run append-row` | Appends record `spike_row_manual` to the first sheet, or skips it if column A already has it. Option: `--record`. |
| `npm run roundtrip` | Runs every check below in order. |
| `npm test` | Unit tests for the slot finder and the key parsing. No keys needed. |
| `npm run typecheck` | TypeScript check. |

`create-event` exits with code 2 when it stops on `SLOT_CONFLICT`.

### What `roundtrip` does

1. **whoami**: gets an access token for the service account.
2. **freebusy**: reads 7 days of free/busy and picks the first free demo slot.
3. **create-event**: books that slot for a new booking ID. Expects `CREATED`.
4. **create-event again, same booking ID**: expects `EXISTING` with the same event ID, so no second event.
5. **create-event, same slot, different booking ID**: expects `SLOT_CONFLICT` and no event. It waits 3 seconds first so free/busy can see the new event.
6. **delete-event**: deletes the event and confirms the lookup no longer finds it.
7. **append-row**: appends a new record ID. Expects `APPENDED`.
8. **append-row again, same record ID**: expects `SKIPPED`, then counts the record ID in column A and expects exactly 1.

Calendar events are always cleaned up, even when a step fails. The test row stays in the sheet as evidence; delete it by hand when you are done.

## Questions this spike answers

| Question | Roundtrip step | Result |
|---|---|---|
| Does the service account read free/busy on the shared calendar? | 2 | |
| Can it create an event and then delete it? | 3, 6 | |
| Does the booking ID lookup stop a duplicate event on retry? | 4 | |
| Does the free/busy recheck catch a conflict on the same slot? | 5 | |
| Does the row append, and stay single when the same record is retried? | 7, 8 | |

## How the booking rule is built

The rule comes from `docs/PRD.md` section 9 and step C8 in `docs/FLOWS.md`. `src/calendar.ts` `createBookingEvent` does three things in order:

1. **Look up first.** `events.list` with `privateExtendedProperty=bookingId=<bkg_ id>`. If an event is found, return it. A retry never creates a second event.
2. **Recheck the slot.** `freebusy.query` for exactly the slot. If any busy block overlaps it, return `SLOT_CONFLICT` and insert nothing.
3. **Insert once.** `events.insert` with `sendUpdates=none`, no attendees, `transparency=opaque`, and the booking ID in `extendedProperties.private.bookingId`.

FLOWS step C8 asked this spike to settle the metadata field and the lookup method. The answer this code uses is `extendedProperties.private` and the `privateExtendedProperty` filter on `events.list`. That is unproven until `roundtrip` step 4 passes.

The Sheets rule in `src/sheets.ts` `appendRowOnce` reads column A of the first tab, skips if the record ID is there, writes the header if the tab is empty, then appends with `valueInputOption=RAW` and `insertDataOption=INSERT_ROWS`. `RAW` stores caller text as plain text, so a value that starts with `=` is never run as a formula.

## The slot finder (for task B-19)

`src/slots.ts` `findFreeSlots` is pure: no network, no clock. The caller passes `now`, the business hours per weekday (keys `mon` to `sun`, as in SPEC 2.9), the service duration, the buffer, the minimum notice, the grid (default 15 minutes), the busy blocks and an optional window (default 7 days). It returns at most 5 slots (default), each with the UTC start and end, the local start and end with offset, and the time zone.

A start is kept only if the service ends within business hours, the service plus the buffer overlaps no busy block, and the start is at least the minimum notice after `now`. Candidates sit on the local clock grid (9:00, 9:15, and so on). Time zone math uses `Intl` only, in `src/time.ts`, so it adds no dependency. The tests cover a week across the fall change (2026-11-01) and the spring change (2026-03-08) and the night the clocks change.

Choices made here that B-19 may want to revisit:
- The buffer is added after the service only, matching FLOWS step C3. Busy blocks from the calendar carry no buffer before them.
- The inserted event covers the service only, not the buffer.
- Business hours that cross midnight are rejected.

## Scopes and why

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/calendar.events` | List, insert and delete events. It cannot read or change calendar settings or sharing, unlike the full `calendar` scope. |
| `https://www.googleapis.com/auth/calendar.freebusy` | Free/busy only. `freebusy.query` does not accept `calendar.events`, so it needs its own scope. |
| `https://www.googleapis.com/auth/spreadsheets` | Read column A and append values. The narrower `drive.file` only covers files the app created or that a user opened with it, so it would not reach a sheet a person shared to the service account. |

The scopes limit what the token may do. The sharing in steps 6 and 7 limits which calendar and which sheet it can touch: the service account sees nothing that was not shared with it.

## Packages

- `@googleapis/calendar` 20.2.0 and `@googleapis/sheets` 18.1.3: the official per-API packages. They carry the same generated types as the full `googleapis` package but install only the two APIs we use, so the install is much smaller.
- `google-auth-library` 11.3.4: the `JWT` client that signs in as the service account.
- Dev only: `typescript` 5.9, `tsx`, `vitest` 5.1, `@types/node` 24.

Method and field names were checked against the packages' TypeScript types and the Google API reference pages for `freebusy.query` and extended properties.

## Not verified without keys

No Google call has been made. Each item below is an assumption until `roundtrip` passes.

1. A service account can read free/busy on a calendar shared to it with "Make changes to events", and `freebusy.query` accepts the `calendar.freebusy` scope for it.
2. `events.list` with `privateExtendedProperty=bookingId=<id>` finds an event the same account just inserted, with no delay. If it lags, a fast retry could create a duplicate. Step 4 tests this.
3. A new event shows as busy in `freebusy.query` within 3 seconds. Step 5 tests this. If it fails, the local slot lock in SPEC 2.9 (`bookings_no_overlap`) still protects real bookings, but the external recheck is weaker than planned.
4. `events.list` hides deleted events by default (`showDeleted=false`), so a deleted booking is not found again. Step 6 tests this.
5. `sendUpdates=none` with no attendees sends no email to anyone. Not observable from the script; check the owner's inbox once.
6. A service account cannot add attendees without domain-wide delegation. We never add attendees, so this only matters if a later task wants invites.
7. The `calendar.events` scope is enough for `events.list`, `insert` and `delete` on a shared calendar. The narrower `calendar.events.owned` was not chosen because the service account does not own the calendar.
8. The service account can read and append to a sheet shared to it as Editor with the `spreadsheets` scope.
9. Reading column A with `values.get` on `'<first tab>'!A:A` returns every record ID. The dedupe check reads the whole column each time, which is fine for a demo but slow for a very large sheet.
10. A school or work Google account may block service account key creation through the organization policy `iam.disableServiceAccountKeyCreation`. A personal account does not have this policy.
11. The read then append in `appendRowOnce` is not atomic. Two workers appending the same record ID at the same moment could both append. Production relies on one sync job per record (FLOWS step C11) to avoid that.
12. The Calendar API reference says repeating `privateExtendedProperty` matches events that satisfy all constraints, while the extended properties guide says any. This code uses one constraint, so it is not affected.
