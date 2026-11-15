# Run the demo on a laptop

How to get the demo screen running on any laptop, for example the one we present from. It takes about ten minutes. A coding agent can follow this file from top to bottom.

## What runs where

Only the web app runs on the laptop. Everything else is already running in the cloud and needs nothing from the laptop:

- the server, at `https://abos-server.onrender.com`,
- the database, with the three shops loaded,
- the three phone numbers and their phone agents.

So the laptop needs this repository, Node, one settings file, and a sign-in.

## What you need

1. **Node 22 or newer** and npm. Check with `node --version`.
2. **This repository at `main`.**
3. **The settings file for the web app.** It is not in the repository. Arsh sends it as `web.env.local`. It holds only public values (the server address, the public sign-in keys, the three phone numbers and the demo switch). It holds no password and no secret key.
4. **The owner sign-in** (email and password). Arsh gives it to you directly. Do not write it into any file in this repository.
5. **The six PDFs.** They are in this folder, `docs/demo/`. Arsh also sends them in the same folder as the settings file.

You do not need, and must not ask for, any server secret: no database address, no service role key, no Square, Twilio, OpenAI or AgentPhone key. The laptop never uses them.

## Steps

Run these from the root of the repository.

```bash
git checkout main
```

```bash
git pull
```

```bash
npm ci
```

Copy the settings file Arsh sent to `apps/web/.env.local`. The name must be exactly `.env.local`, inside `apps/web`. Then build and start:

```bash
npm run build -w @abos/web
```

```bash
npm run start -w @abos/web
```

Open `http://localhost:3000`. Use exactly that address: the port must be 3000 and the host must be `localhost`, because the server only accepts requests from that address.

Sign in as the owner. Open **Build an Agent**.

## Check that it works

1. The top right says **Integrations OK**.
2. On Build an Agent, attach `ClassicCutsServices.pdf`, click **Use the suggested prompt**, and send. After about 35 seconds the screen shows **Classic Cuts Barbershop** and the number **(601) 202-0299**.
3. Call that number, book anything, and say yes. The booking appears on the screen. Click **Approve**; it turns green.
4. Click another tab on the left and come back. The number and the booking are still there.

If all four work, the laptop is ready.

## Using it during the demo

- **Which shop:** the name of the attached file decides. Keep the file names as they are. One file per shop is enough.
- **Reset between runs:** press **Integrations OK** in the top right. It puts the app back to the empty Build page and clears Overview, Activity and Approvals on this laptop. It does not delete anything: the data stays in the database. "Start over" on the Build page clears only that page.
- **Call only after the number is on the screen.** An order placed earlier is ignored by the Build page.
- **Approve within 10 minutes.** After that the request expires.
- The script and the three versions of each line are in the demo script Arsh shares; the three shops, files and numbers are in `README.md` in this folder.

## If something is wrong

| What you see | What to do |
|---|---|
| The page loads but every list fails, or sign-in does nothing | The address is not `http://localhost:3000`, or `apps/web/.env.local` is missing. Fix it, then build and start again: the settings are read when the app is built. |
| "Health unknown" or an integration issue in the top right | The server is waking up or a provider is down. Wait a minute and reload. If it stays, tell Arsh. |
| The Build page shows the old chat builder, not "Attach your menu or service list" | `NEXT_PUBLIC_DEMO_SCRIPT=1` is not in `apps/web/.env.local`. Use the file Arsh sent, then build and start again. |
| The number does not show after sending | The attached file name was changed. Use the PDFs as sent. |
| Port 3000 is taken | Stop whatever uses it. Do not start the app on another port. |
| A change was merged after you built | `git pull`, then build and start again. |

## What only Arsh's laptop can do

Clearing the rehearsal data for real (archive, reset, reload the three shops) and removing test bookings from the calendar need the admin database login, which stays on Arsh's laptop. On any other laptop, use the **Integrations OK** reset.
