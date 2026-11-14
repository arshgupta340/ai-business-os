// The Square adapter itself (task B-12). Internal module: production code goes through index.ts
// (createSquareAdapter, sandbox clients only) and tests through testing.ts. Do not import this file elsewhere.
// Every money value comes from Square; this file never prices anything.
// Reference: scripts/spikes/square/src (lifted and made injectable, not imported).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SquareError, type Square } from 'square';
import { z } from 'zod';
import {
  CatalogModifierListSchema,
  ID_PREFIXES,
  QUOTE_EXPIRY_MS,
  QuoteSchema,
  cartHash,
  newId,
  type Cart,
  type CatalogModifier,
  type CatalogModifierList,
  type Currency,
  type QuoteLine,
  type QuoteLineModifier,
  type ToolFailureReason,
} from '@abos/contracts';
import {
  SquareAdapterError,
  SquareCheckoutError,
  type CheckoutInput,
  type CheckoutOutcome,
  type CheckoutResult,
  type Database,
  type PaymentMismatchField,
  type PaymentVerification,
  type QuoteFailure,
  type QuoteResult,
  type ResumeCheckoutInput,
  type SquareAdapter,
  type SquareClient,
  type VerifyPaymentInput,
  type WebhookSignatureInput,
} from './types';

/** The catalog object types read by a sync. Variations also arrive nested inside their items. */
export const CATALOG_SYNC_TYPES = 'ITEM,ITEM_VARIATION,MODIFIER_LIST,TAX';

/** CreatePaymentLink caps the idempotency key at 192 characters (SPEC 2.9). */
export const PAYMENT_LINK_KEY_MAX = 192;

/** `catalog_items.price_minor` is a Postgres integer. Larger prices are not cached. */
export const CATALOG_PRICE_MAX = 2147483647n;

/** Quote amounts must convert to a JavaScript number without loss. */
const QUOTE_AMOUNT_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** How far back the ListPayments fallback looks when the order has no creation time. */
const PAYMENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const CURRENCY: Currency = 'USD';

/** The tax choice used in both the quote and the payment link so their totals match (SPEC 4). */
const PRICING_OPTIONS: Square.OrderPricingOptions = { autoApplyTaxes: true };

export interface AdapterOptions {
  locationId: string;
  now(): Date;
}

// ---------- provider error mapping ----------

/** Maps any provider failure to a typed error with a fixed message. The raw error is dropped. */
function providerError(operation: string, error: unknown): SquareAdapterError {
  if (error instanceof SquareAdapterError) return error;
  const status = error instanceof SquareError ? error.statusCode : undefined;
  if (status === 429) return new SquareAdapterError('RATE_LIMITED', `Square rate limited the ${operation} request.`);
  if (status === 404) return new SquareAdapterError('NOT_FOUND', `Square did not find the object for the ${operation} request.`);
  return new SquareAdapterError('INTEGRATION_UNAVAILABLE', `The Square ${operation} request failed.`);
}

/** One provider call, mapped to a typed error on failure. */
async function call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw providerError(operation, error);
  }
}

/** The first page request and every later page, mapped to a typed error on any failure. */
async function iterate<T>(operation: string, fn: () => Promise<AsyncIterable<T>>, visit: (value: T) => void): Promise<void> {
  try {
    for await (const value of await fn()) visit(value);
  } catch (error) {
    throw providerError(operation, error);
  }
}

/**
 * Whether a failed CreatePaymentLink definitely did nothing. Only a definite 4xx answer proves that.
 * A timeout, a network error, a 408 or a 5xx may have created the link on Square's side.
 */
function createOutcome(error: unknown): Extract<CheckoutOutcome, 'not_created' | 'unknown'> {
  if (error instanceof SquareError && error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 408) {
    return 'not_created';
  }
  return 'unknown';
}

// ---------- the adapter ----------

