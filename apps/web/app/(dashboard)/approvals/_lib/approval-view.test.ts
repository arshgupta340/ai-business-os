import {describe, expect, it} from 'vitest';
import {
  ActionTypeSchema,
  ApprovalActorTypeSchema,
  BundleTypeSchema,
  ErrorCodeSchema,
  FactKindSchema,
  MessageChannelSettingSchema,
} from '@abos/contracts';
import {ApiError} from '@/lib/api/errors';
import {ERROR_TEXT, GENERIC_ERROR_TEXT} from '@/lib/error-text';
import {approvalActorLabel, bundleLabel, factKeyLabel, factKindLabel} from '@/lib/labels';
import {expectOwnerLabel, FUTURE_VALUES} from '@/lib/owner-label.test-helpers';
import type {ApprovalRequest, OrderApprovalRequest} from '@/lib/api';
import {
  actionSteps,
  canDecide,
  decisionErrorView,
  effectiveState,
  formatFactValue,
  recipientLabel,
  sortInbox,
  summaryLine,
  typedApproval,
} from './approval-view';

const NOW = Date.parse('2026-11-13T19:45:00Z');

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const actionBundle = ['square.checkout.create', 'message.checkout.send', 'local.order.record', 'sheets.order.append'] as OrderApprovalRequest['actionBundle'];
  return {
    id: 'apv_1',
    businessId: 'biz_pizza_01',
    actorType: 'deployed_agent',
    bundleType: 'order_bundle',
    actionBundle,
    subjectId: 'ord_1',
    payload: {
      businessId: 'biz_pizza_01',
      subjectId: 'ord_1',
      agentVersionId: 'agv_1',
      cartHash: 'sha256:c',
      totalMinor: 3264,
      currency: 'USD',
      pickupAt: '2026-11-14T02:00:00Z',
      messageRecipient: '+15555550123',
      messageChannel: 'surge',
      actionBundle,
      expiresAt: '2026-11-13T19:52:00Z',
    },
    payloadHash: 'sha256:h',
    state: 'PENDING',
    expiresAt: '2026-11-13T19:52:00Z',
    createdAt: '2026-11-13T19:42:00Z',
    ...over,
  } as ApprovalRequest;
}

function err(init: Partial<ConstructorParameters<typeof ApiError>[0]>): ApiError {
  return new ApiError({code: 'INTERNAL', message: 'Boom', status: 500, retryable: true, kind: 'http', ...init});
}

describe('expiry', () => {
  it('stays pending while time is left and becomes expired at zero', () => {
    const a = approval();
    expect(effectiveState(a, NOW)).toBe('PENDING');
    expect(canDecide(a, NOW)).toBe(true);
    expect(effectiveState(a, Date.parse('2026-11-13T19:52:00Z'))).toBe('EXPIRED');
    expect(canDecide(a, Date.parse('2026-11-13T19:52:01Z'))).toBe(false);
  });

  it('never lets a decided or expired request be acted on', () => {
    for (const state of ['APPROVED', 'REJECTED', 'EXPIRED'] as const) {
      expect(canDecide(approval({state}), NOW)).toBe(false);
      expect(effectiveState(approval({state}), NOW)).toBe(state);
    }
  });
});

describe('sortInbox', () => {
  it('puts pending first by soonest expiry, then the rest newest first', () => {
    const items = [
      approval({id: 'old_rej', state: 'REJECTED', decidedAt: '2026-11-13T18:00:00Z'}),
      approval({id: 'p_late', expiresAt: '2026-11-13T19:55:00Z'}),
      approval({id: 'new_exp', state: 'EXPIRED', createdAt: '2026-11-13T19:00:00Z'}),
      approval({id: 'p_soon', expiresAt: '2026-11-13T19:47:00Z'}),
    ];
    expect(sortInbox(items).map((a) => a.id)).toEqual(['p_soon', 'p_late', 'new_exp', 'old_rej']);
  });
});

