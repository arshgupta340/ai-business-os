/**
 * Builders shared by the fixtures and the stateful mock db, so a row made at
 * seed time and a row made by a scripted call look the same.
 */
import {
  APPROVAL_EXPIRY_MS,
  BUNDLE_ACTIONS,
  cartHash,
  payloadHash,
  QUOTE_EXPIRY_MS,
  toCanonicalTimestamp,
  type ActivityEventOf,
  type ActivityEventPayloads,
  type ActivityEventType,
  type ActorType,
  type Booking,
  type BookingApprovalRequest,
  type BusinessFact,
  type Cart,
  type CatalogItem,
  type Contact,
  type FactEditApprovalRequest,
  type JsonValue,
  type MessageChannelSetting,
  type Order,
  type OrderApprovalRequest,
  type PriceEditApprovalRequest,
  type Quote,
} from "@abos/contracts";
import { MESSAGE_CHANNEL } from "./types";

export const MINUTE = 60_000;
export const APPROVAL_TTL_MS = APPROVAL_EXPIRY_MS;
export const QUOTE_TTL_MS = QUOTE_EXPIRY_MS;
const TAX_RATE = 0.0875;

/** CONTRACTS 4: every stored instant is Date.prototype.toISOString() (UTC, milliseconds, Z). */
export function iso(ms: number): string {
  return toCanonicalTimestamp(ms);
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
  actorType: ActorType,
  at: number,
  payload: ActivityEventPayloads[T],
): ActivityEventOf<T> {
  eventCounter += 1;
  return {
    id: `evt_${eventCounter.toString().padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`,
    businessId,
    type,
    correlationId,
    actorType,
    occurredAt: iso(at),
    payload,
  } as ActivityEventOf<T>;
}

export function last4(phone: string): string {
  return phone.slice(-4);
}

export async function buildQuote(catalog: CatalogItem[], cart: Cart, at: number, quoteId = newId("qte_")): Promise<Quote> {
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
    cartHash: await cartHash(cart),
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    currency: "USD",
    lines,
    quotedAt: iso(at),
    expiresAt: iso(at + QUOTE_TTL_MS),
  };
}

export async function buildOrder(input: {
  id: string;
  businessId: string;
  callId: string;
  catalog: CatalogItem[];
  cart: Cart;
  contact: Omit<Contact, "consentAt">;
  pickupAt: number;
  at: number;
}): Promise<Order> {
  const quote = await buildQuote(input.catalog, input.cart, input.at - MINUTE);
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
    // SPEC 2.9: consentAt goes with consent; a customer who declined has no recipient and no consentAt.
    contact: input.contact.messageConsent ? { ...input.contact, consentAt: iso(input.at - 30_000) } : { ...input.contact },
    fulfillment: { type: "pickup", pickupAt: iso(input.pickupAt) },
    createdAt: iso(input.at),
    updatedAt: iso(input.at),
  };
}

/** messageChannel defaults to MESSAGE_CHANNEL. The mock passes "qr_only" for a call made after simulateQrOnlyChannel(). */
export async function orderApproval(
  order: Order,
  agentVersionId: string,
  id: string,
  at: number,
  messageChannel: MessageChannelSetting = MESSAGE_CHANNEL,
): Promise<OrderApprovalRequest> {
  const expiresAt = iso(at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.order_bundle] as OrderApprovalRequest["actionBundle"];
  const payload = {
    businessId: order.businessId,
    subjectId: order.id,
    agentVersionId,
    cartHash: order.cartHash,
    totalMinor: order.totalMinor,
    currency: "USD" as const,
    pickupAt: order.fulfillment.pickupAt,
    messageRecipient: order.contact.messageRecipient,
    messageChannel,
    actionBundle,
    expiresAt,
  };
  return {
    id,
    businessId: order.businessId,
    actorType: "deployed_agent" as const,
    bundleType: "order_bundle" as const,
    actionBundle,
    subjectId: order.id,
    payload,
    payloadHash: await payloadHash(payload),
    state: "PENDING" as const,
    expiresAt,
    createdAt: iso(at),
  };
}

export async function bookingApproval(booking: Booking, agentVersionId: string, id: string, at: number): Promise<BookingApprovalRequest> {
  const expiresAt = iso(at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.booking_bundle] as BookingApprovalRequest["actionBundle"];
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
    actorType: "deployed_agent" as const,
    bundleType: "booking_bundle" as const,
    actionBundle,
    subjectId: booking.id,
    payload,
    payloadHash: await payloadHash(payload),
    state: "PENDING" as const,
    expiresAt,
    createdAt: iso(at),
  };
}

export async function factEditApproval(input: {
  id: string;
  businessId: string;
  subjectId: string;
  kind: BusinessFact["kind"];
  key: string;
  fromVersion: number;
  before: JsonValue;
  after: JsonValue;
  at: number;
}): Promise<FactEditApprovalRequest> {
  const expiresAt = iso(input.at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.fact_edit] as FactEditApprovalRequest["actionBundle"];
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
    actorType: "owner" as const,
    bundleType: "fact_edit" as const,
    actionBundle,
    subjectId: input.subjectId,
    payload,
    payloadHash: await payloadHash(payload),
    state: "PENDING" as const,
    expiresAt,
    createdAt: iso(input.at),
  };
}

export async function priceEditApproval(input: {
  id: string;
  businessId: string;
  item: CatalogItem;
  variationId: string;
  newPriceMinor: number;
  squareVersion: number;
  at: number;
}): Promise<PriceEditApprovalRequest> {
  const variation = input.item.variations.find((v) => v.id === input.variationId);
  if (!variation) throw new Error(`Unknown variation ${input.variationId}`);
  const expiresAt = iso(input.at + APPROVAL_TTL_MS);
  const actionBundle = [...BUNDLE_ACTIONS.price_edit] as PriceEditApprovalRequest["actionBundle"];
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
    actorType: "owner" as const,
    bundleType: "price_edit" as const,
    actionBundle,
    subjectId: payload.subjectId,
    payload,
    payloadHash: await payloadHash(payload),
    state: "PENDING" as const,
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
