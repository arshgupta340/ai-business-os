// The logic behind scripts/seed.ts, kept apart so tests can call it with fakes.
//
// npm run seed          seeds the database, then the Square SANDBOX catalog, in one command.
// npm run seed:square   runs only the Square catalog step.
//
// The Square step is decided before anything is written:
// - no Square keys at all: the database is seeded and the Square step is skipped with a printed line;
// - any Square key set: SQUARE_ENVIRONMENT must be "sandbox" and both keys must be present, or the
//   whole command refuses before the database step runs.
// The catalog step itself is idempotent (packages/db/src/seed/square.ts).

import { envValue, requireSquareSandboxEnv, type SeedEnv } from '../packages/db/src/seed';

export const SQUARE_KEYS = ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'] as const;

export const SQUARE_SKIP_LINE =
  'Square SANDBOX catalog step skipped: SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID are not set. ' +
  'The database is seeded. Add the sandbox keys and run npm run seed:square to seed the catalog.';

export type SquarePlan = { run: true } | { run: false; reason: string };

/** Decides the Square step from the environment. Throws when keys are set but unsafe or incomplete. */
export function planSquareStep(env: SeedEnv): SquarePlan {
  const anySet = SQUARE_KEYS.some((k) => envValue(env, k) !== undefined);
  if (!anySet) return { run: false, reason: SQUARE_SKIP_LINE };
  // Refuses unless SQUARE_ENVIRONMENT is "sandbox", and names a missing key.
  requireSquareSandboxEnv(env);
  return { run: true };
}

export interface SeedSteps {
  /** Seeds the owner, both businesses, facts, capabilities and agents. Receives the remaining flags. */
  database: (argv: string[]) => Promise<void>;
  /** Seeds the Square sandbox catalog and the catalog_items cache. */
  square: () => Promise<void>;
  log: (line: string) => void;
}

/** One command: argv "square" runs only the catalog step; otherwise database, then catalog. */
export async function runSeed(argv: string[], env: SeedEnv, steps: SeedSteps): Promise<void> {
  if (argv.includes('square')) {
    await steps.square();
    return;
  }
  const plan = planSquareStep(env);
  await steps.database(argv);
  if (plan.run) await steps.square();
  else steps.log(plan.reason);
}
