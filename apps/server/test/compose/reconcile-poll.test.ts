// The payment reconcile poll is a Square read loop. It must run whether or not the webhook routes are
// enabled: without PUBLIC_SERVER_URL (local runs, or a deploy whose webhook is misregistered) the poll
// is the only thing that can move a paid order to PAID_VERIFIED. Found in the live verification run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_POLL_INTERVAL_MS } from '@abos/contracts';
import { createDbWebhooks } from '../../src/compose/webhooks';
import type { SeamDeps } from '../../src/compose/seams';
import { parseEnv } from '../../src/env';

const silentLog: SeamDeps['log'] = { info() {}, warn() {}, error() {} };

function deps(env: Record<string, string>, withSquare = true) {
  const queries: string[] = [];
  const db = { query: vi.fn(async (text: string) => { queries.push(text); return { rows: [] }; }), transaction: vi.fn() };
  const fallback = async () => undefined;
  const providers = { square: withSquare ? { findPaymentForOrder: vi.fn(async () => []) } : undefined } as unknown as SeamDeps['providers'];
  const seam = { env: parseEnv(env), db, providers, now: () => new Date(), newId: (p: string) => `${p}1`, log: silentLog } as unknown as SeamDeps;
  return { webhooks: createDbWebhooks(seam, fallback), queries };
}
const polled = (queries: string[]) => queries.filter((q) => q.includes("status in ('PAYMENT_PENDING','PAYMENT_FAILED')")).length;

afterEach(() => { vi.useRealTimers(); });

describe('payment reconcile poll', () => {
  it('runs without PUBLIC_SERVER_URL, while the webhook routes stay disabled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { webhooks, queries } = deps({ SQUARE_WEBHOOK_SIGNATURE_KEY: 'k' });
    expect(webhooks.enabled).toBe(false);
    webhooks.start();
    await vi.advanceTimersByTimeAsync(PAYMENT_POLL_INTERVAL_MS);
    expect(polled(queries)).toBe(1);
    await webhooks.stop();
  });

  it('does not poll without Square', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { webhooks, queries } = deps({}, false);
    webhooks.start();
    await vi.advanceTimersByTimeAsync(PAYMENT_POLL_INTERVAL_MS * 2);
    expect(polled(queries)).toBe(0);
    await webhooks.stop();
  });
});

describe('reconcile failure log', () => {
  it('names the error codes, never an ID or free text', async () => {
    const { reconcileErrorCodes } = await import('../../src/compose/webhooks');
    const routine = Object.assign(new Error('PAYMENT: location mismatch'), { code: 'P0001' });
    const withId = Object.assign(new Error('PAYMENT: order ord_1234567890 not found'), { code: 'P0001' });
    const { AppError } = await import('../../src/errors');
    const square = Object.assign(new Error('Status code: 401 body {"token":"x"}'), { name: 'SquareError', statusCode: 401 });
    const codes = reconcileErrorCodes(new AggregateError([routine, withId, new AppError('INTEGRATION_UNAVAILABLE', 'Square down'), square, 'weird']));
    expect(codes).toEqual(['P0001 PAYMENT: location mismatch', 'P0001 PAYMENT', 'INTEGRATION_UNAVAILABLE', 'SquareError 401', 'unknown']);
  });

  it('logs the codes when a pass fails', async () => {
    const warn = vi.fn();
    const db = { query: vi.fn(async () => { throw Object.assign(new Error('PAYMENT: location mismatch'), { code: 'P0001' }); }), transaction: vi.fn() };
    const providers = { square: { findPaymentForOrder: vi.fn(async () => []) } } as unknown as SeamDeps['providers'];
    const seam = { env: parseEnv({}), db, providers, now: () => new Date(), newId: (p: string) => `${p}1`, log: { ...silentLog, warn } } as unknown as SeamDeps;
    await createDbWebhooks(seam, async () => undefined).reconcileNow();
    expect(warn).toHaveBeenCalledWith({ job: 'reconcile', codes: ['P0001 PAYMENT: location mismatch'] }, 'payment reconciliation will retry');
  });
});
