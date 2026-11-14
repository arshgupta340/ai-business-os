# AI Business OS

A conversational operating layer for small businesses. An owner describes a job, and gets a controlled phone agent that can be tested, published and monitored. Every consequential action waits for the owner's approval.

Hackathon build. Demo: a customer calls a pizza shop's number, orders, the owner approves, and a Square **sandbox** checkout completes. A second agent books barbershop appointments on Google Calendar.

## Status

Spec complete. Code starts at task S-01. See the board.

## Start here

| If you are | Read |
|---|---|
| Anyone | `docs/SPEC.md`: decisions, names, architecture, scope |
| Arsh | `docs/SETUP-ACCOUNTS.md`, then `docs/WORKPLAN.md` |
| Saina | `docs/API.md` and `docs/CONTRACTS.md`, then `docs/WORKPLAN.md` |
| A coding agent | `AGENTS.md`, then the issue for your task |
| Starting a build session | `docs/KICKOFF-ARSH.md` or `docs/KICKOFF-SAINA.md`: a prompt to paste into Claude Code |

## Documents

| File | What it holds |
|---|---|
| `docs/PRD.md` | The original product requirements |
| `docs/SPEC.md` | Master spec. Wins over the PRD where they differ |
| `docs/GAPS.md` | What the PRD left open and how each gap is resolved |
| `docs/CONTRACTS.md` | Schemas, capability registry, state machines, events |
| `docs/API.md` | REST endpoints and webhooks |
| `docs/DATA-MODEL.md` | Database tables and row-level security |
| `docs/FLOWS.md` | Each flow step by step |
| `docs/WORKPLAN.md` | Tasks, owners, timeline, working rules |
| `docs/SETUP-ACCOUNTS.md` | Account setup checklist |

## Who does what

- **Arsh:** payments, phone voice, approvals, webhooks, database, Google, deployment of the server.
- **Saina:** every screen, the mock layer, and the builder on the server.

## Task board

Tasks are GitHub Issues in this repo, shown on the Project board.

```bash
node scripts/board.mjs next arsh
```

```bash
node scripts/board.mjs next saina
```

## Secrets

Copy `.env.example` to `.env.local` and fill it in. Never commit it.
