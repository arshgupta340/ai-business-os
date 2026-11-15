# Demo files

What we use on stage for the four minute demo.

The demo offers three made-up businesses. A judge says which one they want. The presenter attaches that business's two PDFs on the Build screen and sends one sentence. The screen shows that business's own phone number, the judge calls it, and the order or booking arrives for approval.

| Business | Files to attach | What a caller does |
|---|---|---|
| Main Street Pizza (pizza place) | `MainStreetPizzaMenu.pdf`, `MainStreetPizzaFAQs.pdf` | Orders a pizza for pickup |
| Classic Cuts Barbershop (barbershop) | `ClassicCutsServices.pdf`, `ClassicCutsFAQs.pdf` | Books an appointment |
| Glow Hair Salon (salon) | `GlowHairSalonServices.pdf`, `GlowHairSalonFAQs.pdf` | Books an appointment |

`DemoScript.md` is the script. It was written for the one-shop demo and its lines still name the old shop; see the note at its top.

## How the files are used

The Build screen reads only the NAME of an attached file. The name selects the business, and with it the phone number and the menu or services the screen shows. Keep the file names exactly as they are. Either of a business's two files is enough. The files are not uploaded and nothing reads their content: all three agents, their numbers, menus and facts are set up before the demo by `npm run seed:demo-stage`.

Nothing on the screen lists the three options. The choice is made aloud.

## Where the data comes from

All three businesses are made up. No real San Luis Obispo business is meant. The single source for the names, menus, services, hours and FAQs is `packages/contracts/fixtures/demo-stage.ts`. The PDFs are printed from it:

```bash
npx tsx scripts/demo-stage-pdfs.ts <out-dir>
```

That writes six HTML files; a browser prints each to PDF. Payments are Square sandbox test data.

## The demo screen

The web app needs these values when it is built or started:

```bash
NEXT_PUBLIC_DEMO_SCRIPT=1
NEXT_PUBLIC_DEMO_PHONE_PIZZA=<the pizza line>
NEXT_PUBLIC_DEMO_PHONE_BARBER=<the barbershop line>
NEXT_PUBLIC_DEMO_PHONE_SALON=<the salon line>
```

Sign in and open Build. Load the page once before presenting. Use "Start over" between rehearsals.

## Before presenting

Clear the rehearsal data and set the three shops up again (the reset puts the two-pizza seed back, so the second command must follow it). Archive first; see the team notes for the procedure.

```bash
TELEPHONY_PROVIDER=agentphone npm run reset -- --yes
```

```bash
npm run seed:demo-stage
```

The second command needs the three numbers in the settings: `AGENTPHONE_PHONE_NUMBER` (pizza), `DEMO_BARBER_PHONE_NUMBER` and `DEMO_SALON_PHONE_NUMBER`.
