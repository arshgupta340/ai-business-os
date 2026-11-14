import { BusinessIdSchema, CartSchema, CurrencySchema, IdempotencyKeySchema, IsoDateTimeSchema, MinorAmountSchema, OrderIdSchema, QUOTE_EXPIRY_MS, QuoteSchema, cartHash, hashCanonical, sha256Hex } from '@abos/contracts';
import type { QuoteLine, ToolFailureReason } from '@abos/contracts';
import { BillCheckoutError } from './types';
import type { Bill, BillDeps, CheckoutInput, CheckoutResult, QuoteInput, QuoteResult, ResumeCheckoutInput } from './types';
export * from './types';
export { renderBillHtml } from './render';
export { billPlugin, rewriteBillUrl } from './plugin';

function minor(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Invalid money amount.');
  return Number(value);
}
function amount(value: number): bigint { return BigInt(MinorAmountSchema.parse(value)); }
const failure = (code: ToolFailureReason): QuoteResult => ({ ok: false, reason: code, code });

/** Local authority for demo bills only. All tax is exclusive. Round half up once on the order subtotal:
 * taxMinor = floor((subtotalMinor * taxRateBps + 5000) / 10000). No floating point money operations. */
export async function quoteLocal(deps: Pick<BillDeps, 'catalog' | 'facts' | 'now'>, input: QuoteInput): Promise<QuoteResult> {
  const parsed = CartSchema.safeParse({ lines: input.lines });
  if (!BusinessIdSchema.safeParse(input.businessId).success || !parsed.success) return failure('VALIDATION_FAILED');
  try {
    const [rows, rate] = await Promise.all([deps.catalog.list(input.businessId), deps.facts.taxRateBps(input.businessId)]);
    if (rate === undefined) return failure('INTEGRATION_UNAVAILABLE');
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000) return failure('VALIDATION_FAILED');
    const lines: QuoteLine[] = [];
    let subtotal = 0n;
    for (const line of parsed.data.lines) {
      const row = rows.find((r) => r.businessId === input.businessId && r.catalogItemId === line.catalogItemId && r.id === line.variationId);
      if (!row || !row.available) return failure('ITEM_UNAVAILABLE');
      if (!CurrencySchema.safeParse(row.currency).success) return failure('VALIDATION_FAILED');
      if (new Set(line.modifierIds).size !== line.modifierIds.length) return failure('VALIDATION_FAILED');
      for (const list of row.modifierLists) {
        if (list.selectionType === 'SINGLE' && list.modifiers.filter((m) => line.modifierIds.includes(m.id)).length > 1) return failure('VALIDATION_FAILED');
      }
      const modifiers: QuoteLine['modifiers'] = [];
      let unit = amount(row.priceMinor);
      for (const id of line.modifierIds) {
        const modifier = row.modifierLists.flatMap((list) => list.modifiers).find((m) => m.id === id);
        if (!modifier) return failure('ITEM_UNAVAILABLE');
        unit += amount(modifier.priceMinor);
        modifiers.push({ modifierId: id, name: modifier.name, priceMinor: modifier.priceMinor });
      }
      const total = unit * BigInt(line.quantity);
      subtotal += total;
      lines.push({ variationId: row.id, name: row.name, quantity: line.quantity, unitPriceMinor: minor(amount(row.priceMinor)), modifiers, lineTotalMinor: minor(total) });
    }
    const tax = (subtotal * BigInt(rate) + 5000n) / 10000n;
    const now = deps.now();
    const hash = await cartHash(parsed.data);
    const quote = QuoteSchema.parse({ quoteId: `qte_${await sha256Hex(`${input.businessId}:${hash}:${now.toISOString()}`)}`, cartHash: hash,
      subtotalMinor: minor(subtotal), taxMinor: minor(tax), totalMinor: minor(subtotal + tax), currency: 'USD', lines,
      quotedAt: now.toISOString(), expiresAt: new Date(now.getTime() + QUOTE_EXPIRY_MS).toISOString() });
    return { ok: true, quote };
  } catch (error: unknown) {
    if (error instanceof RangeError || (error instanceof Error && error.name === 'ZodError')) return failure('VALIDATION_FAILED');
    return failure('INTEGRATION_UNAVAILABLE');
  }
}

