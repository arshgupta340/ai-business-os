# Shutdown record

The hackathon ended. On 2026-11-16 every service that ran or billed was stopped. This file says what state each one is in and how to bring it back.

## What was stopped

| Piece | State now | How to bring it back |
|---|---|---|
| Render web service `abos-server` (`srv-dbs23gek1f9s7382m650`) | Suspended. Returns 503. A merge to `main` no longer deploys. | Render dashboard, `abos-server`, Settings, Resume Web Service. |
| Supabase project "Business OS" (`tvbfjuvfaopchlcuslya`) | Paused. Data is kept, including the `archive_20261115_*` schemas. | Supabase dashboard, Restore project. Supabase limits how long a paused free project can be restored, so check the dashboard before relying on it. |
| AgentPhone numbers +18052039807 (pizza), +16012020299 (barbershop), +13242046938 (salon) | Released for good. The three agents still exist. The project webhook is deleted. | Buy new numbers (`POST /v1/numbers`), attach each to its agent, set the project webhook to `https://abos-server.onrender.com/webhooks/agentphone`, then update `AGENTPHONE_*` and `DEMO_*_PHONE_NUMBER` in Render and reseed `live_agent` (see `npm run seed:demo-stage`). |
| Twilio number +18052151344 | Released for good. The Twilio account stays open. | Buy a number, set its voice URL to `/webhooks/twilio/voice` and its status callback to `/webhooks/twilio/status` on the server, and update `TWILIO_PHONE_NUMBER`. |
| Square sandbox webhook subscription `wbhk_7b5dbfcc73cd4ec7a809987ee4f8c0d2` | Disabled. | Update the subscription with `enabled: true`. |
| GitHub repository | Made private on 2026-11-16, then public again on 2026-11-19 at Arsh's instruction. Saina is still a collaborator. | Repository settings, Change visibility. |
| GitHub Pages demo link (`arshgupta340.github.io/ai-business-os`) | Off from 2026-11-16, back on since 2026-11-19 with the repository public. It is a mock build with no backend and no keys. | Served from the `gh-pages` branch. |

## Work saved before local cleanup

The task worktrees under `.worktrees/` on Arsh's laptop were removed. Work that existed only there was pushed first:

- `backup/fx115-uncommitted`: uncommitted fixture and web test edits from the `fx115` worktree. Not reviewed.
- `backup/apply2-db-fixes`: database fix commits from the `apply2` worktree.
- `arsh/B-07-policy-engine`, `arsh/B-08-core-api`, `arsh/base-b06-s02`: original task commits that were merged in another form.

Codex review notes from those worktrees were copied to `backups/worktree-reviews/` on Arsh's laptop. That folder is not in git.

## Keys and charges (checked 2026-11-19)

A scan of every commit on every branch and pull request, and of all issue and pull request text, found none of the project's real secret values. The only key-shaped strings are test fakes.

| Provider | Key state | Can it charge Arsh? |
|---|---|---|
| OpenAI | Key "Calpoly AI Hackathon" revoked. A separate key "AI BOS video fix" was made on Arsh's yes for the demo video; it expires 2026-11-26 and is kept only in an untracked local file. | Prepaid, auto-reload off: spend cannot go past the credit balance. |
| Twilio | Auth token rotated (the old one returns 401). The extra API key "AI Hachathon" deleted. No numbers. | Only by someone signed in to the console. The auto-recharge setting was not checked, because the console needs Arsh's login. |
| AgentPhone | API key revoked (returns 401). No numbers, no webhook. | Auto-recharge is off. A saved payment method ("Link") remains. |
| Google Cloud `ai-business-os-demo` | Service account key deleted. Billing disabled on the project. | No. |
| Supabase | Project paused. | No: free plan, spend cap on, no payment method. |
| Render | Service suspended. | Only the $0.53 used before the shutdown; the November projection is also $0.53. A card is on file. |
| Square | Sandbox only. | No: sandbox moves no real money. |

To restart, OpenAI, AgentPhone and Google need new keys: the values for them in `.env.local`, `.env.render` and Render's environment are dead. The new Twilio token is only in `.env.local` on Arsh's laptop, so Render needs it too. The Supabase and Square sandbox keys were not rotated; neither can charge.