export function buildSquareAdapter(client: SquareClient, { locationId, now }: AdapterOptions): SquareAdapter {
  if (!locationId) throw new SquareAdapterError('VALIDATION_FAILED', 'A Square location ID is required.');

  // ---------- 1. catalog sync ----------

  async function syncCatalog(db: Database, businessId: string): Promise<number> {
    // Read every page before touching the database, so a failed read leaves the cache alone.
    const objects: Square.CatalogObject[] = [];
    await iterate('catalog list', () => client.catalog.list({ types: CATALOG_SYNC_TYPES }), (object) => objects.push(object));

    const rows = catalogRows(objects, locationId);
    const syncedAt = now().toISOString();

    return db.transaction(async (tx) => {
      for (const row of rows) {
        await tx.query(UPSERT_CATALOG_ITEM, [
          businessId,
          row.squareItemId,
          row.squareVariationId,
          row.squareItemVersion,
          row.squareVariationVersion,
          row.itemName,
          row.description,
          row.variationName,
          row.priceMinor,
          CURRENCY,
          JSON.stringify(row.modifierLists),
          row.available,
          syncedAt,
        ]);
      }
      // Variations Square no longer returns, or that cannot be cached, stay in the table marked unavailable.
      await tx.query(MARK_MISSING_UNAVAILABLE, [businessId, rows.map((row) => row.squareVariationId), syncedAt]);
      return rows.length;
    });
  }

  // ---------- 2. quote ----------

  async function quote(db: Database, businessId: string, cart: Cart): Promise<QuoteResult> {
    const unavailable = await findUnavailable(db, businessId, cart);
    if (unavailable) return failure('ITEM_UNAVAILABLE', unavailable);

    let response: Square.CalculateOrderResponse;
    try {
      response = await client.orders.calculate({ order: orderFromCart(cart, locationId) });
    } catch {
      return failure('INTEGRATION_UNAVAILABLE', 'Square could not price the order.');
    }

    const incomplete = failure('INTEGRATION_UNAVAILABLE', 'Square returned an incomplete quote.');
    const priced = response.order;
    const lines = priced?.lineItems ?? [];
    if (!priced || lines.length !== cart.lines.length) return incomplete;
    const totalMinor = quoteMinor(priced.totalMoney);
    const taxMinor = priced.totalTaxMoney === undefined ? 0 : quoteMinor(priced.totalTaxMoney);
    if (totalMinor === null || taxMinor === null) return incomplete;

    const quoteLines: QuoteLine[] = [];
    let subtotalMinor = 0;
    for (const line of lines) {
      const gross = quoteMinor(line.grossSalesMoney);
      const lineTotal = quoteMinor(line.totalMoney);
      const unit = quoteMinor(line.basePriceMoney);
      const quantity = /^[1-9]\d*$/.test(line.quantity) ? Number(line.quantity) : null;
      if (!line.catalogObjectId || gross === null || lineTotal === null || unit === null || quantity === null) return incomplete;
      // Square has no order subtotal field: the subtotal is the sum of Square's own line gross sales.
      subtotalMinor += gross;
      const modifiers: QuoteLineModifier[] = [];
      for (const modifier of line.modifiers ?? []) {
        const price = quoteMinor(modifier.basePriceMoney);
        if (!modifier.catalogObjectId || price === null) return incomplete;
        modifiers.push({ modifierId: modifier.catalogObjectId, name: modifier.name ?? '', priceMinor: price });
      }
      quoteLines.push({ variationId: line.catalogObjectId, name: line.name ?? '', quantity, unitPriceMinor: unit, modifiers, lineTotalMinor: lineTotal });
    }

    const quotedAt = now();
    // SPEC 2.9: the total is whatever Square returns; it is not checked against subtotal plus tax.
    const parsed = QuoteSchema.safeParse({
      quoteId: newId(ID_PREFIXES.quote),
      cartHash: await cartHash(cart),
      subtotalMinor,
      taxMinor,
      totalMinor,
      currency: CURRENCY,
      lines: quoteLines,
      quotedAt: quotedAt.toISOString(),
      expiresAt: new Date(quotedAt.getTime() + QUOTE_EXPIRY_MS).toISOString(),
    });
    if (!parsed.success) return failure('INTEGRATION_UNAVAILABLE', 'Square returned a quote that does not fit the contract.');
    return { ok: true, quote: parsed.data };
  }

  // ---------- 3. checkout ----------

  /** FLOWS B19: read the order back and compare its total with the approved total. */
  async function verifyLinkTotal(
    link: CheckoutResult,
    approvedTotalMinor: number,
    currency: Currency,
    idempotencyKey: string | undefined,
  ): Promise<CheckoutResult> {
    const ids = { squareOrderId: link.squareOrderId, paymentLinkId: link.paymentLinkId, idempotencyKey };
    let read: Square.GetOrderResponse;
    try {
      read = await client.orders.get({ orderId: link.squareOrderId });
    } catch (error) {
      const mapped = providerError('order read', error);
      throw new SquareCheckoutError(mapped.code, 'The payment link exists but Square did not return its order total. Withhold the link and resume the checkout.', {
        ...ids, outcome: 'created_unverified',
      });
    }
    const squareTotal = read.order?.totalMoney;
    const amount = squareTotal?.amount;
    const matches = typeof amount === 'bigint' && amount === BigInt(approvedTotalMinor) && squareTotal?.currency === currency;
    if (!matches) {
      throw new SquareCheckoutError(
        'INVALID_STATE',
        'The Square order total does not match the approved total. Move the order to RECOVERY_REQUIRED and do not send the link.',
        { ...ids, outcome: 'total_mismatch', orderState: 'RECOVERY_REQUIRED' },
      );
    }
    return link;
  }

  async function createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const { idempotencyKey, approvedTotalMinor, currency, onLinkCreated } = input;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > PAYMENT_LINK_KEY_MAX) {
      throw new SquareCheckoutError('VALIDATION_FAILED', `The idempotency key must be 1 to ${PAYMENT_LINK_KEY_MAX} characters.`, {
        outcome: 'not_created', idempotencyKey,
      });
    }
    if (input.order.locationId !== locationId) {
      throw new SquareCheckoutError('VALIDATION_FAILED', 'The order location does not match the configured Square location.', {
        outcome: 'not_created', idempotencyKey,
      });
    }
    // Never send order.taxes alongside automatic taxes, or tax is applied twice (SPEC 4).
    const { taxes: _taxes, ...rest } = input.order;
    const order: Square.Order = { ...rest, pricingOptions: { ...PRICING_OPTIONS } };

    // One CreatePaymentLink call. It creates the Square order, so CreateOrder is never called.
    let response: Square.CreatePaymentLinkResponse;
    try {
      response = await client.checkout.paymentLinks.create({ idempotencyKey, order });
    } catch (error) {
      const outcome = createOutcome(error);
      const mapped = providerError('payment link create', error);
      throw new SquareCheckoutError(
        mapped.code,
        outcome === 'not_created'
          ? 'Square refused to create the payment link. It is safe to retry with the same key.'
          : 'The payment link create did not return. It may exist: review the checkout before any retry.',
        { outcome, idempotencyKey },
      );
    }

    const link = response.paymentLink;
    if (!link?.id || !link.url || !link.orderId) {
      const known = { ...(link?.orderId ? { squareOrderId: link.orderId } : {}), ...(link?.id ? { paymentLinkId: link.id } : {}) };
      throw new SquareCheckoutError('INTEGRATION_UNAVAILABLE', 'Square returned a payment link without an ID, URL or order ID. Review the checkout.', {
        ...known, outcome: link?.orderId || link?.id ? 'created_unverified' : 'unknown', idempotencyKey,
      });
    }
    const created: CheckoutResult = { squareOrderId: link.orderId, paymentLinkId: link.id, url: link.url };

    // Let the caller persist the IDs before anything else can fail (FLOWS B18).
    if (onLinkCreated) {
      try {
        await onLinkCreated({ ...created });
      } catch {
        throw new SquareCheckoutError('INTERNAL', 'The payment link exists but the caller could not record it. Withhold the link and resume the checkout.', {
          squareOrderId: created.squareOrderId, paymentLinkId: created.paymentLinkId, outcome: 'created_unverified', idempotencyKey,
        });
      }
    }
    return verifyLinkTotal(created, approvedTotalMinor, currency, idempotencyKey);
  }

  async function resumeCheckout(input: ResumeCheckoutInput): Promise<CheckoutResult> {
    const { squareOrderId, paymentLinkId, approvedTotalMinor, currency, idempotencyKey } = input;
    const known = { squareOrderId, ...(paymentLinkId ? { paymentLinkId } : {}), idempotencyKey };
    let link: Square.PaymentLink | undefined;
    try {
      if (paymentLinkId) {
        link = (await call('payment link read', () => client.checkout.paymentLinks.get({ id: paymentLinkId }))).paymentLink;
      } else {
        await iterate('payment link list', () => client.checkout.paymentLinks.list({ limit: 100 }), (candidate) => {
          if (!link && candidate.orderId === squareOrderId) link = candidate;
        });
      }
    } catch (error) {
      const mapped = providerError('payment link read', error);
      if (mapped.code === 'NOT_FOUND') {
        throw new SquareCheckoutError('NOT_FOUND', 'Square has no payment link for this checkout. Review the checkout.', { ...known, outcome: 'unknown' });
      }
      throw new SquareCheckoutError(mapped.code, 'Square did not return the payment link. Withhold the link and try the resume again.', {
        ...known, outcome: 'created_unverified',
      });
    }
    if (!link) {
      throw new SquareCheckoutError('NOT_FOUND', 'Square has no payment link for this checkout. Review the checkout.', { ...known, outcome: 'unknown' });
    }
    if (!link.id || !link.url || link.orderId !== squareOrderId || (paymentLinkId && link.id !== paymentLinkId)) {
      throw new SquareCheckoutError('INVALID_STATE', 'The Square payment link does not belong to this order. Review the checkout.', {
        ...known, outcome: 'created_unverified',
      });
    }
    return verifyLinkTotal({ squareOrderId, paymentLinkId: link.id, url: link.url }, approvedTotalMinor, currency, idempotencyKey);
  }

  // ---------- 4. payments ----------

  async function verifyPayment({ paymentId, expected }: VerifyPaymentInput): Promise<PaymentVerification> {
    const { payment } = await call('payment read', () => client.payments.get({ paymentId }));
    if (!payment) return { verified: false, failedFields: ['paymentId'] };
    return checkPayment(paymentId, payment, expected);
  }

  async function findPaymentForOrder(squareOrderId: string): Promise<string[]> {
    const { order } = await call('order read', () => client.orders.get({ orderId: squareOrderId }));
    const fromTenders = unique((order?.tenders ?? []).map((tender) => tender.paymentId ?? tender.id));
    if (fromTenders.length > 0) return fromTenders;

    // ListPayments has no order filter: list the location's recent payments and filter here.
    const since = order?.createdAt ?? new Date(now().getTime() - PAYMENT_LOOKBACK_MS).toISOString();
    const found: (string | undefined)[] = [];
    await iterate('payment list', () => client.payments.list({ locationId, beginTime: since, sortOrder: 'DESC', limit: 100 }), (payment) => {
      if (payment.orderId === squareOrderId) found.push(payment.id);
    });
    return unique(found);
  }

  return { syncCatalog, quote, createCheckout, resumeCheckout, verifyPayment, findPaymentForOrder, verifyWebhookSignature };
}

