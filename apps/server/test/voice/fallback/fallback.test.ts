import { describe, expect, it, vi } from 'vitest';
import { CallEndedEventSchema, type BusinessFact } from '@abos/contracts';
import {
  buildFallbackTwiml, createFallbackRouter, decideFallback,
  FALLBACK_DIAL_TIMEOUT_SECONDS, GUARDRAIL_REFUSAL_THRESHOLD, TOOL_FAILURE_THRESHOLD,
  type CallUpdateInstruction, type FallbackPorts, type FallbackRequest, type FallbackReservation,
} from '../../../src/voice/fallback';

const businessId = 'biz_pizza_01';
const callId = 'call_fallback';
const providerCallId = 'CA_test';
const number = '+18055550101';
const callerId = { number: '+18055550100', accountOwned: true };
const fact: BusinessFact = {
  id: 'fact_fallback', businessId, kind: 'contact', key: 'fallback_phone_number', value: number,
  sourceType: 'owner_ui', status: 'verified', confidence: 1, version: 1,
  verifiedAt: '2026-11-14T00:00:00Z', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z',
};
const request: FallbackRequest = {
  businessId, callId, providerCallId, businessName: 'Caller supplied name', mode: 'webhook',
  signals: { callerRequestedPerson: true },
};

type CallRow = { businessId: string; callId: string; status: 'IN_PROGRESS' | 'COMPLETED'; enabled: boolean; fact: BusinessFact | null };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A stateful fake of the two checked database routines. It accepts no provider client. */
function setup(overrides: Partial<FallbackPorts> = {}) {
  const calls = new Map<string, CallRow>([[providerCallId, { businessId, callId, status: 'IN_PROGRESS', enabled: true, fact }]]);
  const reservations = new Map<string, FallbackReservation>();
  const dispatches = new Set<string>();
  const ended = new Set<string>();
  const updates: CallUpdateInstruction[] = [];
  const ports: FallbackPorts = {
    callerId: { readOwnedNumber: vi.fn(async (_businessId, signal) => signal.aborted ? null : callerId) },
    fallback: {
      reserve: vi.fn(async (input, signal) => {
        if (signal.aborted) return null;
        const row = calls.get(input.providerCallId);
        if (row === undefined || row.businessId !== input.businessId || row.callId !== input.callId || row.status !== 'IN_PROGRESS' || !row.enabled || row.fact === null) return null;
        const existing = reservations.get(input.providerCallId);
        if (existing !== undefined) return existing.callId === input.callId ? existing : null;
        const reserved: FallbackReservation = {
          businessId: row.businessId, callId: row.callId, providerCallId: input.providerCallId, businessName: 'Trusted Pizza',
          callStatus: 'IN_PROGRESS', channel: 'phone', humanFallbackEnabled: true, fallbackFact: row.fact,
          idempotencyKey: `fallback-${input.providerCallId}`,
        };
        reservations.set(input.providerCallId, reserved);
        return reserved;
      }),
      beginDispatch: vi.fn(async (instruction, signal) => {
        if (signal.aborted || dispatches.has(instruction.providerCallId)) return false;
        const row = calls.get(instruction.providerCallId);
        if (row?.status !== 'IN_PROGRESS' || reservations.get(instruction.providerCallId)?.idempotencyKey !== instruction.idempotencyKey) return false;
        dispatches.add(instruction.providerCallId);
        return true;
      }),
    },
    calls: { update: vi.fn(async (instruction, signal) => { if (!signal.aborted) updates.push(instruction); }) },
    outcomes: {
      record: vi.fn(async (outcome) => {
        const row = calls.get(outcome.providerCallId);
        if (row === undefined || row.businessId !== outcome.businessId || row.callId !== outcome.callId) throw new Error('bound call mismatch');
        if (ended.has(outcome.providerCallId)) return;
        ended.add(outcome.providerCallId);
        row.status = 'COMPLETED';
      }),
    },
  };
  const combined = { ...ports, ...overrides } as FallbackPorts;
  return { ports: combined, calls, reservations, dispatches, ended, updates, router: createFallbackRouter(combined) };
}

