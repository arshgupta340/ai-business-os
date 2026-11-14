import type { ActionType, BundleType, CapabilityId, ExecutionActionType } from './enums';

/** SPEC 2.3: the ordered action types of each bundle. The database pins `action_bundle` to exactly these lists. */
export const BUNDLE_ACTIONS = {
  order_bundle: ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'],
  booking_bundle: ['calendar.event.create', 'message.booking.confirm', 'local.booking.record', 'sheets.booking.append'],
  fact_edit: ['local.fact.update'],
  price_edit: ['square.catalog.price.update', 'local.catalog.sync'],
} as const satisfies Record<BundleType, readonly ActionType[]>;

export type BundleActions<B extends BundleType> = (typeof BUNDLE_ACTIONS)[B];

/** SPEC 2.3: the capability each action type exercises. `null` for the internal `local.*` steps. */
export const ACTION_TYPE_CAPABILITY: Record<ActionType, CapabilityId | null> = {
  'square.checkout.create': 'order.checkout.prepare',
  'message.checkout.send': 'message.checkout.send',
  'local.order.record': null,
  'sheets.order.append': 'sheets.rows.append',
  'calendar.event.create': 'calendar.event.create',
  'message.booking.confirm': 'message.booking.confirm',
  'local.booking.record': null,
  'sheets.booking.append': 'sheets.rows.append',
  'local.fact.update': null,
  'square.catalog.price.update': 'catalog.price.update',
  'local.catalog.sync': null,
};

/** SPEC 2.9: steps authorized at approval but run later, by a sync job created on PAID_VERIFIED or BOOKED_VERIFIED. */
export const DEFERRED_ACTION_TYPES = ['sheets.order.append', 'sheets.booking.append'] as const satisfies readonly ActionType[];

/** The message steps. Under `qr_only` their execution is `SKIPPED` and no dispatch row is created. */
export const MESSAGE_ACTION_TYPES = ['message.checkout.send', 'message.booking.confirm'] as const satisfies readonly ActionType[];

export function isDeferredActionType(actionType: ActionType): boolean {
  return (DEFERRED_ACTION_TYPES as readonly ActionType[]).includes(actionType);
}

/** The `action_executions` rows to insert when a bundle is approved, with their `stepIndex` (position in the bundle). */
export function executionStepsFor(bundleType: BundleType): { actionType: ExecutionActionType; stepIndex: number }[] {
  const steps: { actionType: ExecutionActionType; stepIndex: number }[] = [];
  const actions: readonly ActionType[] = BUNDLE_ACTIONS[bundleType];
  actions.forEach((actionType, stepIndex) => {
    if (!isDeferredActionType(actionType)) steps.push({ actionType: actionType as ExecutionActionType, stepIndex });
  });
  return steps;
}