// ---------- helpers that need no client ----------

/**
 * The Square order for a cart, priced by catalog IDs only: no prices and no taxes are sent, and
 * Square applies the catalog taxes itself. The executor should build the checkout order with this too,
 * so the payment link prices the same order the quote did.
 */
export function orderFromCart(cart: Cart, locationId: string): Square.Order {
  return {
    locationId,
    lineItems: cart.lines.map((line) => ({
      catalogObjectId: line.variationId,
      quantity: String(line.quantity),
      modifiers: line.modifierIds.map((id) => ({ catalogObjectId: id, quantity: '1' })),
    })),
    pricingOptions: { ...PRICING_OPTIONS },
  };
}

/**
 * Square webhook check: HMAC-SHA256 over the notification URL followed by the raw body, keyed with the
 * subscription signature key, base64-encoded, compared in constant time. The SDK helper is not used
 * because its comparison is not constant time.
 */
export function verifyWebhookSignature({ rawBody, signatureHeader, notificationUrl, signatureKey }: WebhookSignatureInput): boolean {
  if (!signatureHeader || !signatureKey || !notificationUrl) return false;
  const expected = Buffer.from(
    createHmac('sha256', signatureKey).update(notificationUrl, 'utf8').update(rawBody).digest('base64'),
    'utf8',
  );
  const received = Buffer.from(signatureHeader.trim(), 'utf8');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * SPEC 4: paid only when COMPLETED, not refunded, and order ID, amount, currency and location all match.
 * One payment must cover the order: split tenders are not added up, so each partial payment fails on
 * amountMinor and the order goes to review. The amount is amount_money, which excludes any tip.
 */
export function checkPayment(paymentId: string, payment: Square.Payment, expected: VerifyPaymentInput['expected']): PaymentVerification {
  const failed: PaymentMismatchField[] = [];
  if (payment.id !== paymentId) failed.push('paymentId');
  if (payment.status !== 'COMPLETED') failed.push('status');
  // Any refund, full or partial, fails closed. Nothing is subtracted to make another total.
  const refunded = payment.refundedMoney?.amount;
  if ((refunded !== undefined && refunded !== null && refunded !== 0n) || (payment.refundIds?.length ?? 0) > 0) failed.push('refunded');
  if (payment.orderId !== expected.squareOrderId) failed.push('squareOrderId');
  const amount = payment.amountMoney?.amount;
  if (typeof amount !== 'bigint' || !Number.isSafeInteger(expected.amountMinor) || amount !== BigInt(expected.amountMinor)) failed.push('amountMinor');
  if (payment.amountMoney?.currency !== expected.currency) failed.push('currency');
  if (payment.locationId !== expected.locationId) failed.push('locationId');
  return failed.length === 0 ? { verified: true, failedFields: [] } : { verified: false, failedFields: failed };
}

function failure(reason: ToolFailureReason, message: string): QuoteFailure {
  return { ok: false, reason, code: reason, message };
}

/** A USD amount from 0 to max, checked on the original bigint before it becomes a number. */
function usdMinor(money: Square.Money | undefined, max: bigint): number | null {
  if (!money || money.currency !== CURRENCY) return null;
  const amount = money.amount;
  if (typeof amount !== 'bigint' || amount < 0n || amount > max) return null;
  return Number(amount);
}

const quoteMinor = (money: Square.Money | undefined): number | null => usdMinor(money, QUOTE_AMOUNT_MAX);
const catalogMinor = (money: Square.Money | undefined): number | null => usdMinor(money, CATALOG_PRICE_MAX);

function unique(ids: (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)));
}

