// npm run seed [-- --with-demo-conflict]   seeds the owner and the demo world.
// npm run seed:square                      seeds the Square SANDBOX catalog and catalog_items.
// The logic lives in packages/db/src/seed.
import { runCli, seedMain } from '../packages/db/src/seed/cli';

runCli(seedMain);