describe('labels', () => {
  it('redacts the recipient to the last four digits', () => {
    expect(recipientLabel('+15555550123')).toBe('phone ending 0123');
  });

  it('summarizes an order from the hashed payload', () => {
    expect(summaryLine(approval(), 'America/Los_Angeles')).toBe('Pickup Nov 13, 6:00 PM, link to phone ending 0123');
  });

  it('says QR code only when the business sends no message, even with a recipient on file', () => {
    const base = approval();
    const qr = {...base, payload: {...base.payload, messageChannel: 'qr_only'}} as ApprovalRequest;
    expect(summaryLine(qr, 'America/Los_Angeles')).toBe('Pickup Nov 13, 6:00 PM, QR code only, no message is sent');
  });

  it('summarizes a fact edit with the current value, and a new fact without one', () => {
    const edit = (before: unknown) =>
      ({
        ...approval(),
        bundleType: 'fact_edit',
        subjectId: 'fact_1',
        payload: {businessId: 'biz_pizza_01', subjectId: 'fact_1', kind: 'hours', key: 'fri', before, after: {open: '11:00', close: '23:00'}, fromVersion: before ? 1 : 0, actionBundle: ['local.fact.update'], expiresAt: '2026-11-13T19:52:00Z'},
      }) as unknown as ApprovalRequest;
    expect(summaryLine(edit({open: '11:00', close: '22:00'}), 'America/Los_Angeles')).toBe('Opening hours, Friday: 11:00 to 23:00 (now 11:00 to 22:00)');
    expect(summaryLine(edit(null), 'America/Los_Angeles')).toBe('Opening hours, Friday: 11:00 to 23:00 (new fact)');
  });

  it('formats hours values, closed days and a new fact', () => {
    expect(formatFactValue('hours', {open: '11:00', close: '22:00'})).toBe('11:00 to 22:00');
    expect(formatFactValue('hours', {closed: true})).toBe('Closed');
    expect(formatFactValue('hours', null)).toBe('Not set yet (new fact)');
    expect(formatFactValue('policy', 'Pickup in 20 minutes')).toBe('Pickup in 20 minutes');
  });

  it('maps every order step to the system it writes and flags an unknown step', () => {
    const steps = actionSteps(typedApproval(approval()));
    expect(steps.map((s) => s.system)).toEqual(['Square (sandbox)', 'Surge text message', 'This app', 'Google Sheets']);
    expect(steps.map((s) => s.isExternal)).toEqual([true, true, false, true]);
    const odd = approval();
    (odd.payload as {actionBundle: string[]}).actionBundle = ['square.refund.create'];
    expect(actionSteps(typedApproval(odd))[0]).toMatchObject({isUnknown: true});
  });
});

describe('decisionErrorView', () => {
  it('asks for a reload on a payload hash mismatch', () => {
    const v = decisionErrorView(err({code: 'PAYLOAD_HASH_MISMATCH', status: 409, retryable: false}));
    expect(v.next).toBe('reload');
    expect(v.title).toBe('This request changed since you opened it');
  });

  it('reports the recorded state for an already decided request', () => {
    const v = decisionErrorView(err({code: 'APPROVAL_ALREADY_DECIDED', status: 409, retryable: false, details: {state: 'APPROVED'}}));
    expect(v.decidedState).toBe('APPROVED');
    expect(v.next).toBe('none');
  });

  it('says nothing was sent for an expired request and a sandbox mismatch', () => {
    expect(decisionErrorView(err({code: 'APPROVAL_EXPIRED', status: 409, retryable: false})).title).toBe('Expired, nothing was sent');
    expect(decisionErrorView(err({code: 'ENVIRONMENT_MISMATCH', status: 503, retryable: false})).message).toBe(
      'Square is not in sandbox. Nothing was sent.',
    );
  });

  it('sends a missing request back to the list', () => {
    expect(decisionErrorView(err({code: 'NOT_FOUND', status: 404, retryable: false})).next).toBe('close');
  });

  it('offers a retry on a network failure and keeps the correlation ID', () => {
    const v = decisionErrorView(err({kind: 'network', status: 0, correlationId: 'corr_1'}));
    expect(v.next).toBe('retry');
    expect(v.correlationId).toBe('corr_1');
  });
});

describe('price edit names its item', () => {
  it('names the catalog item and size in the inbox line', async () => {
    const {approvalPriceEditPending, pizzaCatalog} = await import('@abos/contracts/fixtures');
    const {summaryLine, variationName} = await import('./approval-view');
    const a = approvalPriceEditPending as unknown as ApprovalRequest;
    const p = approvalPriceEditPending.payload;
    expect(variationName(pizzaCatalog, p.squareItemId, p.variationId)).toBe('Pepperoni, Large');
    expect(summaryLine(a, 'America/Los_Angeles', pizzaCatalog)).toBe('Pepperoni, Large, $22.00 to $19.00');
  });

  it('says it is a catalog item when the catalog is not loaded or lacks the variation', async () => {
    const {approvalPriceEditPending} = await import('@abos/contracts/fixtures');
    const {summaryLine} = await import('./approval-view');
    const a = approvalPriceEditPending as unknown as ApprovalRequest;
    expect(summaryLine(a, 'America/Los_Angeles')).toBe('An item in the Square catalog, $22.00 to $19.00');
    expect(summaryLine(a, 'America/Los_Angeles', [])).toBe('An item in the Square catalog, $22.00 to $19.00');
  });
});