// ---------- catalog mapping ----------

const UPSERT_CATALOG_ITEM = `insert into catalog_items (
  business_id, square_item_id, square_variation_id, square_item_version, square_variation_version,
  item_name, description, variation_name, price_minor, currency, modifier_lists, is_available, synced_at
) values ($1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::timestamptz)
on conflict (business_id, square_variation_id) do update set
  square_item_id = excluded.square_item_id,
  square_item_version = excluded.square_item_version,
  square_variation_version = excluded.square_variation_version,
  item_name = excluded.item_name,
  description = excluded.description,
  variation_name = excluded.variation_name,
  price_minor = excluded.price_minor,
  currency = excluded.currency,
  modifier_lists = excluded.modifier_lists,
  is_available = excluded.is_available,
  synced_at = excluded.synced_at`;

const MARK_MISSING_UNAVAILABLE = `update catalog_items set is_available = false, synced_at = $3::timestamptz
where business_id = $1 and not (square_variation_id = any($2::text[]))`;

const SELECT_CART_ROWS = `select square_item_id, square_variation_id, is_available, modifier_lists
from catalog_items where business_id = $1 and square_variation_id = any($2::text[])`;

export interface CatalogRowInput {
  squareItemId: string;
  squareVariationId: string;
  squareItemVersion: string;
  squareVariationVersion: string;
  itemName: string;
  description: string | null;
  variationName: string;
  priceMinor: number;
  modifierLists: CatalogModifierList[];
  available: boolean;
}

