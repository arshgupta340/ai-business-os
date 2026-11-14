// npm run reset -- --yes [--with-demo-conflict]   clears run data and reseeds what the truncate removed.
// The logic lives in packages/db/src/seed.
import { resetMain, runCli } from '../packages/db/src/seed/cli';

runCli(resetMain);
