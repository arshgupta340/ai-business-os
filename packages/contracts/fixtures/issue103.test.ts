// Issue #103: what looked wrong on screen once the web mock ran on the shared fixtures.
// One block per issue item: each test names the value a screen would get. Then the invariants every
// fixture change must keep, checked on the stored fixtures and after materializeFixtures at several clocks.
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_EXPIRY_MS,
  ActionExecutionSchema,
  ActivityEventSchema,
  AgentSchema,
  AgentVersionSchema,
  ApprovalRequestSchema,
  BookingSchema,
  BusinessFactSchema,
  CallSchema,
  ExecutionFailedEventSchema,
  FactConflictSchema,
  FileRecordSchema,
  IntegrationHealthSchema,
  MessageDispatchSchema,
  OrderSchema,
  STATE_MACHINES,
  SyncJobSchema,
  approvalPayloadHash,
  hashCanonical,
  type HoursKey,
  type HoursValue,
} from '../src/index';
import * as F from './index';
import { materializeFixtures, type FixtureWorld } from './index';
import { GENERATED_HASHES } from './hashes.generated';
import { BASELINE_ALL_IDS, BASELINE_HASHES, BASELINE_LIST_IDS } from './baseline-103';

const ms = (iso: string) => Date.parse(iso);

/** The clocks the invariants are checked at, besides the stored snapshot. */
const CLOCKS = [
  ['late at night (23:59 PST)', '2026-11-15T07:59:00Z'],
  ['a Sunday at noon', '2026-11-15T20:00:00Z'],
  ['a Monday, when the barbershop is closed', '2026-11-16T18:00:00Z'],
  ['one minute before the spring daylight-saving change', '2027-03-14T09:59:00Z'],
  ['one minute after the spring daylight-saving change', '2027-03-14T10:01:00Z'],
  ['just after the autumn daylight-saving change', '2026-11-01T09:01:00Z'],
  ['a time with milliseconds', '2027-07-04T03:15:42.250Z'],
] as const;