type Presence = Pick<Square.CatalogObjectBase, 'isDeleted' | 'presentAtAllLocations' | 'presentAtLocationIds' | 'absentAtLocationIds'>;

/** Whether a catalog object is live at this location. Square treats a missing presentAtAllLocations as true. */
function presentAt(object: Presence, locationId: string): boolean {
  if (object.isDeleted) return false;
  if (object.presentAtAllLocations === false) return (object.presentAtLocationIds ?? []).includes(locationId);
  return !(object.absentAtLocationIds ?? []).includes(locationId);
}

/**
 * A modifier list as this location sees it: only modifiers present here, not sold out here, with
 * this location's price override applied and a valid USD price. Null when the list is absent here.
 */
function modifierListAt(object: Square.CatalogObject.ModifierList, locationId: string): CatalogModifierList | null {
  if (!presentAt(object, locationId)) return null;
  const modifiers: CatalogModifier[] = [];
  for (const entry of object.modifierListData?.modifiers ?? []) {
    if (entry.type !== 'MODIFIER' || !presentAt(entry, locationId)) continue;
    const data = entry.modifierData;
    const override = (data?.locationOverrides ?? []).find((o) => o.locationId === locationId);
    if (override?.soldOut === true) continue;
    // Missing or non-USD money is not treated as free: the modifier is left out.
    const priceMinor = catalogMinor(override?.priceMoney ?? data?.priceMoney);
    if (priceMinor === null) continue;
    modifiers.push({ id: entry.id, name: data?.name ?? '', priceMinor });
  }
  const list = CatalogModifierListSchema.safeParse({
    id: object.id,
    name: object.modifierListData?.name ?? '',
    selectionType: object.modifierListData?.selectionType ?? 'SINGLE',
    modifiers,
  });
  return list.success ? list.data : null;
}

