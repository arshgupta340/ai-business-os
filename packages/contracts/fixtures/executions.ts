// Action executions and message dispatches for the approved bundles (FLOWS 3.3, 3.4).
// The Sheets step never has an execution row (SPEC 2.9). Keys are real SPEC 2.9 idempotency keys.
import {
  ACTION_TYPE_CAPABILITY,
  executionStepsFor,
  type ActionExecution,
  type ApprovalRequest,
  type ExecutionActionType,
  type ExecutionStatus,
  type MessageDispatch,
} from '../src/index';
import {
  approvalBookingConflict,
  approvalBookingVerified,
  approvalOrderFulfilled,
  approvalOrderPaid,
  approvalOrderPaymentFailed,
  approvalOrderPaymentPending,
} from './approvals';
import { storedKey } from './hashes';
import { addMs } from './world';

type StepOutcome = { status: ExecutionStatus; attempts: number; externalRef?: string; errorCode?: ActionExecution['errorCode']; lastError?: string; doneAfterMs: number };

/** Execution ID for an approval and step: `exe_demo_<n>_<stepIndex>`. */
export function executionId(approval: ApprovalRequest, stepIndex: number): string {
  return `exe_demo_${approval.id.replace('apv_demo_', '')}_${stepIndex}`;
}

function executionsFor(approval: ApprovalRequest, outcomes: Partial<Record<ExecutionActionType, StepOutcome>>): ActionExecution[] {
  const createdAt = approval.decidedAt ?? approval.createdAt;
  const rows: ActionExecution[] = [];
  for (const { actionType, stepIndex } of executionStepsFor(approval.bundleType)) {
    const o = outcomes[actionType];
    if (o === undefined) continue;
    const id = executionId(approval, stepIndex);
    const row: ActionExecution = {
      id,
      businessId: approval.businessId,
      approvalId: approval.id,
      actionType,
      stepIndex,
      idempotencyKey: storedKey(`idem:${id}`),
      status: o.status,
      attempts: o.attempts,
      createdAt,
      updatedAt: addMs(createdAt, o.doneAfterMs),
    };
    const cap = ACTION_TYPE_CAPABILITY[actionType];
    if (cap !== null) row.capabilityId = cap;
    if (o.externalRef !== undefined) row.externalRef = o.externalRef;
    if (o.errorCode !== undefined) row.errorCode = o.errorCode;
    if (o.lastError !== undefined) row.lastError = o.lastError;
    rows.push(row);
  }
  return rows;
}

const ok = (doneAfterMs: number, externalRef?: string): StepOutcome =>
  externalRef === undefined ? { status: 'SUCCEEDED', attempts: 1, doneAfterMs } : { status: 'SUCCEEDED', attempts: 1, doneAfterMs, externalRef };

/** The timeline order: link created, text sent by Surge, recorded. */
export const executionsOrderFulfilled = executionsFor(approvalOrderFulfilled, {
  'square.checkout.create': ok(3000, 'SQ_PAYLINK_DEMO_01'),
  'message.checkout.send': ok(5000, 'msg_demo_01'),
  'local.order.record': ok(6000),
});

/** `qr_only`: the message step is SKIPPED and no dispatch row exists (SPEC 2.9). */
export const executionsOrderPaid = executionsFor(approvalOrderPaid, {
  'square.checkout.create': ok(3000, 'SQ_PAYLINK_DEMO_02'),
  'message.checkout.send': { status: 'SKIPPED', attempts: 0, doneAfterMs: 3500 },
  'local.order.record': ok(4000),
});

export const executionsOrderPaymentPending = executionsFor(approvalOrderPaymentPending, {
  'square.checkout.create': ok(3000, 'SQ_PAYLINK_DEMO_03'),
  'message.checkout.send': ok(5000, 'msg_demo_03'),
  'local.order.record': ok(6000),
});