/** expectOwnerLabel, plus no dotted identifier such as "square.checkout.create". */
function expectPlain(text: string, raw: string): void {
  expectOwnerLabel(text, raw);
  expect(text, `${JSON.stringify(text)} has a dotted identifier`).not.toMatch(/[a-z]\.[a-z]/);
}

describe('no raw contract value reaches the owner (#123)', () => {
  const withChannel = (channel: string, actionBundle: readonly string[]) => {
    const base = approval();
    return {...base, payload: {...base.payload, messageChannel: channel, actionBundle}} as ApprovalRequest;
  };

  it.each(MessageChannelSettingSchema.options)('names the %s channel plainly in the step list', (channel) => {
    for (const step of ['message.checkout.send', 'message.booking.confirm']) {
      const [view] = actionSteps(typedApproval(withChannel(channel, [step])));
      expectPlain(view.system, channel);
      expectPlain(view.description, channel);
      expect(view.system).not.toContain(channel);
    }
  });

  it('says no message is sent when the business is QR code only', () => {
    const [view] = actionSteps(typedApproval(withChannel('qr_only', ['message.checkout.send'])));
    expect(view.system).toBe('QR code only');
    expect(view.description).toContain('No message is sent');
  });

  it('describes every step of the contract, and an unknown step, with no raw identifier in the sentence', () => {
    for (const step of [...ActionTypeSchema.options, ...FUTURE_VALUES]) {
      const [view] = actionSteps(typedApproval(withChannel('surge', [step])));
      expectPlain(view.system, step);
      expectPlain(view.description, step);
    }
  });

  it('uses the shared bundle names, so a request reads the same on every screen', () => {
    for (const bundle of BundleTypeSchema.options) expectPlain(bundleLabel(bundle), bundle);
    expect(bundleLabel('fact_edit')).toBe('Business fact change');
    expect(bundleLabel('price_edit')).toBe('Price change');
  });

  it('labels every fact kind and every actor, and a value it does not know', () => {
    for (const kind of [...FactKindSchema.options, ...FUTURE_VALUES]) {
      expectPlain(factKindLabel(kind), kind);
      expectPlain(factKeyLabel(kind, 'pickup_window'), 'pickup_window');
    }
    for (const actor of [...ApprovalActorTypeSchema.options, ...FUTURE_VALUES]) expectPlain(approvalActorLabel(actor), actor);
    expect(approvalActorLabel('system')).not.toBe(approvalActorLabel('deployed_agent'));
  });

  it('summarizes a fact edit of every kind with no raw kind or key', () => {
    for (const kind of FactKindSchema.options) {
      const a = {
        ...approval(),
        bundleType: 'fact_edit',
        subjectId: 'fact_1',
        payload: {businessId: 'biz_pizza_01', subjectId: 'fact_1', kind, key: 'pickup_window', before: null, after: 'Twenty minutes', fromVersion: 0, actionBundle: ['local.fact.update'], expiresAt: '2026-11-13T19:52:00Z'},
      } as unknown as ApprovalRequest;
      const line = summaryLine(a, 'America/Los_Angeles');
      expect(line).not.toContain('pickup_window');
      expectOwnerLabel(line, kind);
    }
  });
});

describe('a failed decision never shows the server message (part of #128)', () => {
  it('shows the sentence for an error code the screen does not handle', () => {
    for (const code of ErrorCodeSchema.options) {
      const v = decisionErrorView(err({code, message: 'Operation failed: INVALID_STATE.', retryable: false}));
      expectPlain(v.message, code);
      expect(v.message).not.toContain('Operation failed');
      expectPlain(v.title, code);
    }
    expect(decisionErrorView(err({code: 'INVALID_STATE', message: 'Operation failed: INVALID_STATE.'})).message).toBe(ERROR_TEXT.INVALID_STATE);
    expect(decisionErrorView(err({code: 'BRAND_NEW' as never, message: 'Operation failed: BRAND_NEW.'})).message).toBe(GENERIC_ERROR_TEXT);
  });
});
