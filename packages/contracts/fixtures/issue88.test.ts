import { describe, expect, it } from 'vitest';
import { ActivityEventSchema, IntegrationHealthSchema, SyncJobSchema, STATE_MACHINES, payloadHash, type ApprovalPayload, type HoursKey, type HoursValue } from '../src/index';
import * as F from './index';

const local = (iso: string) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(iso));

function insideHours(start: string, end: string, hours: Record<HoursKey, HoursValue>, timezone: string): void {
  const parts = (iso: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const a = parts(start);
  const b = parts(end);
  const day = (a.weekday ?? '').toLowerCase() as HoursKey;
  const window = hours[day];
  expect(window).toBeDefined();
  if ('closed' in window) throw new Error('Appointment on a closed day');
  expect(`${a.hour}:${a.minute}` >= window.open).toBe(true);
  expect(`${b.hour}:${b.minute}` <= window.close).toBe(true);
  expect(a.weekday).toBe(b.weekday);
}

describe('issue 88', () => {
  it('validates an explicitly selected bundle instead of inferring another one', async () => {
    const hash: (p: ApprovalPayload, bundle?: 'booking_bundle') => Promise<string> = payloadHash;
    await expect(hash(F.approvalOrderPending.payload, 'booking_bundle')).rejects.toThrow();
  });

  it('explicit hashes validate each strict bundle and preserve legacy hashes', async () => {
    for (const a of F.approvals) {
      expect(await payloadHash(a.payload, a.bundleType)).toBe(a.payloadHash);
      const extra = { ...a.payload, unexpected: true };
      await expect(payloadHash(extra, a.bundleType)).rejects.toThrow();
      expect(await payloadHash(extra)).toBe(a.payloadHash);
      for (const wrong of ['order_bundle', 'booking_bundle', 'fact_edit', 'price_edit'] as const) {
        if (wrong !== a.bundleType) await expect(payloadHash(a.payload, wrong)).rejects.toThrow();
      }
    }
  });

  it('covers reachable states with decisions and provider uncertainty represented honestly', () => {
    const reachable = (name: keyof typeof STATE_MACHINES, state: string) => {
      const machine = STATE_MACHINES[name];
      const seen = new Set<string>(machine.initial);
      for (let i = 0; i < machine.states.length; i++) {
        for (const t of machine.transitions) if (seen.has(t.from)) seen.add(t.to);
      }
      expect(seen.has(state), `${name}: ${state}`).toBe(true);
    };
    for (const a of F.approvals) {
      reachable('approval', a.state);
      if (a.state === 'APPROVED' || a.state === 'REJECTED') expect(Date.parse(a.decidedAt ?? '')).toBeLessThan(Date.parse(a.expiresAt));
      if (a.state === 'EXPIRED') expect(Date.parse(a.decidedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(a.expiresAt));
    }
    for (const b of F.bookings) reachable('booking', b.status);
    for (const a of F.agents) reachable('agent', a.state);
    for (const e of F.executions) {
      reachable('execution', e.status);
      expect(F.approvals.find((a) => a.id === e.approvalId)?.state).toBe('APPROVED');
    }
    for (const d of F.messageDispatches) reachable('messageDispatch', d.status);
    for (const job of F.syncJobs) {
      expect(SyncJobSchema.safeParse(job).success).toBe(true);
      reachable('syncJob', job.state);
      expect(F.orders.find((o) => o.id === job.recordId)?.status).toBe('PAID_VERIFIED');
    }
    expect(F.approvalBookingRejected.state).toBe('REJECTED');
    expect(F.approvalBookingExpired.state).toBe('EXPIRED');
    expect([F.approvalFactEditApproved.state, F.approvalFactEditRejected.state, F.approvalFactEditExpired.state]).toEqual(['APPROVED', 'REJECTED', 'EXPIRED']);
    expect(F.approvalPriceEditRejected.state).toBe('REJECTED');
    expect(F.pausedAgent.state).toBe('paused');
    expect(F.syncJobRetrying).toMatchObject({ state: 'RETRYING', attempts: 2 });
    expect(F.bookingRetryRequired.status).toBe('RETRY_REQUIRED');
    expect(F.executions.some((e) => e.status === 'NEEDS_REVIEW')).toBe(true);
    const unknown = F.messageDispatches.find((d) => d.status === 'UNKNOWN');
    expect(unknown).toBeDefined();
    expect(unknown?.providerMessageId).toBeUndefined();
    expect(unknown?.sentAt).toBeUndefined();
    expect(IntegrationHealthSchema.safeParse(F.integrationHealthDisconnected).success).toBe(true);
    expect(F.integrationHealthDisconnected.google_sheets.state).toBe('disconnected');
    expect(F.pickupWindowConflict).toMatchObject({ id: 'cfl_pizza_02', required: false });
    expect(F.servicesFile.id).toBe('file_services_01');
    expect(F.kidsServiceDraftFact).toMatchObject({ confidence: 0.71, status: 'draft', fileId: 'file_services_01' });
  });

  it('mirrors database sync job limits and optional columns', () => {
    for (const state of ['PENDING', 'RUNNING', 'DONE', 'RETRYING', 'FAILED']) expect(SyncJobSchema.safeParse({ ...F.syncJobRetrying, state }).success).toBe(true);
    for (const bad of [{ attempts: -1 }, { attempts: 6 }, { attempts: 1.5 }, { state: 'SUCCEEDED' }, { target: 'sheets' }, { recordType: 'fact' }, { nextRetryAt: 'tomorrow' }]) {
      expect(SyncJobSchema.safeParse({ ...F.syncJobRetrying, ...bad }).success).toBe(false);
    }
    expect(SyncJobSchema.parse({ ...F.syncJobRetrying, externalRef: 'sheet-row-2', lastError: 'Retry pending' })).toMatchObject({ externalRef: 'sheet-row-2' });
  });

  it('uses fact.changed for conflict resolution without changing the event type vocabulary', () => {
    expect(ActivityEventSchema.parse(F.factConflictResolvedEvent)).toMatchObject({ type: 'fact.changed', payload: { resolvedConflictId: F.menuPriceConflictResolved.id } });
    expect(ActivityEventSchema.safeParse({ ...F.factConflictResolvedEvent, payload: { ...F.factConflictResolvedEvent.payload, resolvedConflictId: 'fact_wrong_prefix' } }).success).toBe(false);
  });

  it.each(['2026-11-15T07:59:00Z', '2026-11-15T20:00:00Z', '2027-03-14T09:59:00Z', '2026-11-01T09:01:00Z'])(
    'preserves authored weekdays and wall times at %s', async (now) => {
      const W = await F.materializeFixtures(new Date(now));
      for (const b of W.bookings) {
        const authored = F.bookings.find((x) => x.id === b.id);
        expect(local(b.startUtc)).toBe(local(authored?.startUtc ?? ''));
        expect(local(b.endUtc)).toBe(local(authored?.endUtc ?? ''));
        insideHours(b.startUtc, b.endUtc, W.barberHours, b.timezone);
        expect(Math.abs(Date.parse(b.startUtc) - Date.parse(now))).toBeLessThan(8 * 86400000);
      }
      for (const o of W.orders) {
        const authored = F.orders.find((x) => x.id === o.id);
        expect(local(o.fulfillment.pickupAt)).toBe(local(authored?.fulfillment.pickupAt ?? ''));
        insideHours(o.fulfillment.pickupAt, o.fulfillment.pickupAt, W.pizzaHours, W.pizzaBusiness.timezone);
      }
      for (const block of W.barberBusyBlocks) insideHours(block.startUtc, block.endUtc, W.barberHours, W.barberBusiness.timezone);
      for (const slot of W.slotConflictAlternatives) insideHours(slot.startUtc, slot.endUtc, W.barberHours, W.barberBusiness.timezone);
      for (const a of W.pendingApprovals) expect(Date.parse(a.expiresAt)).toBeGreaterThan(Date.parse(now));
      for (const a of W.approvals) expect(a.payloadHash).toBe(await payloadHash(a.payload));
    },
  );
});