export function createBillCheckoutProvider(deps: BillDeps) {
  const base = new URL(deps.publicBaseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) throw new Error('A public HTTP origin is required.');
  if (!Number.isSafeInteger(deps.billTtlMs) || deps.billTtlMs <= 0) throw new Error('A positive bill lifetime is required.');
  const result = (bill: Bill): CheckoutResult => ({ billId: bill.billId, squareOrderId: bill.billId, paymentLinkId: bill.billId, url: `${base.origin}/bill/${bill.token}` });
  const verify = (bill: Bill, input: ResumeCheckoutInput) => {
    if (bill.quote.totalMinor !== input.approvedTotalMinor || bill.quote.currency !== input.currency) throw new BillCheckoutError('INVALID_STATE', 'total_mismatch', input.idempotencyKey);
    if (!Number.isFinite(Date.parse(bill.expiresAt)) || Date.parse(bill.expiresAt) <= deps.now().getTime()) throw new BillCheckoutError('INVALID_STATE', 'created_unverified', input.idempotencyKey);
  };
  return {
    quoteLocal: (input: QuoteInput) => quoteLocal(deps, input),
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      const key = input.idempotencyKey;
      let outcome: BillCheckoutError['outcome'] = 'not_created';
      try {
        if (!IdempotencyKeySchema.safeParse(key).success || !CurrencySchema.safeParse(input.currency).success || !MinorAmountSchema.safeParse(input.approvedTotalMinor).success) throw new BillCheckoutError('VALIDATION_FAILED', outcome, key);
        const source = 'order' in input ? { businessId: input.order.businessId, orderId: input.order.id, lines: input.order.cart.lines, pickupAt: input.order.fulfillment.pickupAt } : input;
        if (!BusinessIdSchema.safeParse(source.businessId).success || !OrderIdSchema.safeParse(source.orderId).success || !CartSchema.safeParse({ lines: source.lines }).success || (source.pickupAt !== undefined && !IsoDateTimeSchema.safeParse(source.pickupAt).success)) throw new BillCheckoutError('VALIDATION_FAILED', outcome, key);
        const materialHash = await hashCanonical({ businessId: source.businessId, orderId: source.orderId, cartHash: await cartHash({ lines: source.lines }), pickupAt: source.pickupAt, totalMinor: input.approvedTotalMinor, currency: input.currency });
        const checkExisting = (bill: Bill) => {
          outcome = 'created_unverified';
          if (bill.materialHash !== materialHash) throw new BillCheckoutError('PAYLOAD_HASH_MISMATCH', outcome, key);
          verify(bill, input);
          return bill;
        };
        let bill = await deps.store.findByKey(key);
        if (bill) bill = checkExisting(bill);
        else {
          const priced = await quoteLocal(deps, source);
          if (!priced.ok) throw new BillCheckoutError(priced.code, outcome, key);
          if (priced.quote.totalMinor !== input.approvedTotalMinor) throw new BillCheckoutError('INVALID_STATE', 'total_mismatch', key);
          const business = await deps.business.load(source.businessId);
          const bytes = deps.randomBytes(32);
          if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new BillCheckoutError('INTERNAL', outcome, key);
          const token = Buffer.from(bytes).toString('base64url');
          const now = deps.now();
          const candidate: Bill = { billId: `bill_${await sha256Hex(key)}`, businessId: source.businessId, orderId: source.orderId, idempotencyKey: key, materialHash,
            token, tokenHash: await sha256Hex(token), businessName: business.name, pickupAt: source.pickupAt,
            quote: priced.quote, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + deps.billTtlMs).toISOString() };
          outcome = 'unknown';
          bill = checkExisting(await deps.store.putIfAbsent(candidate));
        }
        const link = result(bill);
        await input.onLinkCreated?.(link);
        return link;
      } catch (error: unknown) {
        if (error instanceof BillCheckoutError) throw error;
        throw new BillCheckoutError('INTEGRATION_UNAVAILABLE', outcome, key);
      }
    },
    async resumeCheckout(input: ResumeCheckoutInput): Promise<CheckoutResult> {
      try {
        if (!CurrencySchema.safeParse(input.currency).success || !MinorAmountSchema.safeParse(input.approvedTotalMinor).success || (input.idempotencyKey !== undefined && !IdempotencyKeySchema.safeParse(input.idempotencyKey).success)) throw new BillCheckoutError('VALIDATION_FAILED', 'not_created', input.idempotencyKey);
        const bill = input.idempotencyKey ? await deps.store.findByKey(input.idempotencyKey) : input.squareOrderId ? await deps.store.findById(input.squareOrderId) : undefined;
        if (!bill) throw new BillCheckoutError('NOT_FOUND', 'not_created', input.idempotencyKey);
        if ((input.squareOrderId && input.squareOrderId !== bill.billId) || (input.paymentLinkId && input.paymentLinkId !== bill.billId)) throw new BillCheckoutError('PAYLOAD_HASH_MISMATCH', 'created_unverified', input.idempotencyKey);
        verify(bill, input);
        return result(bill);
      } catch (error: unknown) {
        if (error instanceof BillCheckoutError) throw error;
        throw new BillCheckoutError('INTEGRATION_UNAVAILABLE', 'created_unverified', input.idempotencyKey);
      }
    },
  };
}
