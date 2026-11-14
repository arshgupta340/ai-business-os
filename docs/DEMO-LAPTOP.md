# Run the web app on a laptop against the deployed server

The server is at `https://abos-server.onrender.com`. The integration branch is merged (#97), and the server code on `main` registers every route the web app calls (see `docs/notes-web-real-mode.md`). An earlier version of this guide said the server serves only `/health` and the builder routes. That described the server before the merge. Which commit the deployed server runs was not checked when this guide was updated on 2026-11-14, so do the checks in section 6 before a demo.

The web app has not yet been run against the deployed server with a real sign-in. Treat the first run as a test.

## 1. Install

From the repo root:

```bash
npm install
```

## 2. The env file

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in these names. Never commit `.env.local`, and never paste its values into a chat, an issue or a pull request.

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://abos-server.onrender.com` (no trailing slash) |
| `NEXT_PUBLIC_SUPABASE_URL` | The project URL from the Supabase dashboard |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon (public) key from the Supabase dashboard |
| `NEXT_PUBLIC_MOCK` | `0`, or delete the line. `1` runs on fixtures and never calls the server. |

All four are public values that end up in the browser. No server secret belongs in this file.

## 3. Start the web app

```bash
npm run dev -w @abos/web
```

Open `http://localhost:3000`. The web app must run on port 3000: the server's CORS allows one origin, `WEB_ORIGIN`, which defaults to `http://localhost:3000` (`apps/server/src/app.ts`). On any other port the browser refuses every call to the server. If the dev server prints any other address, stop whatever holds port 3000 and start it again. The only other way is to set `WEB_ORIGIN` on Render to the address you use. The value set on Render was not checked.

The values are read when the dev server starts. After you change `.env.local`, stop it and start it again.

For a production build instead of the dev server:

```bash
npm run build -w @abos/web
npm run start -w @abos/web
```

`NEXT_PUBLIC_*` values are baked in at build time, so rebuild after any change.

Fallback with no server at all: `npm run dev:mock -w @abos/web` on macOS or Linux. On Windows the script's inline variable does not work in `cmd`; set `NEXT_PUBLIC_MOCK=1` in `.env.local` and run `npm run dev -w @abos/web`.

## 4. Sign in

1. Open `http://localhost:3000/sign-in`.
2. Email: `owner@demo.test`. The password is in the owner's own notes. It is not written in this repo.
3. The account must exist in Supabase Auth and be linked to a row in `public.users` (`auth_user_id`), and that user must own the seeded businesses. Without the link the server answers `UNAUTHENTICATED` and the app returns to sign-in.

If sign-in shows "Sign-in is not configured", one of the two Supabase values is missing.

After sign-in the app asks the server for the owner's businesses and shows only what the server returns. It no longer falls back to the two seeded names. Until the answer arrives the page shows "Loading your businesses". After that:

| What you see | What it means |
|---|---|
| The business selector lists the businesses and the screen loads | The server returned them. |
| "Your businesses did not load" with a retry | `GET /api/businesses` failed. The message under the title is the server's. A call that never reaches the server reads "Could not reach the server. Check the connection and try again." A call the browser blocks for CORS (wrong port) is expected to read the same; that was not tried in a browser. |
| "This account has no business yet" | The server answered with an empty list: the signed-in user owns no business in the database. |
| "No business you can open" | The server listed businesses and then refused each one with `FORBIDDEN_BUSINESS`. |
| Back on the sign-in page with "Your session ended" | The server answered `UNAUTHENTICATED`: the token was refused, or the user has no `public.users` row. |

## 5. What each screen needs from the server

Every call carries the Supabase access token. Business-scoped calls also need the signed-in owner to own the selected business, or the server answers `FORBIDDEN_BUSINESS`.

| Screen | Routes it calls | Also needs on the server |
|---|---|---|
| Top bar (business selector, approvals badge, health dot) | `GET /api/businesses`, `GET /api/approvals`, `GET /api/integrations/health` | Businesses in the database owned by the signed-in owner |
| Overview | agents, live agent, approvals, orders, bookings, calls, activity, integrations health | `TWILIO_PHONE_NUMBER` for the live agent card |
| Build | `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST .../messages`, `POST /api/agents`, `GET /api/approvals/:id` | `SUPABASE_URL` set, so the server can verify the token (without it the builder answers `INTEGRATION_UNAVAILABLE` "Sign-in is not configured on this server."); OpenAI key for real builder replies |
| Build voice | `POST /api/realtime/client-secret` | OpenAI key; a microphone; the browser calls OpenAI directly with the short-lived secret |
| Agents, agent detail | `GET /api/agents`, `GET /api/agents/:id`, `GET /api/live-agent`, `PUT /api/live-agent`, `POST .../pause`, `GET /api/calls` | `TWILIO_PHONE_NUMBER` |
| Preview, test console, publish | `POST .../preview`, `POST .../test`, `POST .../sim-call`, `POST .../publish` | A live agent for simulated calls; Square sandbox for publish checks |
| Versions | `GET .../versions`, `POST .../rollback`, `GET /api/activity` | None beyond auth |
| Approvals | `GET /api/approvals`, `GET /api/approvals/:id`, `POST .../decision`, `GET /api/orders/:id`, `GET /api/bookings/:id`, catalog, integrations health | The approval engine and executor |
| Activity (live operations, call detail) | calls, orders, bookings, activity, agents, `GET /api/orders/:id/checkout`, `GET /api/approvals/:id`, integrations health | Supabase Realtime on `activity_events` for live updates |
| Knowledge | facts, catalog, approvals, `POST .../catalog/sync`, `POST .../facts/propose`, files, `POST /api/conflicts/:id/resolve` | Square sandbox for catalog sync |
| Prices | catalog, facts, approvals, activity, `POST .../catalog/prices/propose` | Square sandbox: the price route is on `main` now and reads the current price from Square before it creates the approval. The price editor has not been tried from the web app against a real server, so try it before you show it. |
| Integrations | integrations health, live agent, `GET /api/agents/:id`, activity | Provider settings for each provider shown; `TWILIO_PHONE_NUMBER` for the phone number section |
| Settings | `GET /api/businesses/:id`, `PATCH /api/businesses/:id`, facts, approvals, activity | None beyond auth |
| Telemetry | `GET /api/telemetry` | Recorded calls for non-empty numbers |

## 6. Quick checks before the demo

- `https://abos-server.onrender.com/health` answers in the browser. Open it a few minutes before the demo so the first request is not the one the audience waits on.
- After sign-in, the business selector lists the businesses the server returned and the Overview screen loads. If you see one of the states in the table in section 4, fix that first.
- Open Overview, Approvals and Live operations once. If several screens say something was not found, open the browser's network tab. A 404 answer whose message starts "No route for" means the deployed server is a build from before the integration branch was merged.
- If the phone number card shows an error, check `TWILIO_PHONE_NUMBER` on the server first. Without it the server answers `INTEGRATION_UNAVAILABLE` "Phone number is not configured."
- If the Prices screen says "The price editor is not available on this server", the deployed server has no price route. Do not show the price editor on that server.