describe('decideFallback', () => {
  it('continues without trusted fallback signals', () => expect(decideFallback({})).toEqual({ handoff: false }));
  it.each([
    [{ callerRequestedPerson: true }, 'caller_requested_person'],
    [{ guardrailRefusals: GUARDRAIL_REFUSAL_THRESHOLD }, 'repeated_guardrail_refusals'],
    [{ toolFailures: TOOL_FAILURE_THRESHOLD }, 'repeated_tool_failures'],
    [{ modelSessionFailed: true, modelSessionReady: false }, 'model_session_failed'],
    [{ liveAgentMissing: true }, 'live_agent_unavailable'],
    [{ liveAgentUnpublished: true }, 'live_agent_unavailable'],
    [{ phoneLineOverloaded: true }, 'phone_line_overloaded'],
  ] as const)('returns %s for a trusted trigger', (input, reason) => {
    expect(decideFallback(input)).toEqual({ handoff: true, reason });
  });
  it.each([0, GUARDRAIL_REFUSAL_THRESHOLD - 1])('does not hand off below the guardrail threshold: %i', (count) => {
    expect(decideFallback({ guardrailRefusals: count })).toEqual({ handoff: false });
  });
  it.each([0, TOOL_FAILURE_THRESHOLD - 1])('does not hand off below the tool failure threshold: %i', (count) => {
    expect(decideFallback({ toolFailures: count })).toEqual({ handoff: false });
  });
  it('hands off when a trusted failure count is above either threshold', () => {
    expect(decideFallback({ guardrailRefusals: GUARDRAIL_REFUSAL_THRESHOLD + 1 }).handoff).toBe(true);
    expect(decideFallback({ toolFailures: TOOL_FAILURE_THRESHOLD + 1 }).handoff).toBe(true);
  });
  it('does not treat a model error after readiness as a setup fallback', () => {
    expect(decideFallback({ modelSessionFailed: true, modelSessionReady: true })).toEqual({ handoff: false });
  });
  it('does not coerce caller text into a trusted handoff signal', () => {
    expect(decideFallback(JSON.parse('{"callerText":"transfer me","callerRequestedPerson":"true"}') as Record<string, never>)).toEqual({ handoff: false });
  });
});

describe('buildFallbackTwiml', () => {
  it('speaks before dialing with an owned caller ID and a bounded timeout', () => {
    const xml = buildFallbackTwiml({ reason: 'caller_requested_person', fallbackNumber: number, businessName: 'Pizza', callerId });
    expect(xml.indexOf('<Say>')).toBeLessThan(xml.indexOf('<Dial'));
    expect(xml).toContain(`timeout="${FALLBACK_DIAL_TIMEOUT_SECONDS}"`);
    expect(xml).toContain(`callerId="${callerId.number}"`);
    expect(xml).toContain(`<Number>${number}</Number>`);
    expect(xml).toContain('<Hangup');
  });
  it('escapes markup and strips XML-invalid control characters from the business name', () => {
    const xml = buildFallbackTwiml({ reason: 'model_session_failed', businessName: `A\u0000 & B <shop> "yes" 'hi'`, fallbackNumber: number, callerId });
    expect(xml).toContain('A &amp; B &lt;shop&gt; &quot;yes&quot; &apos;hi&apos;');
    expect(xml).not.toContain('<shop>');
    expect(xml).not.toContain('\u0000');
  });
  it.each([undefined, '', '8055550101', '+08055550101', '+1234567890123456', '+1805</Number>'])('hangs up for invalid destination %s', (fallbackNumber) => {
    expect(buildFallbackTwiml({ reason: 'live_agent_unavailable', businessName: 'Pizza', fallbackNumber, callerId })).not.toContain('<Dial');
  });
  it.each([undefined, { number: '+18055550100', accountOwned: false }, { number: 'bad', accountOwned: true }])('requires an owned valid caller ID: %j', (owned) => {
    expect(buildFallbackTwiml({ reason: 'model_session_failed', businessName: 'Pizza', fallbackNumber: number, callerId: owned })).not.toContain('<Dial');
  });
});

