// Square adapter (task B-12): catalog sync, quotes, checkout links, payment checks and webhook
// signatures. Sandbox only. Every money value comes from Square; this file never prices anything.
// Reference: scripts/spikes/square/src (lifted and made injectable, not imported).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Square } from 'square';
import { z } from 'zod';
import {
  CatalogModifierListSchema,
  ID_PREFIXES,
  QUOTE_EXPIRY_MS,
  QuoteSchema,
  cartHash,
  newId,
  type Cart,
  type CatalogModifierList,
  type QuoteLine,
  type ToolFailureReason,
} from '@abos/contracts';
import {
  SquareAdapterError,
  type Database,
  type PaymentMismatchField,
  type PaymentVerification,
  type QuoteFailure,
  type QuoteResult,
  type SquareAdapter,
  type SquareAdapterDeps,
  type VerifyPaymentInput,
  type WebhookSignatureInput,
} from './types';

export * from './types';

/** The catalog object types read by a sync. Variations also arrive nested inside their items. */
export const CATALOG_SYNC_TYPES = 'ITEM,ITEM_VARIATION,MODIFIER_LIST,TAX';

/** CreatePaymentLink caps the idempotency key at 192 characters (SPEC 2.9). */
export const PAYMENT_LINK_KEY_MAX = 192;

/** How far back the ListPayments fallback looks when the order has no creation time. */
const PAYMENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const CURRENCY = 'USD';

/** The tax choice used in both the quote and the payment link so their totals match (SPEC 4). */
const PRICING_OPTIONS: Square.OrderPricingOptions = { autoApplyTaxes: true };

// ---------- construction ----------

