import type { Cart, CatalogModifierList, CatalogVariation, Currency, ErrorCode, Order, Quote, ToolFailure, ToolFailureReason } from '@abos/contracts';

/** One catalog_items variation row, scoped by the injected port and checked again here. */
export interface CatalogRow extends Omit<CatalogVariation, 'currency'> {
  businessId: Order['businessId'];
  catalogItemId: Cart['lines'][number]['catalogItemId'];
  currency: string;
  available: boolean;
  modifierLists: CatalogModifierList[];
}
export interface CatalogPort { list(businessId: Order['businessId']): Promise<readonly CatalogRow[]> }
/** Return only an owner-verified, current tax fact. Undefined means no verified rate exists. */
export interface VerifiedFactPort { taxRateBps(businessId: Order['businessId']): Promise<number | undefined> }
export type QuoteResult = { ok: true; quote: Quote } | (ToolFailure & { code: ToolFailureReason & ErrorCode });
export interface Bill {
  billId: string;
  businessId: Order['businessId'];
  orderId: Order['id'];
  idempotencyKey: string;
  materialHash: string;
  /** Sensitive bearer token: encrypt at rest, never log. Hash is the public lookup index. */
  token: string;
  tokenHash: string;
  businessName: string;
  pickupAt: Order['fulfillment']['pickupAt'] | undefined;
  quote: Quote;
  createdAt: string;
  expiresAt: string;
}
export interface BillStore {
  /** Private lookups must apply this business predicate in the database query. */
  findByKey(businessId: Order['businessId'], key: string): Promise<Bill | undefined>;
  /** Private lookups must apply this business predicate in the database query. */
  findById(businessId: Order['businessId'], id: string): Promise<Bill | undefined>;
  /** Indexed hash lookup, never a plain token comparison. */
  findByTokenHash(hash: string): Promise<Bill | undefined>;
  /** Atomic insert with unique idempotencyKey, billId and tokenHash. On key conflict return the stored winner.
   * A token hash collision must reject, never overwrite. Durable before this promise resolves. */
  putIfAbsent(bill: Bill): Promise<Bill>;
}
export interface BillDeps {
  catalog: CatalogPort;
  facts: VerifiedFactPort;
  business: { load(businessId: Order['businessId']): Promise<{ name: string }> };
  store: BillStore;
  /** Production must inject node:crypto randomBytes. Must supply exactly size cryptographically random bytes. */
  randomBytes(size: number): Uint8Array;
  now(): Date;
  publicBaseUrl: string;
  billTtlMs: number;
}
export interface QuoteInput { businessId: Order['businessId']; lines: Cart['lines'] }
export interface CheckoutResult {
  billId: string;
  url: string;
  /** Compatibility references only. These are local bill IDs, never evidence of a Square order or payment. */
  squareOrderId: string;
  paymentLinkId: string;
}
export type CheckoutInput = (QuoteInput & { orderId: Order['id']; pickupAt?: Order['fulfillment']['pickupAt'] } | { order: Order }) & {
  approvedTotalMinor: Quote['totalMinor']; currency: Currency; idempotencyKey: string;
  onLinkCreated?: (link: CheckoutResult) => Promise<void> | void;
};
export interface ResumeCheckoutInput {
  /** Trusted execution context, not an arbitrary request field. */
  businessId: Order['businessId'];
  /** Trusted approved subject, bound to the same execution as businessId. */
  orderId: Order['id'];
  idempotencyKey?: string;
  squareOrderId?: string;
  paymentLinkId?: string;
  approvedTotalMinor: Quote['totalMinor'];
  currency: Currency;
}
export class BillCheckoutError extends Error {
  readonly orderState: Extract<Order['status'], 'RECOVERY_REQUIRED'> | undefined;
  constructor(readonly code: ErrorCode, readonly outcome: 'not_created' | 'unknown' | 'created_unverified' | 'total_mismatch', readonly idempotencyKey: string | undefined) {
    super('The demo bill could not be prepared.');
    this.name = 'BillCheckoutError';
    this.orderState = outcome === 'total_mismatch' ? 'RECOVERY_REQUIRED' : undefined;
  }
}
