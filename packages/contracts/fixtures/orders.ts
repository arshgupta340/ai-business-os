// Pizza orders in a spread of states (SPEC 2.4), with their carts and quotes.
// Every quote is priced from the fixture catalog with the demo tax rate; cart hashes are real.
import {
  APPROVAL_EXPIRY_MS,
  PIZZA_BUSINESS_ID,
  QUOTE_EXPIRY_MS,
  toCanonicalTimestamp,
  type Cart,
  type Order,
  type OrderStatus,
  type Quote,
  type QuoteLine,
} from '../src/index';
import { SQ, demoTaxMinor, pizzaCatalog } from './catalog';
import { storedHash } from './hashes';
import { addMs } from './world';

/** Prices one cart from the fixture catalog. Throws on an ID the catalog does not have. */
export function priceCartLines(cart: Cart): QuoteLine[] {
  return cart.lines.map((line) => {
    const item = pizzaCatalog.find((i) => i.squareItemId === line.catalogItemId);
    const variation = item?.variations.find((v) => v.id === line.variationId);
    if (item === undefined || variation === undefined) throw new Error(`fixture cart: unknown ${line.catalogItemId}/${line.variationId}`);
    const modifiers = line.modifierIds.map((id) => {
      const mod = item.modifierLists.flatMap((l) => l.modifiers).find((m) => m.id === id);
      if (mod === undefined) throw new Error(`fixture cart: unknown modifier ${id}`);
      return { modifierId: mod.id, name: mod.name, priceMinor: mod.priceMinor };
    });
    const unit = variation.priceMinor + modifiers.reduce((sum, m) => sum + m.priceMinor, 0);
    return {
      variationId: variation.id,
      name: `${variation.name} ${item.name}`,
      quantity: line.quantity,
      unitPriceMinor: variation.priceMinor,
      modifiers,
      lineTotalMinor: unit * line.quantity,
    };
  });
}

function quoteFor(quoteId: string, cart: Cart, cartHashValue: string, quotedAt: string): Quote {
  const lines = priceCartLines(cart);
  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const taxMinor = demoTaxMinor(subtotalMinor);
  return {
    quoteId,
    cartHash: cartHashValue,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    currency: 'USD',
    lines,
    quotedAt,
    expiresAt: addMs(quotedAt, QUOTE_EXPIRY_MS),
  };
}

type OrderInput = {
  n: string; // "01" gives ord_demo_01, call_demo_01, qte_demo_01, apv_demo_01
  status: OrderStatus;
  cart: Cart;
  quotedAt: string;
  proposedAt: string;
  updatedAt: string;
  contactName: string;
  /** Absent when the caller declined messages: no recipient, and the approval channel is qr_only. */
  consent?: { recipient: string; consentAt: string };
  pickupAt: string;
  square?: { checkout: boolean; paymentId?: string };
};

function order(o: OrderInput): Order {
  const id = `ord_demo_${o.n}`;
  const cartHashValue = storedHash(`cart:${id}`);
  const quote = quoteFor(`qte_demo_${o.n}`, o.cart, cartHashValue, o.quotedAt);
  const out: Order = {
    id,
    businessId: PIZZA_BUSINESS_ID,
    callId: `call_demo_${o.n}`,
    status: o.status,
    cart: o.cart,
    cartHash: cartHashValue,
    quote,
    totalMinor: quote.totalMinor,
    currency: quote.currency,
    contact:
      o.consent === undefined
        ? { name: o.contactName, messageConsent: false }
        : { name: o.contactName, messageRecipient: o.consent.recipient, messageConsent: true, consentAt: o.consent.consentAt },
    // Issue #103: `toISOString()` form, the form the approval payload hashes and the server stores (CONTRACTS 4).
    fulfillment: { type: 'pickup', pickupAt: toCanonicalTimestamp(o.pickupAt) },
    approvalId: `apv_demo_${o.n}`,
    createdAt: o.proposedAt,
    updatedAt: o.updatedAt,
  };
  if (o.square?.checkout === true) {
    out.squareOrderId = `SQ_ORDER_DEMO_${o.n}`;
    out.squarePaymentLinkId = `SQ_PAYLINK_DEMO_${o.n}`;
    out.checkoutUrl = `https://sandbox.square.link/u/demo${o.n}`;
  }
  if (o.square?.paymentId !== undefined) out.squarePaymentId = o.square.paymentId;
  return out;
}

const line = (catalogItemId: string, variationId: string, quantity: number, modifierIds: string[] = []) => ({ catalogItemId, variationId, quantity, modifierIds });

/** The order of the scripted pizza timeline: paid, verified and queued for the kitchen. Total 4731 (CONTRACTS 9). */
export const orderFulfilled = order({
  n: '01', status: 'FULFILLMENT_READY',
  cart: { lines: [line(SQ.itemMargherita, SQ.varMargheritaLarge, 1, [SQ.modMushrooms]), line(SQ.itemPepperoni, SQ.varPepperoniLarge, 1)] },
  quotedAt: '2026-11-14T19:01:35Z', proposedAt: '2026-11-14T19:03:05Z', updatedAt: '2026-11-14T19:06:31Z',
  contactName: 'Maya', consent: { recipient: '+15555550123', consentAt: '2026-11-14T19:02:50Z' }, pickupAt: '2026-11-14T19:30:00Z',
  square: { checkout: true, paymentId: 'SQ_PAYMENT_DEMO_01' },
});