describe('createFallbackRouter', () => {
  it('does not call any port when the agent can continue', async () => {
    const { router, ports } = setup();
    expect(await router.route({ ...request, signals: {} })).toEqual({ kind: 'continue' });
    expect(ports.callerId.readOwnedNumber).not.toHaveBeenCalled();
    expect(ports.fallback.reserve).not.toHaveBeenCalled();
    expect(ports.fallback.beginDispatch).not.toHaveBeenCalled();
    expect(ports.calls.update).not.toHaveBeenCalled();
    expect(ports.outcomes.record).not.toHaveBeenCalled();
  });
  it('uses only the trusted reservation name and sends stream update once', async () => {
    const { router, updates } = setup();
    const result = await router.route({ ...request, mode: 'stream', businessName: 'Injected <name>' });
    expect(result.kind).toBe('redirect');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.twiml).toContain('Trusted Pizza');
    expect(updates[0]?.twiml).not.toContain('Injected');
  });
  it('returns webhook TwiML after the dispatch fence without a stream update or terminal event', async () => {
    const { router, ports } = setup();
    const result = await router.route(request);
    expect(result.kind).toBe('webhook');
    if (result.kind === 'webhook') expect(result.twiml).toContain(`<Number>${number}</Number>`);
    expect(ports.fallback.beginDispatch).toHaveBeenCalledOnce();
    expect(ports.calls.update).not.toHaveBeenCalled();
    expect(ports.outcomes.record).not.toHaveBeenCalled();
  });
  it('uses the apology and hangup branch when the owned caller ID is unavailable', async () => {
    const base = setup();
    vi.mocked(base.ports.callerId.readOwnedNumber).mockResolvedValue(null);
    const result = await base.router.route(request);
    expect(result.kind).toBe('webhook');
    if (result.kind === 'webhook') {
      expect(result.twiml).not.toContain('<Dial');
      expect(result.twiml).toContain('<Hangup');
    }
  });
  it.each([
    ['terminal call', (row: CallRow) => { row.status = 'COMPLETED'; }],
    ['disabled published version', (row: CallRow) => { row.enabled = false; }],
    ['missing verified fallback fact', (row: CallRow) => { row.fact = null; }],
  ] as const)('fails closed without dispatch for a %s', async (_name, mutate) => {
    const { router, calls, ports } = setup();
    const row = calls.get(providerCallId);
    if (row === undefined) throw new Error('missing fake call');
    mutate(row);
    expect(await router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'blocked' });
    expect(ports.fallback.beginDispatch).not.toHaveBeenCalled();
    expect(ports.calls.update).not.toHaveBeenCalled();
  });
  it('does not reserve a second operation for one provider call with a different local call ID', async () => {
    const { router, updates } = setup();
    await router.route({ ...request, mode: 'stream' });
    expect(await router.route({ ...request, callId: 'call_other', mode: 'stream' })).toEqual({ kind: 'blocked' });
    expect(updates).toHaveLength(1);
  });
  it('does not dispatch when terminal handling wins while caller configuration is pending', async () => {
    const caller = deferred<typeof callerId | null>();
    const base = setup();
    vi.mocked(base.ports.callerId.readOwnedNumber).mockReturnValue(caller.promise);
    const route = base.router.route({ ...request, mode: 'stream' });
    await Promise.resolve();
    await base.router.complete({ businessId, callId, providerCallId, reason: 'completed', durationSec: 1, occurredAt: '2026-11-14T01:00:00Z' });
    caller.resolve(callerId);
    expect(await route).toEqual({ kind: 'blocked' });
    expect(base.updates).toHaveLength(0);
  });
  it('does not dispatch when terminal handling wins after reservation but before the dispatch fence', async () => {
    const base = setup();
    const gate = deferred<boolean>();
    vi.mocked(base.ports.fallback.beginDispatch).mockReturnValue(gate.promise);
    const route = base.router.route({ ...request, mode: 'stream' });
    await Promise.resolve();
    await Promise.resolve();
    await base.router.complete({ businessId, callId, providerCallId, reason: 'completed', durationSec: 1, occurredAt: '2026-11-14T01:00:00Z' });
    gate.resolve(false);
    expect(await route).toEqual({ kind: 'blocked' });
    expect(base.updates).toHaveLength(0);
  });
  it('fails closed when a returned reservation does not bind the requested call', async () => {
    const base = setup();
    vi.mocked(base.ports.fallback.reserve).mockResolvedValue({
      businessId, callId: 'call_other', providerCallId, businessName: 'Trusted Pizza', callStatus: 'IN_PROGRESS',
      channel: 'phone', humanFallbackEnabled: true, fallbackFact: fact, idempotencyKey: 'stable',
    });
    expect(await base.router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'blocked' });
    expect(base.ports.fallback.beginDispatch).not.toHaveBeenCalled();
    expect(base.updates).toHaveLength(0);
  });
  it.each([
    { ...fact, status: 'draft', verifiedAt: undefined },
    { ...fact, value: 'not-a-number' },
    { ...fact, businessId: 'biz_other' },
    { ...fact, key: 'other_contact' },
  ])('fails closed when a reservation returns an invalid fallback fact', async (fallbackFact) => {
    const base = setup();
    vi.mocked(base.ports.fallback.reserve).mockResolvedValue({
      businessId, callId, providerCallId, businessName: 'Trusted Pizza', callStatus: 'IN_PROGRESS', channel: 'phone',
      humanFallbackEnabled: true, fallbackFact: fallbackFact as unknown as BusinessFact, idempotencyKey: 'stable',
    });
    expect(await base.router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'blocked' });
    expect(base.ports.fallback.beginDispatch).not.toHaveBeenCalled();
    expect(base.updates).toHaveLength(0);
  });
  it('suppresses provider error text and does not repeat an ambiguous update', async () => {
    const base = setup();
    vi.mocked(base.ports.calls.update).mockRejectedValueOnce(new Error(`secret ${number}`));
    expect(await base.router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'redirect_unknown', reason: 'caller_requested_person' });
    expect(await base.router.route({ ...request, mode: 'stream' })).toEqual({ kind: 'blocked' });
    expect(base.updates).toHaveLength(0);
  });
  it('records concurrent terminal completions once in the process and delegates a later replay to the durable routine', async () => {
    const base = setup();
    const gate = deferred<void>();
    vi.mocked(base.ports.outcomes.record).mockReturnValue(gate.promise);
    const ended = { businessId, callId, providerCallId, reason: 'completed' as const, durationSec: 1, occurredAt: '2026-11-14T01:00:00Z' };
    const first = base.router.complete(ended);
    const concurrent = base.router.complete(ended);
    await vi.waitFor(() => expect(base.ports.outcomes.record).toHaveBeenCalledOnce());
    gate.resolve();
    await Promise.all([first, concurrent]);
    await base.router.complete(ended);
    expect(base.ports.outcomes.record).toHaveBeenCalledTimes(2);
    const outcome = vi.mocked(base.ports.outcomes.record).mock.calls[0]?.[0];
    expect(CallEndedEventSchema.safeParse(outcome?.event).success).toBe(true);
  });
  it.each([
    ['failed', 'FAILED'],
    ['dropped', 'DROPPED'],
  ] as const)('maps a confirmed %s outcome to %s', async (reason, status) => {
    const base = setup();
    await base.router.complete({ businessId, callId, providerCallId, reason, durationSec: 1, occurredAt: '2026-11-14T01:00:00Z' });
    expect(vi.mocked(base.ports.outcomes.record).mock.calls[0]?.[0].status).toBe(status);
  });
  it('rejects invalid terminal data before calling the durable outcome routine', async () => {
    const base = setup();
    await expect(base.router.complete({ businessId, callId, providerCallId, reason: 'failed', durationSec: -1, occurredAt: 'not a date' })).rejects.toThrow();
    expect(base.ports.outcomes.record).not.toHaveBeenCalled();
  });
});
