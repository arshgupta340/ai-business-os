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
| GitHub repository | Private. Saina is still a collaborator and can push. | Repository settings, Change visibility. |
| GitHub Pages demo link (`arshgupta340.github.io/ai-business-os`) | Off. Pages needs a public repository or a paid plan. The `gh-pages` branch is kept. | Make the repository public or upgrade, then turn Pages on from `gh-pages`. |

## Work saved before local cleanup

The task worktrees under `.worktrees/` on Arsh's laptop were removed. Work that existed only there was pushed first:

- `backup/fx115-uncommitted`: uncommitted fixture and web test edits from the `fx115` worktree. Not reviewed.
- `backup/apply2-db-fixes`: database fix commits from the `apply2` worktree.
- `arsh/B-07-policy-engine`, `arsh/B-08-core-api`, `arsh/base-b06-s02`: original task commits that were merged in another form.

Codex review notes from those worktrees were copied to `backups/worktree-reviews/` on Arsh's laptop. That folder is not in git.

## Not done

The API keys are still valid: OpenAI, Square sandbox, Twilio, AgentPhone, the Google service account and the Supabase keys and database logins. If the project will not restart, rotate or revoke them in each dashboard. The OpenAI key and the restricted database login were also shared with Saina.
