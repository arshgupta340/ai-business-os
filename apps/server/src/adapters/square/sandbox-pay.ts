// SIMULATED customer payment in the Square SANDBOX, without a card form. The one implementation used by
// scripts/live/run-demo.ts (flow 2 and 4b) and by the D-13 demo worker (apps/server/src/demo).
// Decision by the lead (2026-11-14): open the payment link's DRAFT order through UpdateOrder, then pay it
// with Square's published sandbox nonce. The keys are stable per order and attempt, so a rerun cannot
// open or pay twice. It refuses unless the environment label is exactly "sandbox", and the host is fixed
// to the Square sandbox host: no option can point it at production (AGENTS rule 4).
// It writes nothing to our database. The order's real status still moves only through Square's signed
// webhook and the reconcile poll, which read the payment back from Square (AGENTS rule 5).
import { SQUARE_SANDBOX_BASE_URL } from './client';
import { SquareAdapterError } from './types';

/** Square's published sandbox test nonces. */
export const SANDBOX_NONCE_OK = 'cnon:card-nonce-ok';
export const SANDBOX_NONCE_DECLINED = 'cnon:card-nonce-declined';
export const SQUARE_SANDBOX_HOST = 'connect.squareupsandbox.com';
const SQUARE_VERSION = '2025-01-23';

export type SandboxFetch = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;

export interface SandboxPayDeps {
  fetch: SandboxFetch;
  accessToken: string;
  locationId: string;
  /** Must be exactly "sandbox". */
  environment: string;
  /** One line per step, for the live script's SIMULATED log. Never given a token or a phone number. */
  log?: ((line: string) => void) | undefined;
}

export interface SandboxPayInput {
  /** Our order ID: the keys are derived from it. */
  orderId: string;
  squareOrderId: string;
  totalMinor: number;
  currency: string;
  nonce: string;
  /** Part of both keys. The same attempt never opens or pays twice. */
  attempt: string;
}

export type SandboxPayResult = { httpOk: boolean; opened: boolean; at: number; payment: Json | undefined; detail: string };

/** The stable keys for one order and attempt. CreatePayment caps its key at 45 characters (SPEC 2.9). */
export function sandboxPayKeys(orderId: string, attempt: string): { open: string; pay: string } {
  return { open: `open-${orderId.slice(-24)}-${attempt}`, pay: `pay-${orderId.slice(-24)}-${attempt}`.slice(0, 45) };
}

const short = (id: unknown) => (typeof id === 'string' && id.length > 8 ? `${id.slice(0, 4)}...${id.slice(-4)}` : String(id));

export async function sandboxPay(deps: SandboxPayDeps, input: SandboxPayInput): Promise<SandboxPayResult> {
  if (deps.environment !== 'sandbox' || new URL(SQUARE_SANDBOX_BASE_URL).host !== SQUARE_SANDBOX_HOST) {
    throw new SquareAdapterError('ENVIRONMENT_MISMATCH', 'The sandbox payment runs only when SQUARE_ENVIRONMENT is exactly "sandbox".');
  }
  const base = SQUARE_SANDBOX_BASE_URL.replace(/\/+$/, '');
  const sim = (m: string) => deps.log?.(`SIMULATED ${m}`);
  const headers = { Authorization: `Bearer ${deps.accessToken}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION };
  const errs = (b: Json) => (b.errors as Json[] | undefined)?.map((e) => `${String(e.code)} ${String(e.field ?? '')} ${String(e.detail ?? '').slice(0, 160)}`).join(' | ') ?? '';
  const read = async (r: Response): Promise<Json> => { try { return (await r.json()) as Json; } catch { return {}; } };
  const keys = sandboxPayKeys(input.orderId, input.attempt);
  const orderUrl = `${base}/v2/orders/${encodeURIComponent(input.squareOrderId)}`;

  const sqOrder = (await read(await deps.fetch(orderUrl, { method: 'GET', headers, redirect: 'error' }))).order as Json | undefined;
  const total = (sqOrder?.total_money as Json | undefined)?.amount;
  sim(`Square order ${short(input.squareOrderId)} state ${String(sqOrder?.state)} version ${String(sqOrder?.version)} total ${String(total)}`);
  if (sqOrder?.state === 'DRAFT') {
    const up = await deps.fetch(orderUrl, { method: 'PUT', redirect: 'error', headers,
      body: JSON.stringify({ idempotency_key: keys.open, order: { location_id: deps.locationId, version: sqOrder.version, state: 'OPEN' } }) });
    const upBody = await read(up);
    const upOrder = upBody.order as Json | undefined;
    sim(`UpdateOrder state OPEN: HTTP ${up.status} ${up.ok ? `state ${String(upOrder?.state)} version ${String(upOrder?.version)}` : errs(upBody)}`);
    if (!up.ok || upOrder?.state !== 'OPEN') return { httpOk: false, opened: false, at: Date.now(), payment: undefined, detail: `UpdateOrder refused: HTTP ${up.status} ${errs(upBody)}` };
  } else if (sqOrder?.state !== 'OPEN') {
    return { httpOk: false, opened: false, at: Date.now(), payment: undefined, detail: `Square order is ${String(sqOrder?.state)}, not payable` };
  }
  const at = Date.now();
  const payRes = await deps.fetch(`${base}/v2/payments`, { method: 'POST', redirect: 'error', headers,
    body: JSON.stringify({ source_id: input.nonce, idempotency_key: keys.pay, order_id: input.squareOrderId,
      amount_money: { amount: input.totalMinor, currency: input.currency }, location_id: deps.locationId, autocomplete: true }) });
  const payBody = await read(payRes);
  const payment = payBody.payment as Json | undefined;
  const amount = payment?.amount_money as Json | undefined;
  sim(`CreatePayment: HTTP ${payRes.status} ${payRes.ok ? `payment ${short(payment?.id)} ${String(payment?.status)} ${String(amount?.amount)} ${String(amount?.currency)}` : `${errs(payBody)}${payment ? ` payment ${short(payment.id)} ${String(payment.status)}` : ''}`}`);
  return { httpOk: payRes.ok, opened: true, at, payment, detail: `HTTP ${payRes.status} ${errs(payBody)}`.trim() };
}
