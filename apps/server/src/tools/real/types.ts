// Ports the real toolset needs (SPEC 2.6, CONTRACTS 8). Each one is implemented elsewhere
// (the catalog cache, the facts store, the Square quote adapter, the approval engine, the order
// store, the calendar adapter) and injected here, so this directory imports none of them.
// None of these ports performs an external write: the proposal port stores a proposal and
// opens an approval request, and nothing leaves the server until the owner approves.
import type {
  AvailabilitySlot,
  BookingCustomer,
  Cart,
  CatalogItem,
  CapabilityId,
  Contact,
  Fulfillment,
  JsonValue,
  MessageChannelSetting,
  OrderStatus,
  Quote,
  ReadableFactKind,
  ToolFailureReason,
  ToolHandler,
  ToolTraceEntry,
  Toolset,
} from '@abos/contracts';

/** Server context every port call carries. The model never supplies any of it. */
export type PortContext = {
  businessId: string;
  agentVersionId: string;
  callId?: string | undefined;
  testSessionId?: string | undefined;
  correlationId: string;
};

/** Searches the cached catalog (`catalog_items`, P-10). Returns at most `limit` items of this business. */
export interface CatalogPort {
  search(args: { businessId: string; query?: string | undefined; limit: number }): Promise<CatalogItem[]>;
}

/** The verified facts of a business, without `menu_item` drafts. */
export type FactsSnapshot = {
  facts: { kind: ReadableFactKind; key: string; value: JsonValue; version: number }[];
  timezone: string;
};

/** Reads the verified hours, policies, services, contacts and FAQs of a business. */
export interface FactsPort {
  readVerified(args: { businessId: string }): Promise<FactsSnapshot>;
}

export type QuotePortResult = { ok: true; quote: Quote } | { ok: false; reason: 'ITEM_UNAVAILABLE'; message?: string | undefined };

/** Prices a cart with Square CalculateOrder. Throws only when the provider cannot be reached. */
export interface QuotePort {
  quote(args: { businessId: string; cart: Cart }): Promise<QuotePortResult>;
}

export type OrderProposalInput = PortContext & {
  cart: Cart;
  quote: Quote;
  contact: Contact;
  fulfillment: Fulfillment;
  /** `qr_only` when the caller declined messages. */
  messageChannel: MessageChannelSetting;
};

export type OrderProposalResult =
  | { ok: true; orderId: string; approvalId: string }
  | { ok: false; reason: ToolFailureReason; message?: string | undefined; quote?: Quote | undefined };

export type BookingProposalInput = PortContext & {
  serviceId: string;
  startUtc: string;
  customer: BookingCustomer;
  /** `qr_only` when the caller declined messages. */
  messageChannel: MessageChannelSetting;
};

export type BookingProposalResult =
  | { ok: true; bookingId: string; approvalId: string; slot: AvailabilitySlot }
  | { ok: false; reason: ToolFailureReason; message?: string | undefined; alternatives?: AvailabilitySlot[] | undefined };

/**
 * The approval engine. One transaction stores the immutable proposal and its ApprovalRequest.
 * It re-checks what policy requires (business scope, availability, the slot) and performs no external write.
 */
export interface ProposalPort {
  createOrderProposal(input: OrderProposalInput): Promise<OrderProposalResult>;
  createBookingProposal(input: BookingProposalInput): Promise<BookingProposalResult>;
}

export type OrderStatusView = { orderId: string; status: OrderStatus; paid: boolean; checkoutLinkSent: boolean };

/**
 * Reads the verified status of one order. Must return null unless the order belongs to `businessId`
 * and, when `callId` is given, to that call (FLOWS 8, swapped proposal ID).
 */
export interface OrderStatusPort {
  read(args: { businessId: string; orderId: string; callId?: string | undefined }): Promise<OrderStatusView | null>;
}

/** Free slots from Google Calendar free/busy (FLOWS C3). Returns null for a service this business does not offer. */
export interface AvailabilityPort {
  freeSlots(args: { businessId: string; serviceId: string; date: string; maxSlots: number }): Promise<{ slots: AvailabilitySlot[]; timezone: string } | null>;
}

export type RealToolsetPorts = {
  catalog: CatalogPort;
  facts: FactsPort;
  quotes: QuotePort;
  proposals: ProposalPort;
  orderStatus: OrderStatusPort;
  availability: AvailabilityPort;
};

export type RealToolsetDeps = {
  businessId: string;
  /** The server's MESSAGE_CHANNEL setting. A caller who declines messages always gets `qr_only`. */
  messageChannel: MessageChannelSetting;
  ports: RealToolsetPorts;
  /** The pinned agent version's capabilities. Only tools for these are callable. Defaults to all seven tools. */
  capabilities?: readonly CapabilityId[] | undefined;
  /** Clock for quote expiry and pickup checks. */
  now?: (() => Date) | undefined;
};

export type RealToolset = {
  readonly businessId: string;
  /** The `ToolHandler` the voice worker and sim-call use. Every call is validated and traced. */
  readonly handler: ToolHandler;
  /** The same seven tools as functions, through the same validation and trace. */
  readonly tools: Toolset;
  /** A copy of every call so far, oldest first. A message recipient is masked to its last four digits. */
  trace(): ToolTraceEntry[];
  clearTrace(): void;
};