export function createSquareAdapter(deps: SquareAdapterDeps): SquareAdapter {
  // Checked before the client is touched (AC-19).
  if (deps.environment !== 'sandbox') {
    throw new SquareAdapterError('ENVIRONMENT_MISMATCH', 'The Square adapter runs only when SQUARE_ENVIRONMENT is exactly "sandbox".');
  }
  if (!deps.locationId) throw new SquareAdapterError('VALIDATION_FAILED', 'A Square location ID is required.');
  const { client, locationId, now } = deps;

  // ---------- 1. catalog sync ----------

  async function syncCatalog(db: Database, businessId: string): Promise<number> {
    // Read every page before touching the database, so a failed read leaves the cache alone.
    const objects: Square.CatalogObject[] = [];
    for await (const object of await client.catalog.list({ types: CATALOG_SYNC_TYPES })) objects.push(object);

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
      // Variations Square no longer returns stay in the table, marked unavailable.
      await tx.query(MARK_MISSING_UNAVAILABLE, [businessId, rows.map((row) => row.squareVariationId), syncedAt]);
      return rows.length;
    });
  }

  // ---------- 2. quote ----------

  async function quote(db: Database, businessId: string, cart: Cart): Promise<QuoteResult> {
    const unavailable = await findUnavailable(db, businessId, cart);
    if (unavailable) return failure('ITEM_UNAVAILABLE', unavailable);

    const order = orderFromCart(cart, locationId);
    let response: Square.CalculateOrderResponse;
    try {
      response = await client.orders.calculate({ order });
    } catch {
      return failure('INTEGRATION_UNAVAILABLE', 'Square could not price the order.');
    }

    const priced = response.order;
    const total = priced?.totalMoney;
    const lines = priced?.lineItems ?? [];
    if (!priced || !isUsd(total) || !isUsd(priced.totalTaxMoney ?? { amount: 0n, currency: CURRENCY }) || lines.length !== cart.lines.length) {
      return failure('INTEGRATION_UNAVAILABLE', 'Square returned an incomplete quote.');
    }

    const quoteLines: QuoteLine[] = [];
    let subtotalMinor = 0;
    for (const line of lines) {
      const gross = line.grossSalesMoney;
      const lineTotal = line.totalMoney;
      const unit = line.basePriceMoney;
      if (!line.catalogObjectId || !isUsd(gross) || !isUsd(lineTotal) || !isUsd(unit)) {
        return failure('INTEGRATION_UNAVAILABLE', 'Square returned a line without prices.');
      }
      // Square has no order subtotal field: the subtotal is the sum of Square's own line gross sales.
      subtotalMinor += toMinor(gross);
      const modifiers = [];
      for (const modifier of line.modifiers ?? []) {
        if (!modifier.catalogObjectId || !isUsd(modifier.basePriceMoney)) {
          return failure('INTEGRATION_UNAVAILABLE', 'Square returned a modifier without a price.');
        }
        modifiers.push({ modifierId: modifier.catalogObjectId, name: modifier.name ?? '', priceMinor: toMinor(modifier.basePriceMoney) });
      }
      quoteLines.push({
        variationId: line.catalogObjectId,
        name: line.name ?? '',
        quantity: Number(line.quantity),
        unitPriceMinor: toMinor(unit),
        modifiers,
        lineTotalMinor: toMinor(lineTotal),
      });
    }

    const quotedAt = now();
    // SPEC 2.9: the total is whatever Square returns; it is not checked against subtotal plus tax.
    const parsed = QuoteSchema.safeParse({
      quoteId: newId(ID_PREFIXES.quote),
      cartHash: await cartHash(cart),
      subtotalMinor,
      taxMinor: priced.totalTaxMoney ? toMinor(priced.totalTaxMoney) : 0,
      totalMinor: toMinor(total),
      currency: CURRENCY,
      lines: quoteLines,
      quotedAt: quotedAt.toISOString(),
      expiresAt: new Date(quotedAt.getTime() + QUOTE_EXPIRY_MS).toISOString(),
    });
    if (!parsed.success) return failure('INTEGRATION_UNAVAILABLE', 'Square returned a quote that does not fit the contract.');
    return { ok: true, quote: parsed.data };
  }

  // ---------- 3. checkout ----------

  async function createCheckout(input: Parameters<SquareAdapter['createCheckout']>[0]): ReturnType<SquareAdapter['createCheckout']> {
    const { idempotencyKey, approvedTotalMinor, currency } = input;
    if (!idempotencyKey || idempotencyKey.length > PAYMENT_LINK_KEY_MAX) {
      throw new SquareAdapterError('VALIDATION_FAILED', `The idempotency key must be 1 to ${PAYMENT_LINK_KEY_MAX} characters.`);
    }
    if (input.order.locationId !== locationId) {
      throw new SquareAdapterError('VALIDATION_FAILED', 'The order location does not match the configured Square location.');
    }
    // Never send order.taxes alongside automatic taxes, or tax is applied twice (SPEC 4).
    const { taxes: _taxes, ...rest } = input.order;
    const order: Square.Order = { ...rest, pricingOptions: { ...PRICING_OPTIONS } };

    // One CreatePaymentLink call. It creates the Square order, so CreateOrder is never called.
    const response = await client.checkout.paymentLinks.create({ idempotencyKey, order });
    const link = response.paymentLink;
    if (!link?.id || !link.url || !link.orderId) {
      throw new SquareAdapterError('INVALID_STATE', 'Square returned a payment link without an ID, URL or order ID.', {
        orderState: 'RECOVERY_REQUIRED',
        ...(link?.orderId ? { squareOrderId: link.orderId } : {}),
        ...(link?.id ? { paymentLinkId: link.id } : {}),
      });
    }

    // FLOWS B19: read the order back and compare with what the owner approved.
    const read = await client.orders.get({ orderId: link.orderId });
    const squareTotal = read.order?.totalMoney;
    const matches = squareTotal?.amount !== undefined && squareTotal.amount !== null
      && squareTotal.amount === BigInt(approvedTotalMinor) && squareTotal.currency === currency;
    if (!matches) {
      const seen = squareTotal?.amount != null ? `${squareTotal.amount.toString()} ${squareTotal.currency ?? '?'}` : 'none';
      throw new SquareAdapterError(
        'INVALID_STATE',
        `Square total ${seen} does not match approved total ${approvedTotalMinor} ${currency}. Move the order to RECOVERY_REQUIRED and do not send the link.`,
        { orderState: 'RECOVERY_REQUIRED', squareOrderId: link.orderId, paymentLinkId: link.id },
      );
    }
    return { squareOrderId: link.orderId, paymentLinkId: link.id, url: link.url };
  }

  // ---------- 4. payments ----------

  async function verifyPayment({ paymentId, expected }: VerifyPaymentInput): Promise<PaymentVerification> {
    const { payment } = await client.payments.get({ paymentId });
    if (!payment) return { verified: false, failedFields: ['paymentId'] };
    return checkPayment(paymentId, payment, expected);
  }

  async function findPaymentForOrder(squareOrderId: string): Promise<string[]> {
    const { order } = await client.orders.get({ orderId: squareOrderId });
    const fromTenders = unique((order?.tenders ?? []).map((tender) => tender.paymentId ?? tender.id));
    if (fromTenders.length > 0) return fromTenders;

    // ListPayments has no order filter: list the location's recent payments and filter here.
    const since = order?.createdAt ?? new Date(now().getTime() - PAYMENT_LOOKBACK_MS).toISOString();
    const found: (string | undefined)[] = [];
    const pages = await client.payments.list({ locationId, beginTime: since, sortOrder: 'DESC', limit: 100 });
    for await (const payment of pages) if (payment.orderId === squareOrderId) found.push(payment.id);
    return unique(found);
  }

  return { syncCatalog, quote, createCheckout, verifyPayment, findPaymentForOrder, verifyWebhookSignature };
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

