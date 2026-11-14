# Work Plan

**Date:** 2026-11-13. **Build window:** 24 to 48 hours. **Leads:** Arsh Gupta and Saina Kakkar, each running a Claude Code session and parallel worker agents (Claude sub-agents, Codex, OpenCode).

The task list lives in `scripts/tasks.json`. The state of each task lives in GitHub Issues and on the Project board. The tables in section 5 are generated from `tasks.json` by `node scripts/board.mjs render`. Do not edit them by hand.

## 1. Who does what

| Lead | Owns | Directories |
|---|---|---|
| Arsh | Accounts and keys. Integration spikes. Database. Policy and approval engine. Action executor and jobs. Square, message, Calendar and Sheets adapters. Webhooks and reconciliation. Phone voice worker. Core REST routes. Seeds. Deployment of the server. | `apps/server/src/{api,auth,policy,executor,adapters,tools,voice,webhooks,reconcile,telemetry}`, `packages/contracts`, `packages/db`, `scripts`, root config |
| Saina | Every screen. API client and mock layer. The builder on the server: interview, spec generation, text runner, preview and test, publish and versions, document extraction, owner voice session. Deployment of the web app. | `apps/web`, `apps/server/src/builder` |
| Both | Contract review, the two integration points, rehearsals, the runbook. | `docs` |

The task ID prefix says where the code lives: `S` is shared, `B` is the server, `U` is the web app. The Owner column says who does it. Saina owns some `B` tasks because the builder runs on the server (decision D-07).

<!-- TOTALS:START -->

52 tasks: 29 for Arsh, 20 for Saina, 3 for both together. 46 are MUST and 6 are SHOULD. 14 need a person for part of the work.

<!-- TOTALS:END -->

### Load balance

At human speed the lists come to roughly 70 hours for Arsh and 50 for Saina. Neither lead writes most of that by hand: the leads direct workers. What stays with a person is listed in section 4. Arsh carries every first-hour spike, so if one lead falls behind, tasks move in this order: B-20 (Sheets mirror), B-30 (telemetry), B-26 (price change) from Arsh to Saina.

## 2. Contract freeze (hours 0 to 2)

Both leads agree on these before any feature code is written. After the freeze the two sides can build without waiting on each other.

| What | Where | Who writes it | Who reviews |
|---|---|---|---|
| Names, states, capabilities, events | `docs/SPEC.md` section 2 | done | both |
| Schemas, state machines, tool definitions | `docs/CONTRACTS.md`, then `packages/contracts/src` (S-02) | Arsh | Saina |
| Endpoints, errors | `docs/API.md` | done | both |
| Tables | `docs/DATA-MODEL.md`, then `packages/db/migrations` (B-06) | Arsh | none |
| Fixtures, scripted timelines, mock toolset | `packages/contracts/fixtures`, `apps/server/src/tools/mock` (S-03) | Arsh | Saina |
| Mock layer for the UI | `apps/web/mocks` (U-02) | Saina | none |

Steps:
1. Saina reads `docs/API.md` and `docs/CONTRACTS.md` and sends Arsh the fields each screen needs that are missing.
2. Arsh's session turns `docs/CONTRACTS.md` into Zod (S-02) and fixtures (S-03) while Arsh himself does the account signups (B-01).
3. Saina approves the S-02 pull request. That approval is the freeze.

**After the freeze, contract changes are additive only.** A change is a pull request labelled `contract` that also updates the fixtures. The other lead approves it within 30 minutes. Nobody renames or removes a field after hour 2.

## 3. Timeline and checkpoints

Hours count from the moment the build starts. Each block ends with a checkpoint that both leads confirm on the board.

