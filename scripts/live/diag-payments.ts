// Diagnostic for the live verifier: runs the server's own Square adapter reads for one order
// (Square order read, payment search, payment verification). Read only. Prints statuses and errors.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from '../../apps/server/src/env';
import { buildProviders } from '../../apps/server/src/compose/providers';
let dir = process.cwd();
for (;;) { const f = join(dir, '.env.local'); if (existsSync(f)) { process.loadEnvFile(f); break; } const up = dirname(dir); if (up === dir) break; dir = up; }
const [squareOrderId, amount] = process.argv.slice(2);
const env = parseEnv();
const p = buildProviders(env, () => new Date());
const sq = p.square!;
const err = (e: unknown) => { const x = e as { name?: string; message?: string; code?: string; reason?: string; cause?: { message?: string; statusCode?: number } }; return `${x.name} ${x.code ?? x.reason ?? ''} ${String(x.message).slice(0, 300)} cause=${String(x.cause?.message ?? '').slice(0, 300)} ${x.cause?.statusCode ?? ''}`; };
try {
  const ids = await sq.findPaymentForOrder(squareOrderId!);
  console.log('payments found', ids.map((i) => `…${i.slice(-6)}`));
  for (const id of ids) {
    try { console.log('verify', JSON.stringify(await sq.verifyPayment({ paymentId: id, expected: { squareOrderId: squareOrderId!, amountMinor: Number(amount), currency: 'USD', locationId: env.SQUARE_LOCATION_ID! } }))); }
    catch (e) { console.log('verify error', err(e)); }
  }
} catch (e) { console.log('find error', err(e)); }
