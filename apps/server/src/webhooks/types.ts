import type { ActivityEvent, Call, MessageDispatch, MessageDispatchStatus, Order, WebhookProvider } from '@abos/contracts';

// Square transport shapes do not exist in contracts. These are adapter ports, not API schemas.
export type PaymentOrder = Order & { locationId: string; linkReadyAt: string };
export type PaymentVerification =
  | { verified: true }
  | { verified: false; field: 'amount' | 'currency' | 'location' | 'order' }
  | { verified: false; field: 'status'; status: string };
export interface SquarePort {
  verifyWebhookSignature(input: { rawBody: Buffer; signatureHeader: string | undefined; notificationUrl: string; signatureKey: string }): boolean | Promise<boolean>;
  verifyPayment(input: { paymentId: string; expected: { amountMinor: Order['totalMinor']; currency: Order['currency']; locationId: string; squareOrderId: string } }): Promise<PaymentVerification>;
  findPaymentForOrder(squareOrderId: string): Promise<string | undefined>;
}
export interface ActivityPort { write(event: ActivityEvent): Promise<void> }
export interface SyncPort {
  // Create a unique local sync job only. The original order approval authorizes the Sheets step.
  queueOrder(order: Order): Promise<void>;
}
export interface PaymentTransaction {
  order: PaymentOrder | undefined;
  savePaymentId(paymentId: string): Promise<void>;
  move(to: Order['status']): Promise<void>;
  activity: ActivityPort;
  sync: SyncPort;
}
export interface OrdersPort {
  // Also resolve references saved on the checkout execution before local.order.record.
  findBySquareOrderId(squareOrderId: string): Promise<PaymentOrder | undefined>;
  listWaitingForPayment(): Promise<PaymentOrder[]>;
  // Lock and re-read the row. All moves, payment ID, activity and sync writes in the
  // callback commit or roll back together. This must serialize across server processes.
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
