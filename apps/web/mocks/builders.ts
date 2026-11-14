/**
 * Builders shared by the fixtures and the stateful mock db, so a row made at
 * seed time and a row made by a scripted call look the same.
 */
import {
  BUNDLE_ACTIONS,
  type ActivityEvent,
  type ActivityEventType,
  type ActivityPayloads,
  type ApprovalRequest,
  type Booking,
  type BusinessFact,
  type Cart,
  type CatalogItem,
  type Contact,
  type Order,
  type Quote,
} from "@/lib/api/pending-contracts";
import { cartHash, payloadHash } from "./hash";
import { MESSAGE_CHANNEL } from "./types";

export const MINUTE = 60_000;
export const APPROVAL_TTL_MS = 10 * MINUTE;
export const QUOTE_TTL_MS = 5 * MINUTE;
const TAX_RATE = 0.0875;

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

let idCounter = 0;
/** A fresh prefixed ID, for example newId("ord_") gives "ord_m3k2a7". */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}m${Date.now().toString(36).slice(-4)}${idCounter.toString(36)}`;
}

let eventCounter = 0;
export function resetEventCounter(): void {
  eventCounter = 0;
}

export function makeEvent<T extends ActivityEventType>(
  businessId: string,
  type: T,
  correlationId: string,
  actorType: ActivityEvent["actorType"],
  at: number,
  payload: ActivityPayloads[T],
): ActivityEvent {
  eventCounter += 1;
  return {
    id: `evt_${eventCounter.toString().padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`,
    businessId,
    type,
    correlationId,
    actorType,
    occurredAt: iso(at),
    payload: payload as unknown as Record<string, unknown>,
  };
}

export function last4(phone: string): string {
  return phone.slice(-4);
}

export function buildQuote(catalog: CatalogItem[], cart: Cart, at: number, quoteId = newId("qte_")): Quote {
  const lines = cart.lines.map((line) => {
    const item = catalog.find((c) => c.squareItemId === line.catalogItemId);
    const variation = item?.variations.find((v) => v.id === line.variationId);
    if (!item || !variation) throw new Error(`Unknown catalog line ${line.variationId}`);
    const modifiers = line.modifierIds.map((modifierId) => {
      const mod = item.modifierLists.flatMap((l) => l.modifiers).find((m) => m.id === modifierId);
      if (!mod) throw new Error(`Unknown modifier ${modifierId}`);
      return { modifierId, name: mod.name, priceMinor: mod.priceMinor };
    });
    const unit = variation.priceMinor + modifiers.reduce((s, m) => s + m.priceMinor, 0);
    return {
      variationId: variation.id,
      name: `${variation.name} ${item.name}`,
      quantity: line.quantity,
      unitPriceMinor: variation.priceMinor,
      modifiers,
      lineTotalMinor: unit * line.quantity,
    };
  });
  const subtotalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const taxMinor = Math.round(subtotalMinor * TAX_RATE);
  return {
    quoteId,
    cartHash: cartHash(cart),
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    currency: "USD",
    lines,
    quotedAt: iso(at),
    expiresAt: iso(at + QUOTE_TTL_MS),
  };
}

export function buildOrder(input: {
  id: string;
  businessId: string;
  callId: string;
  catalog: CatalogItem[];
  cart: Cart;
  contact: Omit<Contact, "consentAt">;
  pickupAt: number;
  at: number;
}): Order {
  const quote = buildQuote(input.catalog, input.cart, input.at - MINUTE);
  return {
    id: input.id,
    businessId: input.businessId,
    callId: input.callId,
    status: "AWAITING_OWNER_APPROVAL",
    cart: input.cart,
    cartHash: quote.cartHash,
    quote,
    totalMinor: quote.totalMinor,
    currency: "USD",
    contact: { ...input.contact, consentAt: iso(input.at - 30_000) },
    fulfillment: { type: "pickup", pickupAt: iso(input.pickupAt) },
    createdAt: iso(input.at),
    updatedAt: iso(input.at),
  };
}

export function orderApproval(order: Order, agentVersionId: string, id: string, at: number): ApprovalRequest {
  const expiresAt = iso(at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.order_bundle];
  const payload = {
    businessId: order.businessId,
    subjectId: order.id,
    agentVersionId,
    cartHash: order.cartHash,
    totalMinor: order.totalMinor,
    currency: "USD" as const,
    pickupAt: order.fulfillment.pickupAt,
    messageRecipient: order.contact.messageRecipient,
    messageChannel: MESSAGE_CHANNEL,
    actionBundle,
    expiresAt,
  };
  return {
    id,
    businessId: order.businessId,
    actorType: "deployed_agent",
    bundleType: "order_bundle",
    actionBundle,
    subjectId: order.id,
    payload,
    payloadHash: payloadHash(payload),
    state: "PENDING",
    expiresAt,
    createdAt: iso(at),
  };
}

export function bookingApproval(booking: Booking, agentVersionId: string, id: string, at: number): ApprovalRequest {
  const expiresAt = iso(at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.booking_bundle];
  const payload = {
    businessId: booking.businessId,
    subjectId: booking.id,
    agentVersionId,
    serviceId: booking.serviceId,
    calendarId: booking.calendarId,
    startUtc: booking.startUtc,
    endUtc: booking.endUtc,
    timezone: booking.timezone,
    messageRecipient: booking.customer.messageRecipient,
    messageChannel: MESSAGE_CHANNEL,
    actionBundle,
    expiresAt,
  };
  return {
    id,
    businessId: booking.businessId,
    actorType: "deployed_agent",
    bundleType: "booking_bundle",
    actionBundle,
    subjectId: booking.id,
    payload,
    payloadHash: payloadHash(payload),
    state: "PENDING",
    expiresAt,
    createdAt: iso(at),
  };
}

export function factEditApproval(input: {
  id: string;
  businessId: string;
  subjectId: string;
  kind: BusinessFact["kind"];
  key: string;
  fromVersion: number;
  before: unknown;
  after: unknown;
  at: number;
}): ApprovalRequest {
  const expiresAt = iso(input.at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.fact_edit];
  const payload = {
    businessId: input.businessId,
    subjectId: input.subjectId,
    kind: input.kind,
    key: input.key,
    fromVersion: input.fromVersion,
    before: input.before,
    after: input.after,
    actionBundle,
    expiresAt,
  };
  return {
    id: input.id,
    businessId: input.businessId,
    actorType: "owner",
    bundleType: "fact_edit",
    actionBundle,
    subjectId: input.subjectId,
    payload,
    payloadHash: payloadHash(payload),
    state: "PENDING",
    expiresAt,
    createdAt: iso(input.at),
  };
}

export function priceEditApproval(input: {
  id: string;
  businessId: string;
  item: CatalogItem;
  variationId: string;
  newPriceMinor: number;
  squareVersion: number;
  at: number;
}): ApprovalRequest {
  const variation = input.item.variations.find((v) => v.id === input.variationId);
  if (!variation) throw new Error(`Unknown variation ${input.variationId}`);
  const expiresAt = iso(input.at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.price_edit];
  const payload = {
    businessId: input.businessId,
    subjectId: catalogRowId(input.variationId),
    squareItemId: input.item.squareItemId,
    variationId: input.variationId,
    fromPriceMinor: variation.priceMinor,
    newPriceMinor: input.newPriceMinor,
    currency: "USD" as const,
    squareVersion: input.squareVersion,
    actionBundle,
    expiresAt,
  };
  return {
    id: input.id,
    businessId: input.businessId,
    actorType: "owner",
    bundleType: "price_edit",
    actionBundle,
    subjectId: payload.subjectId,
    payload,
    payloadHash: payloadHash(payload),
    state: "PENDING",
    expiresAt,
    createdAt: iso(input.at),
  };
}

/**
 * The cat_ id of the catalog_items row for one variation. The API groups rows
 * by item and does not expose this id, but a price_edit subjectId uses it.
 */
export function catalogRowId(variationId: string): string {
  return `cat_${variationId.toLowerCase()}`;
}

export function sandboxCheckoutUrl(orderId: string): string {
  return `https://sandbox.square.link/u/mock-${orderId.replace(/^ord_/, "")}`;
}
