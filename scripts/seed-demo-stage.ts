// npm run seed:demo-stage   sets up the three stage shops of the demo (a pizza place, a barbershop and a
//                           salon): business rows, facts, published agents, the pizza menu in the Square
//                           SANDBOX catalog, and one phone number per shop. Safe to run twice. Run it again
//                           after a reset.
// The numbers come from the settings: AGENTPHONE_PHONE_NUMBER (pizza), DEMO_BARBER_PHONE_NUMBER and
// DEMO_SALON_PHONE_NUMBER. Operator action: it uses DATABASE_ADMIN_URL and the Square sandbox keys.
import { demoStageMain, runCli } from '../packages/db/src/seed/cli';

runCli(() => demoStageMain());
