# Run the web app on a laptop against the deployed server

The server is at `https://abos-server.onrender.com`. Today it serves `/health` and the builder routes only. The other screens show real data only after the integration branch is deployed (see `docs/notes-web-real-mode.md`).

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

It serves `http://localhost:3000`. Keep port 3000: the server's CORS allows only `WEB_ORIGIN`, which defaults to `http://localhost:3000`. If you must use another port, `WEB_ORIGIN` on Render has to match it.

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

## 5. What each screen needs from the server

Every call carries the Supabase access token. Business-scoped calls also need the signed-in owner to own the selected business, or the server answers `FORBIDDEN_BUSINESS`.

| Screen | Routes it calls | Also needs on the server |
|---|---|---|
| Top bar (business selector, approvals badge, health dot) | `GET /api/businesses`, `GET /api/approvals`, `GET /api/integrations/health` | Seeded businesses owned by the owner |
| Overview | agents, live agent, approvals, orders, bookings, calls, activity, integrations health | `TWILIO_PHONE_NUMBER` for the live agent card |
| Build | `POST /api/builder/sessions`, `GET /api/builder/sessions/:id`, `POST .../messages`, `POST /api/agents` | Builder auth configured (token verifier); OpenAI key for real builder replies |
| Build voice | `POST /api/realtime/client-secret` | OpenAI key; a microphone; the browser calls OpenAI directly with the short-lived secret |
| Agents, agent detail | `GET /api/agents`, `GET /api/agents/:id`, `GET /api/live-agent`, `PUT /api/live-agent`, `POST .../pause`, `GET /api/calls` | `TWILIO_PHONE_NUMBER` |
| Preview, test console, publish | `POST .../preview`, `POST .../test`, `POST .../sim-call`, `POST .../publish` | A live agent for simulated calls; Square sandbox for publish checks |
| Versions | `GET .../versions`, `POST .../rollback`, `GET /api/activity` | None beyond auth |
| Approvals | `GET /api/approvals`, `GET /api/approvals/:id`, `POST .../decision`, `GET /api/orders/:id`, `GET /api/bookings/:id` | The approval engine and executor |
| Activity (live operations, call detail) | calls, orders, bookings, activity, `GET /api/orders/:id/checkout`, approvals | Supabase Realtime on `activity_events` for live updates |
| Knowledge | facts, catalog, `POST .../catalog/sync`, `POST .../facts/propose`, files, conflicts | Square sandbox for catalog sync |
| Prices | catalog, facts, approvals, activity, `POST .../catalog/prices/propose` | The price route is not on the integration branch. Do not demo the price editor in real mode. |
| Integrations | integrations health, live agent, activity | Provider settings for each provider shown |
| Settings | `GET /api/businesses/:id`, `PATCH /api/businesses/:id`, facts, approvals, activity | None beyond auth |
| Telemetry | `GET /api/telemetry` | Recorded calls for non-empty numbers |

## 6. Quick checks before the demo

- `https://abos-server.onrender.com/health` answers in the browser. Open it a few minutes before the demo so the first request is not the one the audience waits on.
- After sign-in, the business selector lists the seeded businesses and no error banner appears.
- If every screen says the resource was not found, the deployed server is still the build without the integration routes.
