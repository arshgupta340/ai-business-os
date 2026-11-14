import type { ActivityEvent, Call, MessageDispatch, MessageDispatchStatus, Order, WebhookProvider } from '@abos/contracts';

// Square transport shapes do not exist in contracts. These are adapter ports, not API schemas.
export type PaymentOrder = Order & { locationId: string; linkReadyAt: string };
export type PaymentVerification =
  | { verified: true }
  | { verified: false; field: 'amount' | 'currency' | 'location' | 'order' }
  | { verified: false; field: 'status'; status: string };
export interface SquarePort {
  // Constant-time HMAC-SHA256 over notificationUrl followed by the exact raw bytes. Never throws on a bad header.
  verifyWebhookSignature(input: { rawBody: Buffer; signatureHeader: string | undefined; notificationUrl: string; signatureKey: string }): boolean | Promise<boolean>;
  // A fresh GetPayment read from Square, with a timeout; throw on timeout or transport failure (the caller retries).
  // verified:true only when status is COMPLETED and order_id, location_id, amount_money.amount and
  // amount_money.currency all equal `expected`, and nothing has been refunded. Report a mismatch field
  // in preference to a status. Never read amount or status from a webhook body.
  verifyPayment(input: { paymentId: string; expected: { amountMinor: Order['totalMinor']; currency: Order['currency']; locationId: string; squareOrderId: string } }): Promise<PaymentVerification>;
  // Every payment ID Square holds for this Square order (a declined attempt can precede the paid one).
  findPaymentsForOrder(squareOrderId: string): Promise<string[]>;
}
export interface ActivityPort { write(event: ActivityEvent): Promise<void> }
export interface PaymentTransaction {
  // The order re-read under the row lock.
  order: PaymentOrder | undefined;
  // ONE checked database routine, all or nothing, in this transaction: refuse unless the row is
  // PAYMENT_PENDING or PAYMENT_FAILED; save square_payment_id; move to PAID_VERIFIED; insert the unique
  // google_sheets/order sync_jobs row (on conflict do nothing) and its sync.queued event; move to
  // FULFILLMENT_READY; append `events` (status changes and payment.verified, built by the caller).
  markPaid(input: { paymentId: string; events: ActivityEvent[] }): Promise<void>;
  // ONE checked routine: refuse unless PAYMENT_PENDING; move to PAYMENT_FAILED; append `events`.
  markFailed(input: { paymentId: string; events: ActivityEvent[] }): Promise<void>;
}
export interface OrdersPort {
  // Scoped to the business. Also resolve references saved on the checkout execution before local.order.record.
  findBySquareOrderId(businessId: Order['businessId'], squareOrderId: string): Promise<PaymentOrder | undefined>;
  // Orders in PAYMENT_PENDING or PAYMENT_FAILED whose payment link is still inside the poll window.
  listWaitingForPayment(): Promise<PaymentOrder[]>;
  // BEGIN; SELECT ... FOR UPDATE; fn; COMMIT (ROLLBACK on throw). fn makes no network call, so the
  // transaction stays short. Must serialize across server processes.
  withLockedOrder(orderId: Order['id'], fn: (tx: PaymentTransaction) => Promise<void>): Promise<void>;
}
export interface StoredWebhook {
  id: string;
  source: 'square' | 'twilio_status';
  providerEventId: string;
  eventType: string;
  businessId: Order['businessId'];
  payload: Record<string, string>;
}
export interface WebhookStore {
  // Persist only sanitized verified fields. Unique on (source, providerEventId).
  // New rows must remain pending until the durable job completes, including enqueue failures.
  recordOnce(input: Omit<StoredWebhook, 'id'>): Promise<StoredWebhook | undefined>;
}
export interface WebhookDependencies {
  config: { squareNotificationUrl: string; squareSignatureKey: string; twilioStatusUrl: string };
  square: SquarePort;
  store: WebhookStore;
  orders: OrdersPort;
  // Used only to attribute webhook.rejected (SPEC 2.9). Verified events take the business of the row they touch.
  integrations: { findOwner(provider: WebhookProvider, notificationUrl: string): Promise<{ businessId: Order['businessId'] } | undefined> };
  twilio: { validate(input: { notificationUrl: string; signatureHeader: string | undefined; params: Record<string, string> }): boolean | Promise<boolean> };
  calls: {
    findByProviderId(id: string): Promise<Pick<Call, 'id' | 'businessId' | 'startedAt'> | undefined>;
    // Conditional terminal update shared with stream stop; true for the winner only.
    endOnce(id: Call['id'], status: Call['status'], endedAt: string): Promise<boolean>;
  };
  dispatch: {
    findByProviderId(id: string): Promise<Pick<MessageDispatch, 'id' | 'businessId' | 'subjectId' | 'channel'> | undefined>;
    // Monotonic: never regress DELIVERED to SENT or replace a terminal status.
    updateStatus(id: string, status: MessageDispatchStatus): Promise<boolean>;
  };
  activity: ActivityPort;
  clock: { now(): Date };
  // Persist the webhook row ID for retries. Execute run only after the HTTP response.
  // Recover pending rows if enqueue fails or the process restarts. Never log raw errors.
  jobs: { enqueue(webhookId: StoredWebhook['id'], run: () => Promise<void>): Promise<void> };
}