| Block | What happens | Checkpoint at the end |
|---|---|---|
| A: 0 to 2h | Accounts. Four spikes: Square, phone voice, message channel, Google. Repo scaffold. Contracts and fixtures. Web shell. | **Go or no-go.** A Square sandbox link was paid and its webhook verified. A phone call reached the voice model. A message channel delivered a link. Contracts are merged. If a spike failed, apply the fallback in SPEC section 6 now and say so. |
| B: 2 to 8h | Migrations. Approval engine. Core API. Staging deploy. Seeds. UI on mocks: Overview, Approvals. | Staging health is green. Approvals and Overview work on mocks. |
| C: 8 to 16h | Executor. Square adapter. Webhooks. Message adapter. Builder service. Live operations, Builder and Preview screens. | **Integration 1 (S-04).** With mocks off, a typed order reaches approval, and a paid webhook moves it to `PAID_VERIFIED` on the dashboard. |
| D: 16 to 28h | Phone worker. Publish and live switch. Hours edit. Booking flow. Simulated call. Owner voice. End-to-end suite. | A real call goes from order to approval to a verified sandbox payment. The end-to-end suite passes. |
| E: 28 to 40h | Barbershop on a live call. Sheets. Extraction. Hardening. Adversarial tests. Polish. SHOULD items. | **Integration 2 (S-05).** First full rehearsal of the demo script. |
| F: 40 to 48h | Code freeze at hour 40: bug fixes only. Three rehearsals. Runbook, security notes, feature matrix, labelled backup video. | Three clean rehearsals in a row. |

If a checkpoint fails, use the cut order in `docs/SPEC.md` section 5.1. The never-cut rules in SPEC section 1.3 hold whatever happens.

## 4. What needs a person

Workers can write and test code. They cannot do these. Tasks that include any of them carry the `human` label.

- Creating provider accounts, verifying email and phone, entering a card, copying secret keys.
- Placing a real phone call and listening to it.
- Opening the checkout link on a second device and paying with the test card.
- Speaking to the builder through a browser microphone.
- Sitting with an outside business owner (AC-20).
- Rehearsing the demo.

While a lead does one of these, their session keeps workers busy on tasks that do not need it.

## 5. Tasks

<!-- TASKS:START -->

### Phase A: 0 to 2h, spikes and contract freeze

| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |
|---|---|---|---|---|---|---|---|---|
| S-01 | Scaffold workspaces, apps and CI | Arsh | M | MUST | none |  |  | #1 |
| S-02 | Contracts package: Zod schemas from CONTRACTS.md | Arsh | M | MUST | S-01 |  |  | #2 |
| S-03 | Fixtures, mock timelines and mock toolset | Arsh | S | MUST | S-02 |  |  | #3 |
| B-01 | Provider accounts and keys | Arsh | M | MUST | none |  | yes | #8 |
| B-02 | Spike: Square catalog, quote, payment link, paid webhook | Arsh | L | MUST | B-01 | AC-05, AC-09, AC-11 | yes | #9 |
| B-03 | Spike: phone call reaches the voice model | Arsh | L | MUST | B-01 |  | yes | #10 |
| B-04 | Spike: choose and prove the message channel | Arsh | S | MUST | B-01, B-02 |  | yes | #11 |
| B-05 | Spike: Google Calendar and Sheets with a service account | Arsh | M | MUST | B-01 |  | yes | #12 |
| U-01 | Web app scaffold, shell, sign-in, sandbox banner | Saina | M | MUST | none |  |  | #39 |

### Phase B: 2 to 8h, foundation

| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |
|---|---|---|---|---|---|---|---|---|
| B-06 | Database migrations, row-level security, realtime | Arsh | M | MUST | S-02 | AC-17 |  | #13 |
| B-07 | Policy and approval engine with activity events | Arsh | L | MUST | B-06 | AC-07, AC-08, AC-10 |  | #14 |
| B-08 | Server skeleton, auth and core REST routes | Arsh | L | MUST | B-06 |  |  | #15 |
| B-09 | Staging deploy and webhook registration | Arsh | M | MUST | B-01, B-08 |  | yes | #16 |
| B-10 | Seed and reset scripts | Arsh | M | MUST | B-06, B-02 |  |  | #17 |
| U-02 | API client and mock layer | Saina | M | MUST | S-02, S-03 |  |  | #40 |
| U-03 | Overview screen | Saina | M | MUST | U-02 |  |  | #41 |
| U-04 | Approvals inbox and decision dialog | Saina | L | MUST | U-02 | AC-07, AC-08, AC-10 |  | #42 |

### Phase C: 8 to 16h, core flow

| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |
|---|---|---|---|---|---|---|---|---|
| S-04 | Integration 1: UI on the real staging API | Arsh and Saina | M | MUST | B-08, B-09, B-11, U-02, U-04 |  |  | #4 |
| B-11 | Action executor, jobs, idempotency, approval expiry | Arsh | L | MUST | B-07 | AC-09, AC-10 |  | #18 |
| B-12 | Square adapter: catalog cache, quote, checkout link | Arsh | L | MUST | B-02, B-11 | AC-05, AC-19 |  | #19 |
| B-13 | Webhooks and payment reconciliation | Arsh | L | MUST | B-12 | AC-11, AC-12 |  | #20 |
| B-14 | Message adapter with dispatch dedupe and QR data | Arsh | M | MUST | B-04, B-11 | AC-10 |  | #21 |
| B-16 | Builder service: interview, spec, text runner, preview | Saina | L | MUST | S-01, S-03 | AC-01, AC-03 |  | #23 |
| U-05 | Live operations timeline with link and QR panel | Saina | L | MUST | U-02 |  |  | #43 |
| U-06 | Builder chat and spec panel | Saina | L | MUST | U-02 | AC-01 |  | #44 |
| U-07 | Agent preview, test console and publish | Saina | M | MUST | U-06 | AC-03, AC-04 |  | #45 |

### Phase D: 16 to 28h, phone to paid

| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |
|---|---|---|---|---|---|---|---|---|
| S-07 | Automated end-to-end suite through simulated calls | Arsh | M | MUST | B-31, B-13 | AC-07, AC-08, AC-09, AC-12 |  | #7 |
| B-15 | Pizza phone worker and tool handlers | Arsh | L | MUST | B-03, B-12, B-07 | AC-05, AC-06, AC-07 | yes | #22 |
| B-17 | Publish, pause, versions and the live-agent switch | Saina | M | MUST | B-16, B-06 | AC-04 |  | #24 |
| B-18 | Opening-hours edit as an owner confirmation | Arsh | M | MUST | B-07, B-08 | AC-16 |  | #25 |
| B-19 | Barbershop booking: calendar adapter and booking bundle | Arsh | L | MUST | B-05, B-11, B-14 | AC-14, AC-15 |  | #26 |
| B-24 | Owner voice session: realtime client secret endpoint | Saina | S | MUST | B-16 | AC-01 |  | #31 |
| B-31 | Simulated call endpoint with the real toolset | Arsh | S | MUST | B-15, B-16 |  |  | #38 |
| U-08 | Knowledge review: upload, extracted facts, conflict banner | Saina | M | MUST | U-02 | AC-02 |  | #46 |
| U-09 | Agents list and detail, live switch, hours edit | Saina | M | MUST | U-07, U-04 | AC-16 |  | #47 |
| U-12 | Builder by voice in the browser | Saina | L | MUST | U-06, B-24 | AC-01 | yes | #50 |

### Phase E: 28 to 40h, second agent and hardening

| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |
|---|---|---|---|---|---|---|---|---|
| S-05 | Integration 2: full run with phone, booking and Sheets | Arsh and Saina | M | MUST | S-04, B-15, B-17, B-19, B-20, B-25 |  | yes | #5 |
| B-20 | Sheets mirror job | Arsh | M | MUST | B-05, B-11 | AC-13 |  | #27 |
| B-21 | Document extraction and conflict detection | Saina | L | MUST | B-16 | AC-02 |  | #28 |
| B-22 | Voice hardening: refusals, hang-up, barge-in, latency | Arsh | M | MUST | B-15, B-25 | AC-06, AC-18 | yes | #29 |
| B-23 | Adversarial and duplicate tests | Arsh | M | MUST | B-13 | AC-06, AC-10, AC-11, AC-17 |  | #30 |
| B-25 | Barbershop agent on a live phone call | Arsh | M | MUST | B-15, B-19, B-17 | AC-14, AC-15 | yes | #32 |
| B-26 | Price change through Square with approval | Arsh | M | SHOULD | B-12, B-11, B-08 |  |  | #33 |
| B-27 | Version compare and rollback | Saina | M | SHOULD | B-17 |  |  | #34 |
| B-28 | Human fallback call routing | Arsh | M | SHOULD | B-22 |  | yes | #35 |
| B-29 | FAQ-only custom agent from a capability subset | Saina | M | SHOULD | B-16 |  |  | #36 |
| B-30 | Latency and cost telemetry | Arsh | M | SHOULD | B-11, B-15 |  |  | #37 |
| U-10 | Demo polish and every UI state | Saina | L | MUST | S-04 |  |  | #48 |
| U-11 | Outside owner tries the builder | Saina | S | MUST | U-10 | AC-20 | yes | #49 |
| U-13 | Version history, price edit and telemetry screens | Saina | M | SHOULD | U-09 |  |  | #51 |
| U-14 | Playwright smoke test of the demo path | Saina | M | MUST | U-07, U-05, U-04 |  |  | #52 |

