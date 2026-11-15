// npm run seed:demo-shop   loads the demo shop (issue #161) for the pizza business: its 16 pizza menu
//                          into the Square SANDBOX catalog and catalog_items, and its verified facts
//                          (hours, address, policies, FAQs). Safe to run twice. Run it again after a reset.
// Operator action: it uses DATABASE_ADMIN_URL and the Square sandbox keys from .env.local.
import { demoShopMain, runCli } from '../packages/db/src/seed/cli';

runCli(() => demoShopMain());
