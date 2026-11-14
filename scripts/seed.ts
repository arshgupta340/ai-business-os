// npm run seed [-- --with-demo-conflict]   seeds the owner and the demo world, then the Square
//                                          SANDBOX catalog. Without Square keys the catalog step
//                                          is skipped with a printed line.
// npm run seed:square                      runs only the Square SANDBOX catalog step.
// The seed logic lives in packages/db/src/seed; the one-command order lives in scripts/seed-lib.ts.
import { findEnvFile } from '../packages/db/src/migrate';
import { runCli, seedMain } from '../packages/db/src/seed/cli';
import { runSeed } from './seed-lib';

runCli(async (argv) => {
  // Load .env.local first so the Square decision sees it. loadEnvFile does not overwrite variables
  // already set, so seedMain loading it again changes nothing.
  const file = findEnvFile();
  if (file) process.loadEnvFile(file);
  await runSeed(argv, process.env, {
    database: (rest) => seedMain(rest.filter((a) => a !== 'square')),
    square: () => seedMain(['square']),
    log: (line) => console.log(line),
  });
});
