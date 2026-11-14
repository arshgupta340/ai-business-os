// Types for the Square adapter (task B-12). Shapes shared with the rest of the app come from
// @abos/contracts; this file only declares what the adapter itself needs.
import type { Square } from 'square';
import type { Cart, Currency, ErrorCode, OrderStatus, Quote, ToolFailure, ToolFailureReason } from '@abos/contracts';

/** The query half of the injected database (common worker rules). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The injected database: queries plus a transaction that hands back the same query interface. */
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * The SDK operations this adapter uses, and nothing else. A real `SquareClient` from `square` v46
 * fits this interface without a cast (the test file checks that at compile time), and tests pass a fake.
 * No client is constructed in the adapter.
 */
export interface SquareClient {
  catalog: {
    /** ListCatalog. The SDK returns a pager that walks every page when iterated. */
    list(request: { types: string }): Promise<AsyncIterable<Square.CatalogObject>>;
  };
  orders: {
    /** CalculateOrder. `pricingOptions` sits on the order object, not on the request. */
    calculate(request: { order: Square.Order }): Promise<Square.CalculateOrderResponse>;
    /** RetrieveOrder. */
    get(request: { orderId: string }): Promise<Square.GetOrderResponse>;
  };
  checkout: {
    paymentLinks: {
      /** CreatePaymentLink with an order object. It creates the Square order itself. */
      create(request: { order: Square.Order; idempotencyKey: string }): Promise<Square.CreatePaymentLinkResponse>;
    };
  };
  payments: {
    /** GetPayment. */
    get(request: { paymentId: string }): Promise<Square.GetPaymentResponse>;
    /** ListPayments. It has no order filter, so callers filter by order ID themselves. */
    list(request: { locationId: string; beginTime: string; sortOrder: 'DESC'; limit: number }): Promise<AsyncIterable<Square.Payment>>;
  };
}

export interface SquareAdapterDeps {
  client: SquareClient;
  locationId: string;
  /** Must be exactly `sandbox` (AGENTS.md rule 4, AC-19). Anything else throws at construction. */
  environment: string;
  now(): Date;
}

/** The success shape of the `quote_order` tool. */
export type QuoteSuccess = { ok: true; quote: Quote };

/** A tool failure that also carries the matching API error code. */
export type QuoteFailure = ToolFailure & { ok: false; code: ToolFailureReason & ErrorCode };

export type QuoteResult = QuoteSuccess | QuoteFailure;

export interface CatalogAdapter {
  /** Reads the Square catalog and upserts one `catalog_items` row per sellable variation. Returns rows written. */
  syncCatalog(db: Database, businessId: string): Promise<number>;
  /** Validates the cart against `catalog_items`, then prices it with Square CalculateOrder. */
  quote(db: Database, businessId: string, cart: Cart): Promise<QuoteResult>;
}

export interface CheckoutInput {
  /** The order built from the stored, approved cart (see `orderFromCart`). */
  order: Square.Order;
  /** The stable key from the approval (SPEC 2.9). Passed to Square unchanged. */
  idempotencyKey: string;
  approvedTotalMinor: Quote['totalMinor'];
  currency: Currency;
}

export interface CheckoutResult {
  squareOrderId: string;
  paymentLinkId: string;
  url: string;
}

export interface VerifyPaymentInput {
  paymentId: string;
  expected: {
    squareOrderId: string;
    amountMinor: Quote['totalMinor'];
    currency: Currency;
    locationId: string;
  };
}

export type PaymentMismatchField = 'paymentId' | 'status' | keyof VerifyPaymentInput['expected'];

export type PaymentVerification =
  | { verified: true; failedFields: [] }
  | { verified: false; failedFields: PaymentMismatchField[] };

export interface WebhookSignatureInput {
  /** The exact bytes Square sent, before any JSON parsing. */
  rawBody: string | Uint8Array;
  /** The `x-square-hmacsha256-signature` header value (base64). */
  signatureHeader: string | undefined;
  /** The exact notification URL registered with Square. */
  notificationUrl: string;
  signatureKey: string;
}

export interface CheckoutAdapter {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<PaymentVerification>;
  /** Payment IDs from the order's tenders; lists the location's payments only when there are no tenders. */
  findPaymentForOrder(squareOrderId: string): Promise<string[]>;
  verifyWebhookSignature(input: WebhookSignatureInput): boolean;
}

export type SquareAdapter = CatalogAdapter & CheckoutAdapter;

export type RecoveryState = Extract<OrderStatus, 'RECOVERY_REQUIRED'>;

export interface SquareAdapterErrorDetails {
  /** Set when the caller must move the order to RECOVERY_REQUIRED (FLOWS B19). */
  orderState?: RecoveryState;
  squareOrderId?: string;
  paymentLinkId?: string;
}

/** A typed adapter error. `code` is a contracts ErrorCode. */
export class SquareAdapterError extends Error {
  readonly code: ErrorCode;
  readonly orderState: RecoveryState | undefined;
  readonly squareOrderId: string | undefined;
  readonly paymentLinkId: string | undefined;

  constructor(code: ErrorCode, message: string, details: SquareAdapterErrorDetails = {}) {
    super(message);
    this.name = 'SquareAdapterError';
    this.code = code;
    this.orderState = details.orderState;
    this.squareOrderId = details.squareOrderId;
    this.paymentLinkId = details.paymentLinkId;
  }
}