/** SPEC 4: paid only when COMPLETED and order ID, amount, currency and location all match. */
export function checkPayment(paymentId: string, payment: Square.Payment, expected: VerifyPaymentInput['expected']): PaymentVerification {
  const failed: PaymentMismatchField[] = [];
  if (payment.id !== paymentId) failed.push('paymentId');
  if (payment.status !== 'COMPLETED') failed.push('status');
  if (payment.orderId !== expected.squareOrderId) failed.push('squareOrderId');
  // amount_money is the order amount without a tip.
  const amount = payment.amountMoney?.amount;
  if (amount === undefined || amount === null || amount !== BigInt(expected.amountMinor)) failed.push('amountMinor');
  if (payment.amountMoney?.currency !== expected.currency) failed.push('currency');
  if (payment.locationId !== expected.locationId) failed.push('locationId');
  return failed.length === 0 ? { verified: true, failedFields: [] } : { verified: false, failedFields: failed };
}

function failure(reason: ToolFailureReason, message: string): QuoteFailure {
  return { ok: false, reason, code: reason, message };
}

function isUsd(money: Square.Money | undefined): money is Square.Money & { amount: bigint } {
  return money !== undefined && typeof money.amount === 'bigint' && money.amount >= 0n && money.currency === CURRENCY;
}

function toMinor(money: Square.Money): number {
  const amount = money.amount ?? 0n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new SquareAdapterError('INTERNAL', 'Square amount is out of range.');
  return Number(amount);
}

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

interface CatalogRowInput {
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

/** Maps ListCatalog objects to one row per fixed-price USD variation. Pure, so it is easy to test. */
export function catalogRows(objects: Square.CatalogObject[], locationId: string): CatalogRowInput[] {
  const modifierLists = new Map<string, CatalogModifierList>();
  const items = new Map<string, Square.CatalogObject.Item>();
  const variations = new Map<string, Square.CatalogObject.ItemVariation>();

  for (const object of objects) {
    if (object.type === 'MODIFIER_LIST' && !object.isDeleted) {
      const list = CatalogModifierListSchema.safeParse({
        id: object.id,
        name: object.modifierListData?.name ?? '',
        selectionType: object.modifierListData?.selectionType ?? 'SINGLE',
        modifiers: (object.modifierListData?.modifiers ?? [])
          .filter((m): m is Square.CatalogObject.Modifier => m.type === 'MODIFIER' && !m.isDeleted)
          .map((m) => ({ id: m.id, name: m.modifierData?.name ?? '', priceMinor: Number(m.modifierData?.priceMoney?.amount ?? 0n) })),
      });
      if (list.success) modifierLists.set(list.data.id, list.data);
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
    const price = override?.priceMoney ?? data.priceMoney;
    const pricingType = override?.pricingType ?? data.pricingType;
    // A row needs a fixed USD price (the table requires one); variable-priced variations are not cached.
    if (pricingType === 'VARIABLE_PRICING' || !isUsd(price)) continue;

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
      priceMinor: Number(price.amount),
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
    const allowed = new Set(row.modifier_lists.flatMap((list) => list.modifiers.map((m) => m.id)));
    if (line.modifierIds.some((id) => !allowed.has(id))) return 'That topping or option is not available for this item.';
  }
  return null;
}