/** The stored world and one materialized world per clock. */
async function worlds(): Promise<[string, FixtureWorld, number][]> {
  const out: [string, FixtureWorld, number][] = [['the stored snapshot', F as unknown as FixtureWorld, ms(F.FIXTURE_NOW)]];
  for (const [label, iso] of CLOCKS) out.push([label, await materializeFixtures(new Date(iso)), ms(iso)]);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The issue items

describe('issue 103, item 1: each booking has its own call', () => {
  it('no call is shared by two bookings or by a booking and an order', () => {
    const owners = new Map<string, string[]>();
    for (const x of [...F.orders, ...F.bookings]) {
      if (x.callId === undefined) continue;
      owners.set(x.callId, [...(owners.get(x.callId) ?? []), x.id]);
    }
    const shared = [...owners].filter(([, subjects]) => subjects.length > 1).map(([callId, subjects]) => `${callId}: ${subjects.join(', ')}`);
    // Live operations shows one row per call. Before: call_demo_b01 carried four bookings, call_demo_b02 two.
    expect(shared).toEqual([]);
  });

  it('each booking call exists, belongs to the barbershop agent and covers the moment of the proposal', () => {
    for (const b of F.bookings) {
      const call = F.calls.find((c) => c.id === b.callId);
      expect(call, b.id).toBeDefined();
      if (call === undefined) continue;
      expect(call.businessId, b.id).toBe(b.businessId);
      expect(ms(call.startedAt), b.id).toBeLessThan(ms(b.createdAt));
      expect(ms(call.endedAt ?? ''), b.id).toBeGreaterThanOrEqual(ms(b.createdAt));
      expect(call.stage, b.id).toBe('CUSTOMER_CONFIRMED');
    }
  });

  it('the rows of the booking list do not all show the same customer name', () => {
    const names = F.bookings.map((b) => b.customer.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no two phone calls from the same caller digits are on the line at the same time', () => {
    const phone = F.calls.filter((c) => c.channel === 'phone' && c.callerLast4 !== undefined);
    for (const a of phone) {
      for (const b of phone) {
        if (a.id >= b.id || a.callerLast4 !== b.callerLast4) continue;
        const overlap = ms(a.startedAt) < ms(b.endedAt ?? F.FIXTURE_NOW) && ms(b.startedAt) < ms(a.endedAt ?? F.FIXTURE_NOW);
        expect(overlap, `${a.id} and ${b.id}`).toBe(false);
      }
    }
  });
});

describe('issue 103, item 2: a subject and its approval payload write the same instant the same way', () => {
  it('booking startUtc and endUtc are the payload strings (the approval screen compared text)', async () => {
    for (const [label, W] of await worlds()) {
      for (const a of W.approvals) {
        if (a.bundleType !== 'booking_bundle') continue;
        const b = W.bookings.find((x) => x.id === a.subjectId);
        expect([b?.startUtc, b?.endUtc], `${label} ${a.id}`).toEqual([a.payload.startUtc, a.payload.endUtc]);
      }
    }
  });

  it('order pickupAt is the payload string too', async () => {
    for (const [label, W] of await worlds()) {
      for (const a of W.approvals) {
        if (a.bundleType !== 'order_bundle') continue;
        const o = W.orders.find((x) => x.id === a.subjectId);
        expect(o?.fulfillment.pickupAt, `${label} ${a.id}`).toBe(a.payload.pickupAt);
      }
    }
  });
});

describe('issue 103, item 3: an execution that stopped says why', () => {
  it('every FAILED or NEEDS_REVIEW execution has an errorCode, so its execution.failed event can be written', () => {
    const stopped = F.executions.filter((e) => e.status === 'FAILED' || e.status === 'NEEDS_REVIEW');
    expect(stopped.map((e) => e.status)).toContain('NEEDS_REVIEW');
    for (const e of stopped) {
      expect(e.errorCode, e.id).toBeDefined();
      expect(e.lastError, e.id).toBeDefined();
      // The event the server writes for this row (CONTRACTS 7). errorCode is required there.
      const event = {
        id: 'evt_check', businessId: e.businessId, type: 'execution.failed', correlationId: e.approvalId, actorType: 'system', occurredAt: e.updatedAt,
        payload: { executionId: e.id, actionType: e.actionType, errorCode: e.errorCode, retryable: false, nextStatus: e.status },
      };
      expect(ExecutionFailedEventSchema.safeParse(event).success, e.id).toBe(true);
    }
  });
});

describe('issue 103, item 4: the stored history has no event for something that has not happened', () => {
  it('no fact.changed in the history resolves a conflict that is still open', () => {
    const open = new Set(F.factConflicts.filter((c) => c.state === 'open').map((c) => c.id));
    const wrong = F.allActivityEvents.flatMap((e) => (e.type === 'fact.changed' && e.payload.resolvedConflictId !== undefined && open.has(e.payload.resolvedConflictId) ? [e.id] : []));
    expect(wrong).toEqual([]);
  });

  it('no stored event is later than the fixture clock', async () => {
    for (const [label, W, now] of await worlds()) {
      const future = W.allActivityEvents.filter((e) => ms(e.occurredAt) > now).map((e) => e.id);
      expect(future, label).toEqual([]);
    }
  });

  it('the resolution event is still exported as the example of a resolve response', () => {
    expect(ActivityEventSchema.safeParse(F.factConflictResolvedEvent).success).toBe(true);
    expect(F.factConflictResolvedEvent.id).toBe('evt_conflict_resolved_88');
  });
});

describe('issue 103, item 5: menu_item drafts and price conflicts have the documented shape (CONTRACTS 3)', () => {
  const menuDrafts = F.allFacts.filter((f) => f.kind === 'menu_item');

  it('value is { itemName, variationName?, priceMinor, currency } and the key is the two names, lower case, joined by a colon', () => {
    expect(menuDrafts.length).toBeGreaterThan(0);
    for (const f of menuDrafts) {
      const v = f.value as Record<string, unknown>;
      expect(Object.keys(v).sort(), f.id).toEqual(['currency', 'itemName', 'priceMinor', 'variationName']);
      expect(typeof v.itemName, f.id).toBe('string');
      expect(Number.isInteger(v.priceMinor), f.id).toBe(true);
      expect(v.currency, f.id).toBe('USD');
      // The slug of apps/server/src/builder/extraction/sanitize.ts.
      const slug = (s: unknown) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '_');
      expect(f.key, f.id).toBe(`${slug(v.itemName)}:${slug(v.variationName)}`);
      expect(f.status, f.id).toBe('draft');
    }
  });

  it('a price conflict has the key of its draft, the draft value on the upload candidate and the catalog row on the square candidate', () => {
    const priceConflicts = [...F.factConflicts, F.menuPriceConflictResolved].filter((c) => c.kind === 'menu_item');
    expect(priceConflicts.length).toBeGreaterThan(0);
    for (const c of priceConflicts) {
      const upload = c.candidates.find((x) => x.sourceType === 'upload');
      const square = c.candidates.find((x) => x.sourceType === 'square');
      const draft = F.allFacts.find((f) => f.id === upload?.factId);
      expect(draft?.key, c.id).toBe(c.key);
      expect(upload?.value, c.id).toMatchObject(draft?.value as Record<string, unknown>);
      const row = F.pizzaCatalogRows.find((r) => r.id === square?.sourceRef);
      expect(row, c.id).toBeDefined();
      expect(square?.value, c.id).toMatchObject({ itemName: row?.itemName, variationName: row?.variationName, priceMinor: row?.priceMinor, currency: row?.currency });
      // The names pick the same catalog row the fixture's extra variationId does.
      const v = draft?.value as { itemName: string; variationName: string };
      expect([row?.itemName, row?.variationName], c.id).toEqual([v.itemName, v.variationName]);
      for (const cand of c.candidates) expect((cand.value as { variationId?: string }).variationId, c.id).toBe(row?.squareVariationId);
    }
  });
});

describe('issue 103, item 6: no two agents of one business have the same name', () => {
  // The paused agent has its own name. AgentPreviewScreen.test.tsx builds its same-name case inside the test.
  it('My Agents and Overview show different names', () => {
    for (const business of F.businesses) {
      const names = F.agents.filter((a) => a.businessId === business.id).map((a) => a.name);
      expect(new Set(names).size, `${business.id}: ${names.join(' | ')}`).toBe(names.length);
    }
  });

  it('an agent, its draft spec and its active version carry one name', () => {
    for (const a of F.agents) {
      expect(a.draftSpec.name, a.id).toBe(a.name);
      if (a.activeVersion !== undefined) expect(a.activeVersion.spec.name, a.id).toBe(a.name);
    }
  });
});

describe('issue 103, item 7: the paid QR-only order (not a fixture problem, kept as the contract allows)', () => {
  // SPEC 2.9: MESSAGE_CHANNEL=qr_only is a setting of the business, not a choice of the caller. A caller
  // who gave consent still has a recipient; the message step is SKIPPED and no dispatch row exists.
  // "qr_only and no recipient" is the separate case of a caller who declined (orderQrOnly). So the pair
  // "recipient + qr_only" is valid data, and a screen must read messageChannel before it says where a
  // link goes. See the pull request for the web-side pointer.
  it('recipient with consent, channel qr_only, message step SKIPPED, no dispatch, checkout without a message', () => {
    expect(F.orderPaid.contact).toMatchObject({ messageConsent: true, messageRecipient: '+15555550124' });
    expect(F.approvalOrderPaid.payload).toMatchObject({ messageChannel: 'qr_only', messageRecipient: '+15555550124' });
    const step = F.executions.find((e) => e.approvalId === F.approvalOrderPaid.id && e.actionType === 'message.checkout.send');
    expect(step).toMatchObject({ status: 'SKIPPED', attempts: 0 });
    expect(F.messageDispatches.some((d) => d.subjectId === F.orderPaid.id)).toBe(false);
    expect(F.checkoutQrOnly.message).toBeUndefined();
  });

  it('every qr_only approval has a SKIPPED message step or none yet, and never a dispatch', () => {
    for (const a of F.approvals) {
      if (a.bundleType !== 'order_bundle' && a.bundleType !== 'booking_bundle') continue;
      if (a.payload.messageChannel !== 'qr_only') continue;
      const steps = F.executions.filter((e) => e.approvalId === a.id && (e.actionType === 'message.checkout.send' || e.actionType === 'message.booking.confirm'));
      for (const s of steps) expect(s.status, s.id).toBe('SKIPPED');
      expect(F.messageDispatches.some((d) => d.subjectId === a.subjectId), a.id).toBe(false);
    }
  });

  it('a payload without a recipient is always qr_only, and its order has no consent', () => {
    for (const a of F.approvals) {
      if (a.bundleType !== 'order_bundle' || a.payload.messageRecipient !== undefined) continue;
      expect(a.payload.messageChannel, a.id).toBe('qr_only');
      expect(F.orders.find((o) => o.id === a.subjectId)?.contact.messageConsent, a.id).toBe(false);
    }
  });
});

describe('issue 103, item 8: a sync job does not say Sheets is disconnected while the health card says connected', () => {
  it('the retrying job names a reason that fits the default integration health', () => {
    expect(F.integrationHealth.google_sheets.state).toBe('connected');
    for (const job of F.syncJobs) {
      if (job.target !== 'google_sheets') continue;
      expect(job.lastError ?? '', job.id).not.toMatch(/disconnected/i);
    }
  });

  it('the disconnected variant is still there for the screen that shows it', () => {
    expect(F.integrationHealthDisconnected.google_sheets.state).toBe('disconnected');
  });
});

describe('issue 103, item 9: the approved fact edit (not fixed here: it needs a new payload hash)', () => {
  // apv_demo_f88a is APPROVED for the same subject, key and values as the pending apv_demo_f01, the fact
  // is still a draft and there is no fact.changed. A consistent approved edit needs its own subject, so
  // its payload and payloadHash would change, and this pull request keeps every stored hash. The test
  // below is the reproduction; it is marked as an expected failure until that change is agreed.
  it.fails('an APPROVED fact edit has a verified subject, a fact.changed event and no PENDING twin', () => {
    const a = F.approvalFactEditApproved;
    const subject = F.allFacts.find((f) => f.id === a.subjectId);
    expect(subject?.status).toBe('verified');
    expect(F.allActivityEvents.some((e) => e.type === 'fact.changed' && e.payload.kind === a.payload.kind && e.payload.key === a.payload.key)).toBe(true);
    expect(F.pendingApprovals.some((p) => p.subjectId === a.subjectId)).toBe(false);
  });
});

describe('issue 103, item 10: a file lists every draft and every conflict that came from it', () => {
  it('draftFactIds and conflictIds match the facts and conflicts that name the file', () => {
    for (const file of F.files) {
      const drafts = F.allFacts.filter((f) => f.fileId === file.id).map((f) => f.id);
      const conflicts = F.factConflicts.filter((c) => c.candidates.some((x) => x.factId !== undefined && drafts.includes(x.factId))).map((c) => c.id);
      expect([...(file.draftFactIds ?? [])].sort(), file.id).toEqual([...drafts].sort());
      expect([...(file.conflictIds ?? [])].sort(), file.id).toEqual([...conflicts].sort());
    }
    expect(F.menuFile.draftFactIds).toContain(F.pickupWindowDraftFact.id);
    expect(F.menuFile.conflictIds).toContain(F.pickupWindowConflict.id);
  });

  it('the extraction.completed event counts the same drafts and conflicts', () => {
    for (const e of F.allActivityEvents) {
      if (e.type !== 'extraction.completed') continue;
      const file = F.files.find((f) => f.id === e.payload.fileId);
      expect(e.payload.draftFactCount, e.id).toBe(file?.draftFactIds?.length);
      expect(e.payload.conflictCount, e.id).toBe(file?.conflictIds?.length);
    }
  });
});

describe('issue 103, item 11: integration detail lines are written one way', () => {
  it('no detail ends with a period', () => {
    for (const health of [F.integrationHealth, F.integrationHealthDisconnected]) {
      for (const [name, entry] of Object.entries(health)) {
        const detail = (entry as { detail?: string }).detail;
        if (detail !== undefined) expect(detail, name).not.toMatch(/\.$/);
      }
    }
  });
});

describe('issue 103, item 12: a Sheets sync is queued when the payment is verified, not before', () => {
  it('the sync job of a paid order is created at or after the time the payment was verified', async () => {
    for (const [label, W] of await worlds()) {
      for (const job of W.syncJobs) {
        const order = W.orders.find((o) => o.id === job.recordId);
        expect(order?.status, job.id).toBe('PAID_VERIFIED');
        // A PAID_VERIFIED order was last written when its payment was verified.
        expect(ms(job.createdAt), `${label} ${job.id}`).toBeGreaterThanOrEqual(ms(order?.updatedAt ?? ''));
        expect(ms(job.updatedAt), `${label} ${job.id}`).toBeGreaterThanOrEqual(ms(job.createdAt));
        if (job.nextRetryAt !== undefined) expect(ms(job.nextRetryAt), `${label} ${job.id}`).toBeGreaterThan(ms(job.updatedAt));
      }
    }
  });
});

describe('issue 103, item 13: time left on pending approvals (by contract, not a fixture problem)', () => {
  // Created 20:24Z to 20:29Z against a clock of 20:30Z, so 4 to 9 minutes are left. Giving them longer would
  // mean moving createdAt, and with it expiresAt, which is hashed in every pending payload.
  it('after materializing, every pending approval expires 10 minutes after it was created and has 4 to 9 minutes left', async () => {
    for (const [label, W, now] of await worlds()) {
      expect(W.pendingApprovals.length, label).toBe(5);
      for (const a of W.pendingApprovals) {
        expect(ms(a.expiresAt) - ms(a.createdAt), `${label} ${a.id}`).toBe(APPROVAL_EXPIRY_MS);
        expect(ms(a.expiresAt) - now, `${label} ${a.id}`).toBeGreaterThanOrEqual(4 * 60_000);
        expect(ms(a.expiresAt) - now, `${label} ${a.id}`).toBeLessThanOrEqual(9 * 60_000);
        expect(ms(a.createdAt), `${label} ${a.id}`).toBeLessThanOrEqual(now);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Invariants

describe('issue 103 invariants: additive only', () => {
  const allIds = (): Set<string> => {
    const out = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.id === 'string') out.add(o.id);
        Object.values(o).forEach(walk);
      }
    };
    for (const v of Object.values(F)) if (typeof v !== 'function') walk(v);
    return out;
  };

  it('every ID that was in the fixtures is still there', () => {
    const now = allIds();
    expect(BASELINE_ALL_IDS.filter((id) => !now.has(id))).toEqual([]);
  });

  it('every list still holds the IDs it held, except the one event item 4 takes out of the history', () => {
    const lists = F as unknown as Record<string, { id: string }[]>;
    for (const [name, before] of Object.entries(BASELINE_LIST_IDS)) {
      const now = new Set((lists[name] ?? []).map((x) => x.id));
      const gone = before.filter((id) => !now.has(id));
      expect(gone, name).toEqual(name === 'allActivityEvents' ? ['evt_conflict_resolved_88'] : []);
    }
  });

  it('every stored hash and idempotency key is unchanged; new ones are only added', () => {
    for (const [key, value] of Object.entries(BASELINE_HASHES)) expect(GENERATED_HASHES[key], key).toBe(value);
  });

  it('the stored hashes are still the real ones for the unshifted approvals', async () => {
    for (const a of F.approvals) {
      expect(a.payloadHash, a.id).toBe(BASELINE_HASHES[`payload:${a.id}`] ?? a.payloadHash);
      expect(a.payloadHash, a.id).toBe(await hashCanonical(a.payload));
    }
  });
});

function reachable(name: keyof typeof STATE_MACHINES, state: string): boolean {
  const machine = STATE_MACHINES[name];
  const seen = new Set<string>(machine.initial);
  for (let i = 0; i < machine.states.length; i++) {
    for (const t of machine.transitions) if (seen.has(t.from)) seen.add(t.to);
  }
  return seen.has(state);
}

function localParts(iso: string, timeZone: string): { day: HoursKey; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return { day: (p.weekday ?? '').toLowerCase() as HoursKey, time: `${p.hour}:${p.minute}` };
}

/** Fails unless [start, end] lies inside the opening hours of the local day of `start`. */
function expectInsideHours(start: string, end: string, hours: Record<HoursKey, HoursValue>, timeZone: string, label: string): void {
  const a = localParts(start, timeZone);
  const b = localParts(end, timeZone);
  const window = hours[a.day];
  if ('closed' in window) throw new Error(`${label}: ${start} is on ${a.day}, a closed day`);
  expect(b.day, label).toBe(a.day);
  expect(a.time >= window.open, `${label}: starts ${a.time}, opens ${window.open}`).toBe(true);
  expect(b.time <= window.close, `${label}: ends ${b.time}, closes ${window.close}`).toBe(true);
}

describe('issue 103 invariants: the stored world and every materialized world', () => {
  it.each([['the stored snapshot', F.FIXTURE_NOW] as const, ...CLOCKS])('%s', async (label, iso) => {
    const stored = label === 'the stored snapshot';
    const now = ms(iso);
    const W = stored ? (F as unknown as FixtureWorld) : await materializeFixtures(new Date(iso));

    // Every record validates against its schema.
    const check = (schema: { safeParse: (v: unknown) => { success: boolean } }, rows: readonly unknown[], name: string) =>
      rows.forEach((row, i) => expect(schema.safeParse(row).success, `${name}[${i}] ${(row as { id?: string }).id ?? ''}`).toBe(true));
    check(BusinessFactSchema, W.allFacts, 'facts');
    check(FactConflictSchema, [...W.factConflicts, W.menuPriceConflictResolved], 'conflicts');
    check(FileRecordSchema, W.files, 'files');
    check(AgentSchema, W.agents, 'agents');
    check(AgentVersionSchema, W.agentVersions, 'versions');
    check(CallSchema, W.calls, 'calls');
    check(OrderSchema, [...W.orders, W.orderCancelled], 'orders');
    check(BookingSchema, W.bookings, 'bookings');
    check(ApprovalRequestSchema, W.approvals, 'approvals');
    check(ActionExecutionSchema, W.executions, 'executions');
    check(MessageDispatchSchema, W.messageDispatches, 'dispatches');
    check(SyncJobSchema, W.syncJobs, 'sync jobs');
    check(ActivityEventSchema, [...W.allActivityEvents, W.factConflictResolvedEvent], 'activity');
    check(IntegrationHealthSchema, [W.integrationHealth, W.integrationHealthDisconnected], 'health');

    // Every approval's payloadHash is the real hash of its payload.
    for (const a of [...W.approvals, ...W.pendingApprovals, ...W.fixtureResponses.listApprovals.items]) {
      expect(a.payloadHash, a.id).toBe(await hashCanonical(a.payload));
      expect(a.payloadHash, a.id).toBe(await approvalPayloadHash(a.bundleType, a.payload));
      expect(ms(a.expiresAt) - ms(a.createdAt), a.id).toBe(APPROVAL_EXPIRY_MS);
    }

    // Every state is reachable under its state machine.
    for (const a of W.approvals) expect(reachable('approval', a.state), `approval ${a.id} ${a.state}`).toBe(true);
    for (const o of W.orders) expect(reachable('order', o.status), `order ${o.id} ${o.status}`).toBe(true);
    for (const b of W.bookings) expect(reachable('booking', b.status), `booking ${b.id} ${b.status}`).toBe(true);
    for (const a of W.agents) expect(reachable('agent', a.state), `agent ${a.id} ${a.state}`).toBe(true);
    for (const e of W.executions) expect(reachable('execution', e.status), `execution ${e.id} ${e.status}`).toBe(true);
    for (const d of W.messageDispatches) expect(reachable('messageDispatch', d.status), `dispatch ${d.id} ${d.status}`).toBe(true);
    for (const j of W.syncJobs) expect(reachable('syncJob', j.state), `sync job ${j.id} ${j.state}`).toBe(true);
    for (const f of W.allFacts) expect(reachable('fact', f.status), `fact ${f.id} ${f.status}`).toBe(true);
    // An execution exists only for an approved bundle; a decided approval was decided before it expired.
    for (const e of W.executions) expect(W.approvals.find((a) => a.id === e.approvalId)?.state, e.id).toBe('APPROVED');
    for (const a of W.approvals) {
      if (a.state === 'APPROVED' || a.state === 'REJECTED') expect(ms(a.decidedAt ?? ''), a.id).toBeLessThan(ms(a.expiresAt));
    }

    // Wall-clock items stay inside the opening hours of their business.
    const tz = W.barberBusiness.timezone;
    for (const b of W.bookings) expectInsideHours(b.startUtc, b.endUtc, W.barberHours, b.timezone, b.id);
    for (const block of W.barberBusyBlocks) expectInsideHours(block.startUtc, block.endUtc, W.barberHours, tz, block.label);
    for (const slot of W.slotConflictAlternatives) expectInsideHours(slot.startUtc, slot.endUtc, W.barberHours, tz, 'alternative');
    for (const o of [...W.orders, W.orderCancelled]) expectInsideHours(o.fulfillment.pickupAt, o.fulfillment.pickupAt, W.pizzaHours, W.pizzaBusiness.timezone, o.id);
    for (const a of W.approvals) {
      if (a.bundleType === 'booking_bundle') expectInsideHours(a.payload.startUtc, a.payload.endUtc, W.barberHours, a.payload.timezone, a.id);
      if (a.bundleType === 'order_bundle') expectInsideHours(a.payload.pickupAt, a.payload.pickupAt, W.pizzaHours, W.pizzaBusiness.timezone, a.id);
    }
    // Events carry the same slot as the booking they are about.
    for (const e of W.allActivityEvents) {
      if (e.type === 'booking.verified' || e.type === 'booking.slot_conflict') expect(e.payload.startUtc, e.id).toBe(W.bookings.find((b) => b.id === e.payload.bookingId)?.startUtc);
      if (e.type === 'proposal.created' && e.payload.subjectType === 'booking') expect(e.payload.startUtc, e.id).toBe(W.bookings.find((b) => b.id === e.payload.subjectId)?.startUtc);
    }

    // Pending approvals are unexpired, and what they wait for is still ahead.
    expect(W.pendingApprovals.map((a) => a.id).sort()).toEqual(F.pendingApprovals.map((a) => a.id).sort());
    for (const a of W.pendingApprovals) {
      expect(a.state, a.id).toBe('PENDING');
      expect(ms(a.expiresAt), a.id).toBeGreaterThan(now);
      if (a.bundleType === 'order_bundle') expect(ms(a.payload.pickupAt), a.id).toBeGreaterThan(now);
      if (a.bundleType === 'booking_bundle') expect(ms(a.payload.startUtc), a.id).toBeGreaterThan(now + 120 * 60_000); // the barbershop's two hours of notice
    }

    // IDs are the stored ones: materializing moves times, never identity.
    for (const name of Object.keys(BASELINE_LIST_IDS)) {
      const lists = W as unknown as Record<string, { id: string }[]>;
      const source = F as unknown as Record<string, { id: string }[]>;
      expect(lists[name]?.map((x) => x.id), name).toEqual(source[name]?.map((x) => x.id));
    }
  });
});

describe('issue 103 invariants: lists the database seed reads (packages/db/src/seed/world.ts)', () => {
  // The seed stores pizzaVerifiedFacts and barberFacts as the verified facts of each business, with no
  // files row, and copies each agent version's knowledgeSnapshotRef. A draft, an upload or a new fact in
  // these lists would be seeded as verified knowledge and would change published, immutable versions.
  it('pizzaVerifiedFacts and barberFacts hold exactly the facts they held: verified, version 1, no file, no draft', () => {
    const seeded = [...F.pizzaVerifiedFacts, ...F.barberFacts];
    const before = BASELINE_LIST_IDS.allFacts!.filter((id) => !['fact_pizza_menu_marg_lg_d1', 'fact_pizza_hours_fri_d2', 'fact_pizza_draft_pickup', 'fact_barber_draft_kids'].includes(id));
    expect(seeded.map((f) => f.id)).toEqual(before);
    const keys = new Set<string>();
    for (const f of seeded) {
      expect(BusinessFactSchema.safeParse(f).success, f.id).toBe(true);
      expect(f.status, f.id).toBe('verified');
      expect(f.verifiedAt, f.id).toBeDefined();
      expect(f.version, f.id).toBe(1);
      expect(f.fileId, f.id).toBeUndefined();
      expect(f.supersedesId, f.id).toBeUndefined();
      expect(f.sourceType, f.id).not.toBe('upload');
      expect(f.kind, f.id).not.toBe('menu_item');
      const k = `${f.businessId}:${f.kind}:${f.key}`;
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
    }
    expect(F.pizzaVerifiedFacts.every((f) => f.businessId === F.pizzaBusiness.id)).toBe(true);
    expect(F.barberFacts.every((f) => f.businessId === F.barberBusiness.id)).toBe(true);
  });

  it('the seeded agent versions reference only seeded facts, and each seeded agent is live on a seeded version', () => {
    const seededFactIds = new Set([...F.pizzaVerifiedFacts, ...F.barberFacts].map((f) => f.id));
    for (const v of [F.pizzaVersionV1, F.pizzaVersionV2, F.barberVersionV1]) {
      expect(v.knowledgeSnapshotRef.facts.length, v.id).toBeGreaterThan(0);
      for (const ref of v.knowledgeSnapshotRef.facts) expect(seededFactIds.has(ref.id), `${v.id} ${ref.id}`).toBe(true);
    }
    expect([F.pizzaAgent.state, F.pizzaAgent.activeVersionId, F.pizzaAgent.name]).toEqual(['live', F.pizzaVersionV2.id, 'Pizza Order Assistant']);
    expect([F.barberAgent.state, F.barberAgent.activeVersionId, F.barberAgent.name]).toEqual(['live', F.barberVersionV1.id, 'Booking Assistant']);
  });

  it('the optional demo conflict is one draft menu_item fact and one open required conflict that points at it', () => {
    expect(F.menuItemDraftFact).toMatchObject({ id: 'fact_pizza_menu_marg_lg_d1', kind: 'menu_item', status: 'draft', version: 1 });
    expect(F.menuItemDraftFact).not.toHaveProperty('verifiedAt');
    expect(F.menuPriceConflict).toMatchObject({ id: 'cfl_pizza_01', kind: 'menu_item', key: F.menuItemDraftFact.key, state: 'open', required: true });
    expect(F.menuPriceConflict).not.toHaveProperty('resolvedAt');
    expect(F.menuPriceConflict.candidates.map((c) => c.factId)).toEqual([F.menuItemDraftFact.id, undefined]);
  });
});
