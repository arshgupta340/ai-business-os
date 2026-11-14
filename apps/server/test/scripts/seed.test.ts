import { describe, expect, it } from 'vitest';
import { MissingEnvError } from '../../../../packages/db/src/seed';
import { SQUARE_SKIP_LINE, planSquareStep, runSeed, type SeedSteps } from '../../../../scripts/seed-lib';

const TOKEN = 'marker-square-token-qqq';
const SANDBOX = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: TOKEN, SQUARE_LOCATION_ID: 'L-marker' };

function fakeSteps() {
  const calls: string[] = [];
  const lines: string[] = [];
  const steps: SeedSteps = {
    database: async (argv) => { calls.push(`database ${argv.join(' ')}`.trim()); },
    square: async () => { calls.push('square'); },
    log: (line) => { lines.push(line); },
  };
  return { calls, lines, steps };
}

describe('npm run seed in one command', () => {
  it('seeds the database, then the Square catalog, when sandbox keys are set', async () => {
    const f = fakeSteps();
    await runSeed([], SANDBOX, f.steps);
    expect(f.calls).toEqual(['database', 'square']);
    expect(f.lines).toEqual([]);
  });

  it('passes --with-demo-conflict to the database step', async () => {
    const f = fakeSteps();
    await runSeed(['--with-demo-conflict'], SANDBOX, f.steps);
    expect(f.calls).toEqual(['database --with-demo-conflict', 'square']);
  });

  it('seeds the database and skips the Square step with a printed line when no Square keys are set', async () => {
    for (const env of [{}, { SQUARE_ENVIRONMENT: 'sandbox' }, { SQUARE_ACCESS_TOKEN: '  ', SQUARE_LOCATION_ID: '' }]) {
      const f = fakeSteps();
      await runSeed([], env, f.steps);
      expect(f.calls).toEqual(['database']);
      expect(f.lines).toEqual([SQUARE_SKIP_LINE]);
    }
  });

  it('refuses before the database step when Square keys are set outside sandbox', async () => {
    for (const SQUARE_ENVIRONMENT of [undefined, 'production', 'Sandbox ']) {
      const f = fakeSteps();
      const env = { ...SANDBOX, SQUARE_ENVIRONMENT };
      await expect(runSeed([], env, f.steps)).rejects.toThrow(/SQUARE_ENVIRONMENT is "sandbox"/);
      expect(f.calls).toEqual([]);
    }
  });

  it('refuses before the database step when only one Square key is set, and names the missing one', async () => {
    const f = fakeSteps();
    const err = await runSeed([], { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: TOKEN }, f.steps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingEnvError);
    expect((err as MissingEnvError).missing).toEqual(['SQUARE_LOCATION_ID']);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(f.calls).toEqual([]);
  });

  it('seed:square runs only the catalog step', async () => {
    const f = fakeSteps();
    await runSeed(['square'], SANDBOX, f.steps);
    expect(f.calls).toEqual(['square']);
  });

  it('the skip line names no value', () => {
    const plan = planSquareStep({ SQUARE_ENVIRONMENT: 'sandbox' });
    expect(plan).toEqual({ run: false, reason: SQUARE_SKIP_LINE });
    expect(SQUARE_SKIP_LINE).not.toContain(TOKEN);
  });
});