/** Paid under `qr_only`: the message step was SKIPPED and the customer scanned the QR code. */
export const orderPaid = order({
  n: '02', status: 'PAID_VERIFIED',
  cart: { lines: [line(SQ.itemPepperoni, SQ.varPepperoniMedium, 1, [SQ.modOlives]), line(SQ.itemMargherita, SQ.varMargheritaMedium, 1)] },
  quotedAt: '2026-11-14T19:21:00Z', proposedAt: '2026-11-14T19:22:00Z', updatedAt: '2026-11-14T19:25:00Z',
  contactName: 'Jordan', consent: { recipient: '+15555550124', consentAt: '2026-11-14T19:21:40Z' }, pickupAt: '2026-11-14T19:45:00Z',
  square: { checkout: true, paymentId: 'SQ_PAYMENT_DEMO_02' },
});

/** Link sent, not paid yet (sandbox). */
export const orderPaymentPending = order({
  n: '03', status: 'PAYMENT_PENDING',
  cart: { lines: [line(SQ.itemMargherita, SQ.varMargheritaSmall, 2, [SQ.modExtraCheese])] },
  quotedAt: '2026-11-14T19:41:30Z', proposedAt: '2026-11-14T19:42:30Z', updatedAt: '2026-11-14T19:43:36Z',
  contactName: 'Priya', consent: { recipient: '+15555550125', consentAt: '2026-11-14T19:42:10Z' }, pickupAt: '2026-11-14T20:15:00Z',
  square: { checkout: true },
});

/** Waiting for the owner. Its approval is PENDING and expires at 20:35Z. */
export const orderAwaitingApproval = order({
  n: '04', status: 'AWAITING_OWNER_APPROVAL',
  cart: { lines: [line(SQ.itemPepperoni, SQ.varPepperoniLarge, 1, [SQ.modExtraCheese]), line(SQ.itemPepperoni, SQ.varPepperoniLarge, 1)] },
  quotedAt: '2026-11-14T20:24:00Z', proposedAt: '2026-11-14T20:25:00Z', updatedAt: '2026-11-14T20:25:00Z',
  contactName: 'Sam', consent: { recipient: '+15555550126', consentAt: '2026-11-14T20:24:40Z' }, pickupAt: '2026-11-14T21:00:00Z',
});

export const orderRejected = order({
  n: '05', status: 'REJECTED',
  cart: { lines: [line(SQ.itemMargherita, SQ.varMargheritaMedium, 1)] },
  quotedAt: '2026-11-14T19:51:00Z', proposedAt: '2026-11-14T19:52:00Z', updatedAt: '2026-11-14T19:53:00Z',
  contactName: 'Lee', consent: { recipient: '+15555550127', consentAt: '2026-11-14T19:51:40Z' }, pickupAt: '2026-11-14T20:30:00Z',
});

export const orderApprovalExpired = order({
  n: '06', status: 'APPROVAL_EXPIRED',
  cart: { lines: [line(SQ.itemMargherita, SQ.varMargheritaLarge, 1)] },
  quotedAt: '2026-11-14T19:12:00Z', proposedAt: '2026-11-14T19:13:00Z', updatedAt: addMs('2026-11-14T19:13:00Z', APPROVAL_EXPIRY_MS),
  contactName: 'Alex', consent: { recipient: '+15555550128', consentAt: '2026-11-14T19:12:40Z' }, pickupAt: '2026-11-14T19:45:00Z',
});

/** The declined sandbox card (AC-12). */
export const orderPaymentFailed = order({
  n: '07', status: 'PAYMENT_FAILED',
  cart: { lines: [line(SQ.itemPepperoni, SQ.varPepperoniSmall, 1, [SQ.modMushrooms, SQ.modOlives])] },
  quotedAt: '2026-11-14T20:01:00Z', proposedAt: '2026-11-14T20:02:00Z', updatedAt: '2026-11-14T20:05:00Z',
  contactName: 'Casey', consent: { recipient: '+15555550129', consentAt: '2026-11-14T20:01:40Z' }, pickupAt: '2026-11-14T20:30:00Z',
  square: { checkout: true },
});

/**
 * A caller who declined messages (SPEC 2.9 "Customer who declines messages"): no recipient, and the
 * approval channel is qr_only, so the checkout link is shown as a QR code at the counter. It has its own
 * call, cart and quote, because the orders table allows one order per (businessId, cartHash, callId).
 */
export const orderQrOnly = order({
  n: 'qr', status: 'AWAITING_OWNER_APPROVAL',
  cart: { lines: [line(SQ.itemMargherita, SQ.varMargheritaMedium, 1, [SQ.modOlives]), line(SQ.itemPepperoni, SQ.varPepperoniSmall, 1)] },
  quotedAt: '2026-11-14T20:26:30Z', proposedAt: '2026-11-14T20:27:30Z', updatedAt: '2026-11-14T20:27:30Z',
  contactName: 'Robin', pickupAt: '2026-11-14T21:15:00Z',
});

export const orders: Order[] = [
  orderQrOnly,
  orderAwaitingApproval,
  orderPaymentFailed,
  orderRejected,
  orderPaymentPending,
  orderPaid,
  orderApprovalExpired,
  orderFulfilled,
];

/** The quote of the scripted pizza timeline (CONTRACTS 9 `quote.pizza`). */
export const pizzaTimelineQuote: Quote = orderFulfilled.quote;

/** Order of the cancel endpoint fixture (SHOULD): the unpaid order after the owner cancels it. */
export const orderCancelled: Order = { ...orderPaymentPending, status: 'CANCELLED', updatedAt: '2026-11-14T20:32:00Z' };