/**
 * Maps ListCatalog objects to one row per fixed-price variation whose USD price fits the price column.
 * Variations that cannot be cached are left out, so the sync marks any earlier row for them unavailable.
 */
export function catalogRows(objects: Square.CatalogObject[], locationId: string): CatalogRowInput[] {
  const modifierLists = new Map<string, CatalogModifierList>();
  const items = new Map<string, Square.CatalogObject.Item>();
  const variations = new Map<string, Square.CatalogObject.ItemVariation>();

  for (const object of objects) {
    if (object.type === 'MODIFIER_LIST') {
      const list = modifierListAt(object, locationId);
      if (list) modifierLists.set(list.id, list);
    } else if (object.type === 'ITEM') {
      items.set(object.id, object);
      for (const nested of object.itemData?.variations ?? []) {
        if (nested.type === 'ITEM_VARIATION') variations.set(nested.id, nested);
      }
    } else if (object.type === 'ITEM_VARIATION' && !variations.has(object.id)) {
      variations.set(object.id, object);
    }
    // TAX objects are read so Square's tax setup is part of the same snapshot, but taxes are never
    // cached or sent: CalculateOrder applies them (auto_apply_taxes).
  }

  const rows: CatalogRowInput[] = [];
  for (const variation of variations.values()) {
    const data = variation.itemVariationData;
    const item = data?.itemId ? items.get(data.itemId) : undefined;
    if (!data || !item?.itemData) continue;
    const override = (data.locationOverrides ?? []).find((o) => o.locationId === locationId);
    const pricingType = override?.pricingType ?? data.pricingType;
    if (pricingType === 'VARIABLE_PRICING') continue;
    const priceMinor = catalogMinor(override?.priceMoney ?? data.priceMoney);
    if (priceMinor === null) continue;

    const available = presentAt(item, locationId)
      && presentAt(variation, locationId)
      && item.itemData.isArchived !== true
      && data.sellable !== false
      && override?.soldOut !== true;

    const lists = (item.itemData.modifierListInfo ?? [])
      .filter((info) => info.enabled !== false)
      .map((info) => modifierLists.get(info.modifierListId))
      .filter((list): list is CatalogModifierList => list !== undefined);

    rows.push({
      squareItemId: item.id,
      squareVariationId: variation.id,
      squareItemVersion: (item.version ?? 0n).toString(),
      squareVariationVersion: (variation.version ?? 0n).toString(),
      itemName: item.itemData.name ?? '',
      description: item.itemData.description ?? null,
      variationName: data.name ?? '',
      priceMinor,
      modifierLists: lists,
      available,
    });
  }
  return rows;
}

// ---------- cart validation ----------

const CartRowSchema = z.object({
  square_item_id: z.string(),
  square_variation_id: z.string(),
  is_available: z.boolean(),
  modifier_lists: z.preprocess(
    (value) => (typeof value === 'string' ? JSON.parse(value) : value),
    z.array(CatalogModifierListSchema),
  ),
});

/** Returns a reason when any line names an unknown or unavailable variation or modifier, otherwise null. */
async function findUnavailable(db: Database, businessId: string, cart: Cart): Promise<string | null> {
  const variationIds = Array.from(new Set(cart.lines.map((line) => line.variationId)));
  const { rows } = await db.query(SELECT_CART_ROWS, [businessId, variationIds]);
  const byVariation = new Map<string, z.infer<typeof CartRowSchema>>();
  for (const raw of rows) {
    const row = CartRowSchema.safeParse(raw);
    if (row.success) byVariation.set(row.data.square_variation_id, row.data);
  }
  for (const line of cart.lines) {
    const row = byVariation.get(line.variationId);
    if (!row || !row.is_available || row.square_item_id !== line.catalogItemId) {
      return 'That item is not available.';
    }
    // The cached lists hold only the modifiers available at this location (see modifierListAt).
    const allowed = new Set(row.modifier_lists.flatMap((list) => list.modifiers.map((m) => m.id)));
    if (line.modifierIds.some((id) => !allowed.has(id))) return 'That topping or option is not available for this item.';
  }
  return null;
}
