# Demo files

What we use on stage for the four minute demo.

| File | What it is |
|---|---|
| `DemoScript.md` | The script, with timings and stage notes. |
| `WoodstocksPizzaMenu.pdf` | The menu file we attach on the Build screen. |
| `WoodstocksCustomerFAQs.pdf` | The customer questions and answers file we attach on the Build screen. |

## How the files are used

The two PDFs are attached in the composer on the Build screen and their names show under the message. They are not uploaded and nothing reads them. The agent, its menu and its facts are loaded before the demo (issue #161, `npm run seed:demo-shop`). The PDFs carry the same data so that what the audience sees matches what the agent knows.

## Where the data comes from

- Pizza names, toppings, address and hours: the public online menu and Google listing of Woodstock's Pizza, 1000 Higuera St, San Luis Obispo, read on 2026-11-14.
- Sizes and prices: simplified for the demo. Every pizza is $15 Small, $25 Medium, $35 Large. This is not the shop's price list.
- These are not official Woodstock's Pizza documents. Each PDF says so in its footer.

## The demo screen

Run the web app as in `docs/DEMO-LAPTOP.md`, with two more values set when the dev server starts:

```bash
NEXT_PUBLIC_DEMO_SCRIPT=1 NEXT_PUBLIC_DEMO_PHONE_NUMBER=+18052039807 npm run dev -w @abos/web
```

Sign in and open Build. Load the page once before presenting. Use "Start over" between rehearsals.

## If the data changes

The same numbers live in four places. Change all of them together:

1. `packages/contracts/fixtures/demo-shop.ts` (what the agent sells), then load it again.
2. `apps/web/app/(dashboard)/build/demo/woodstocks-menu.ts` (what the Build screen shows).
3. The two PDFs in this folder.
4. The FAQ answers in the demo shop facts.