export const executionsOrderPaymentFailed = executionsFor(approvalOrderPaymentFailed, {
  'square.checkout.create': ok(3000, 'SQ_PAYLINK_DEMO_07'),
  'message.checkout.send': ok(5000, 'msg_demo_07'),
  'local.order.record': ok(6000),
});

/** The timeline booking. The Google event ID is the calendar step's key (FLOWS C8). */
export const executionsBookingVerified = executionsFor(approvalBookingVerified, {
  'calendar.event.create': ok(3000, storedKey('idem:exe_demo_b02_0')),
  'message.booking.confirm': ok(5000, 'msg_demo_b02'),
  'local.booking.record': ok(6000),
});

/**
 * The fresh free/busy read found the slot busy (FLOWS X1). Only the calendar step is listed: FLOWS X4 says
 * the later steps do not run, and it does not say whether their rows exist.
 */
export const executionsBookingConflict = executionsFor(approvalBookingConflict, {
  'calendar.event.create': { status: 'FAILED', attempts: 1, errorCode: 'SLOT_CONFLICT', lastError: 'Fresh free/busy read shows the slot busy. No event created.', doneAfterMs: 2000 },
});

export const executions: ActionExecution[] = [
  ...executionsOrderFulfilled,
  ...executionsOrderPaid,
  ...executionsOrderPaymentPending,
  ...executionsOrderPaymentFailed,
  ...executionsBookingVerified,
  ...executionsBookingConflict,
];

function execution(id: string): ActionExecution {
  const e = executions.find((x) => x.id === id);
  if (e === undefined) throw new Error(`fixture dispatch: unknown execution ${id}`);
  return e;
}

type DispatchInput = Pick<MessageDispatch, 'id' | 'subjectId' | 'channel' | 'recipient' | 'template' | 'status'> & {
  executionId: string;
  providerMessageId: string;
  deliveredAfterMs?: number;
};

function dispatch(d: DispatchInput): MessageDispatch {
  const e = execution(d.executionId);
  const sentAt = e.updatedAt;
  const row: MessageDispatch = {
    id: d.id,
    businessId: e.businessId,
    executionId: e.id,
    subjectId: d.subjectId,
    channel: d.channel,
    recipient: d.recipient,
    template: d.template,
    status: d.status,
    providerMessageId: d.providerMessageId,
    idempotencyKey: e.idempotencyKey, // one dispatch row per step key
    sentAt,
    createdAt: e.createdAt,
    updatedAt: sentAt,
  };
  if (d.deliveredAfterMs !== undefined) {
    row.deliveredAt = addMs(sentAt, d.deliveredAfterMs);
    row.updatedAt = row.deliveredAt;
  }
  return row;
}

export const messageDispatches: MessageDispatch[] = [
  dispatch({ id: 'msg_demo_01', executionId: 'exe_demo_01_1', subjectId: 'ord_demo_01', channel: 'surge', recipient: '+15555550123',
    template: 'checkout_link', status: 'DELIVERED', providerMessageId: 'surge_demo_01', deliveredAfterMs: 4000 }),
  dispatch({ id: 'msg_demo_03', executionId: 'exe_demo_03_1', subjectId: 'ord_demo_03', channel: 'surge', recipient: '+15555550125',
    template: 'checkout_link', status: 'SENT', providerMessageId: 'surge_demo_03' }),
  dispatch({ id: 'msg_demo_07', executionId: 'exe_demo_07_1', subjectId: 'ord_demo_07', channel: 'surge', recipient: '+15555550129',
    template: 'checkout_link', status: 'DELIVERED', providerMessageId: 'surge_demo_07', deliveredAfterMs: 3000 }),
  dispatch({ id: 'msg_demo_b02', executionId: 'exe_demo_b02_1', subjectId: 'bkg_demo_b02', channel: 'surge', recipient: '+15555550141',
    template: 'booking_confirmed', status: 'SENT', providerMessageId: 'surge_demo_b02' }),
];