### Phase F: 40 to 48h, freeze and rehearse

| ID | Task | Owner | Size | Tier | Depends on | Serves | Person | Issue |
|---|---|---|---|---|---|---|---|---|
| S-06 | Rehearsals, runbook, security notes and backup video | Arsh and Saina | L | MUST | S-05, S-07, U-14 |  | yes | #6 |

<!-- TASKS:END -->

### Acceptance criteria coverage

Every criterion in PRD section 16 maps to at least one task.

<!-- ACS:START -->

| Criterion | Tasks that deliver it |
|---|---|
| AC-01 | B-16, B-24, U-06, U-12 |
| AC-02 | B-21, U-08 |
| AC-03 | B-16, U-07 |
| AC-04 | B-17, U-07 |
| AC-05 | B-02, B-12, B-15 |
| AC-06 | B-15, B-22, B-23 |
| AC-07 | S-07, B-07, B-15, U-04 |
| AC-08 | S-07, B-07, U-04 |
| AC-09 | S-07, B-02, B-11 |
| AC-10 | B-07, B-11, B-14, B-23, U-04 |
| AC-11 | B-02, B-13, B-23 |
| AC-12 | S-07, B-13 |
| AC-13 | B-20 |
| AC-14 | B-19, B-25 |
| AC-15 | B-19, B-25 |
| AC-16 | B-18, U-09 |
| AC-17 | B-06, B-23 |
| AC-18 | B-22 |
| AC-19 | B-12 |
| AC-20 | U-11 |

<!-- ACS:END -->

## 6. Using the board

```bash
node scripts/board.mjs next arsh
```

```bash
node scripts/board.mjs claim B-12
```

```bash
node scripts/board.mjs list saina
```

- `next` lists the tasks whose dependencies are all closed. Tasks listed together do not depend on each other, so different workers can take them at the same time.
- `claim` assigns the issue to you and adds `status:doing`. Claim before any work starts, so the other session sees it.
- A task is finished when its pull request merges with `Closes #<issue>` in the description. That closes the issue and moves the card to Done.
- If you need something from the other lead, open an issue labelled `needs:arsh` or `needs:saina`. Do not edit their directories.
- If a task is stuck, add `status:blocked` and a comment that says what it waits on.

## 7. Working rules

The short version for agents is in `AGENTS.md`. The reasons are here.

**Branches and pull requests**
- One branch per task: `arsh/B-12-square-adapter`, `saina/U-04-approvals`, `shared/S-04-integration-1`.
- Keep a branch under about 3 hours of work. Rebase on `main` before opening the pull request.
- Squash merge. Each lead merges their own pull requests once CI is green. Only pull requests labelled `contract` need the other lead's approval.
- The repo is private on a free plan, so GitHub does not enforce branch protection or code owners. These rules hold by agreement, and CI catches type errors.

**Parallel workers**
- One worker per task. Each worker gets its own git worktree on the task branch, so two workers never share a working directory.
- A worker edits only the directories its task lists. Each issue lists them.
- Two tasks that list the same directory do not run at the same time. `tasks.json` orders them with a dependency.
- The lead session reviews a worker's result, runs the tests, merges and pushes. Workers do not push to `main`.
- Give each worker the issue text, `AGENTS.md`, and the docs the issue lists under "Read first". Nothing else is needed.

**Shared packages**
- `packages/contracts` is edited by Arsh's side only. Saina's side asks through a `needs:arsh` issue or a `contract` pull request that Arsh approves.
- The root `package.json` is edited by Arsh's side. Either side adds dependencies to its own workspace with `npm install <package> -w <workspace>`. That changes the one root lockfile, which is expected. Never merge the lockfile by hand: after a rebase, run `npm install` again and commit the regenerated file.

**Notes**
- Each lead keeps running notes in their own file: `docs/notes-arsh.md` and `docs/notes-saina.md`. Spike results, blockers and unverified assumptions go there. Never both in one file.

**Secrets**
- `.env.local` only. Never in a commit, an issue, a pull request or a doc.

**Honesty rules from the PRD**
- No green state before the provider confirms.
- Sandbox payments are always labelled sandbox.
- A fallback is labelled as a fallback. Nothing canned is passed off as live.
